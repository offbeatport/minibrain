import pytest

from minibrain.serve.host import AdvertiseError, advertise_address, loopback

MAIN = "http://main.corp:8000"


def resolving(*addresses: str):
    return lambda _name: list(addresses)


def routing(source: str | None):
    return lambda _host, _port: source


def test_a_name_that_reaches_the_network_is_kept() -> None:
    found = advertise_address(None, MAIN, "rack", "gpu-01", resolving("10.0.0.12"), routing(None))
    assert found == "gpu-01"


def test_an_explicit_address_wins() -> None:
    assert advertise_address("10.1.1.1", MAIN, "rack", "gpu-01", resolving("127.0.1.1"), routing(None)) == "10.1.1.1"


def test_a_loopback_name_takes_the_address_that_reaches_main() -> None:
    asked: list[tuple[str, int]] = []

    def route(host: str, port: int) -> str:
        asked.append((host, port))
        return "10.0.0.12"

    assert advertise_address(None, MAIN, "rack", "gpu-01", resolving("127.0.1.1"), route) == "10.0.0.12"
    assert asked == [("main.corp", 8000)]
    https = advertise_address(None, "https://main.corp", "rack", "gpu-01", resolving(), route)
    assert https == "10.0.0.12" and asked[-1] == ("main.corp", 443)


def test_no_reachable_address_fails_with_the_fix() -> None:
    with pytest.raises(AdvertiseError) as found:
        advertise_address(None, MAIN, "rack", "gpu-01", resolving("127.0.1.1", "::1"), routing("127.0.0.1"))
    message = str(found.value)
    assert "gpu-01 resolves to 127.0.1.1, ::1" in message
    assert "minibrain worker --pool rack --advertise <address>" in message
    with pytest.raises(AdvertiseError, match="resolves to no address"):
        advertise_address(None, MAIN, "rack", "gpu-01", resolving(), routing(None))


def test_main_on_this_machine_keeps_loopback() -> None:
    local = "http://127.0.0.1:8000"
    assert advertise_address(None, local, "rack", "box", resolving("127.0.1.1"), routing(None)) == "box"
    assert advertise_address(None, local, "rack", "box", resolving(), routing(None)) == "127.0.0.1"


def test_loopback_spots_every_form() -> None:
    assert loopback("127.0.1.1") and loopback("::1") and loopback("localhost")
    assert not loopback("10.0.0.1") and not loopback("gpu-01") and not loopback("fe80::1%en0")
