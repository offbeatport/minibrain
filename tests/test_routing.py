from typing import Any

import httpx
import pytest

from minibrain.base_models import QWEN3_0_6B
from minibrain.gateway.balance import BUSY_AT, DOWN_SECONDS, Balancer, sticky_key
from minibrain.serve.backend import AdapterRef, CompletionRequest, EngineUnavailableError
from minibrain.serve.engines import EngineBackend

A, B, C = "http://a:8200", "http://b:8200", "http://c:8200"


def replicas(*urls: str, state: str = "ready") -> list[dict[str, str]]:
    return [{"url": url, "state": state} for url in urls]


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def test_new_work_goes_to_the_replica_with_fewest_requests_in_flight() -> None:
    balancer = Balancer()
    first = balancer.choose(replicas(A, B, C), "k1")
    second = balancer.choose(replicas(A, B, C), "k2")
    third = balancer.choose(replicas(A, B, C), "k3")
    assert {first, second, third} == {A, B, C}


def test_requests_stick_to_the_replica_holding_their_adapter() -> None:
    balancer = Balancer()
    key = sticky_key("qwen3-0.6b", "support@3", [{"role": "user", "content": "hi"}])
    picks = []
    for _ in range(5):
        url = balancer.choose(replicas(A, B, C), key)
        assert url is not None
        picks.append(url)
        balancer.release(url)
    assert len(set(picks)) == 1
    other = sticky_key("qwen3-0.6b", "billing@1", [{"role": "user", "content": "hi"}])
    assert other != key


def test_shared_prompt_prefixes_share_a_replica() -> None:
    system = {"role": "system", "content": "You are a support bot."}
    first = sticky_key("m", None, [system, {"role": "user", "content": "a"}])
    second = sticky_key("m", None, [system, {"role": "user", "content": "b"}])
    other = sticky_key("m", None, [{"role": "system", "content": "Other"}, {"role": "user", "content": "a"}])
    assert first == second != other


def test_busy_sticky_replica_overflows_and_the_binding_survives() -> None:
    balancer = Balancer()
    home = balancer.choose(replicas(A, B), "adapter")
    assert home is not None
    for _ in range(BUSY_AT - 1):
        assert balancer.choose(replicas(A, B), "adapter") == home
    overflow = balancer.choose(replicas(A, B), "adapter")
    assert overflow is not None and overflow != home
    for _ in range(BUSY_AT):
        balancer.release(home)
    balancer.release(overflow)
    assert balancer.choose(replicas(A, B), "adapter") == home


def test_down_and_loading_replicas_are_avoided_until_they_recover() -> None:
    clock = Clock()
    balancer = Balancer(clock)
    balancer.mark(A, "down")
    assert balancer.choose(replicas(A, B), "k") == B
    assert balancer.choose(replicas(A) + replicas(C, state="loading"), "k2") == C
    clock.now += DOWN_SECONDS + 1
    assert balancer.state({"url": A}) == "ready"
    assert balancer.choose(replicas(A, B), "fresh") == A


class FakeEngines:
    def __init__(self, failing: set[str], loading: set[str] | None = None) -> None:
        self.failing = failing
        self.loading = loading or set()
        self.calls: list[str] = []

    def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        host = url.rsplit("/", 1)[0]
        self.calls.append(f"{method} {url}")
        if host in self.failing:
            raise httpx.ConnectError("refused")
        if host in self.loading:
            return httpx.Response(503, request=httpx.Request(method, url))
        if url.endswith("/health"):
            return httpx.Response(200, json={}, request=httpx.Request(method, url))
        body = {"text": host, "prompt_tokens": 1, "completion_tokens": 1, "stopped": True, "seconds": 0.0}
        return httpx.Response(200, json=body, request=httpx.Request(method, url))

    def stream(self, method: str, url: str, **kwargs: Any) -> Any:
        raise NotImplementedError


def request(adapter: str | None = None) -> CompletionRequest:
    ref = AdapterRef(adapter, {"id": "x"}) if adapter else None
    return CompletionRequest(QWEN3_0_6B, [{"role": "user", "content": "hi"}], ref, 8)


def test_gateway_fails_over_when_a_replica_dies() -> None:
    engines = {"qwen3-0.6b": replicas(A, B)}
    fake = FakeEngines(failing={A})
    backend = EngineBackend(lambda: engines, http=fake)
    backend.balancer.bind(sticky_key("qwen3-0.6b", "s@1", [{"role": "user", "content": "hi"}]), A)
    assert backend.complete(request("s@1")).text == B
    assert backend.balancer.state({"url": A}) == "down"
    assert backend.balancer.sticky[sticky_key("qwen3-0.6b", "s@1", [{"role": "user", "content": "hi"}])] == B
    assert backend.complete(request("s@1")).text == B
    assert fake.calls.count(f"POST {A}/generate") == 1


def test_health_checks_mark_replicas(monkeypatch: pytest.MonkeyPatch) -> None:
    engines = {"qwen3-0.6b": replicas(A, B, C)}
    fake = FakeEngines(failing={A}, loading={B})
    backend = EngineBackend(lambda: engines, http=fake)
    backend.probe = fake
    backend.check_all()
    states = {url: backend.balancer.state({"url": url}) for url in (A, B, C)}
    assert states == {A: "down", B: "loading", C: "ready"}
    assert backend.complete(request()).text == C


def test_no_replicas_is_unavailable() -> None:
    with pytest.raises(EngineUnavailableError):
        EngineBackend(dict, http=FakeEngines(set())).complete(request())
