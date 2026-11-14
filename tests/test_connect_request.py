from datetime import timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import update

from minibrain.registry.models import ApiKey, now
from tests.conftest import Harness
from tests.test_flow import SLUG, add_key
from tests.test_keys import BASE, CUSTOM, two_models

SAMPLE = {"messages": [{"role": "user", "content": "I was charged twice"}], "max_tokens": 64}


def send(harness: Harness, secret: str, model: str = SLUG) -> Any:
    headers = {"Authorization": f"Bearer {secret}", "Content-Type": "application/json"}
    return harness.client.post("/v1/chat/completions", headers=headers, json=SAMPLE | {"model": model})


def shown(response: Any) -> str:
    data = response.json()
    return str((data.get("error") or {}).get("message") or data.get("detail") or "")


def test_a_key_made_for_the_model_answers_the_test_request(harness: Harness, tmp_path: Path) -> None:
    two_models(harness, tmp_path)
    created = add_key(harness, CUSTOM, name="Support Triage · test")
    assert [model["key"] for model in created["models"]] == [SLUG]
    response = send(harness, created["secret"])
    assert response.status_code == 200, response.text
    assert response.json()["choices"][0]["message"]["content"] == harness.backend.output
    assert harness.backend.requests[-1].max_tokens == 64


def test_a_key_for_another_model_is_403_and_names_the_model(harness: Harness, tmp_path: Path) -> None:
    two_models(harness, tmp_path)
    narrow = add_key(harness, BASE, name="base only")
    refused = send(harness, narrow["secret"])
    assert refused.status_code == 403 and shown(refused) == f"this API key does not cover {SLUG}"
    missing = send(harness, narrow["secret"], f"{SLUG}-gone")
    assert missing.status_code == 404 and shown(missing) == f"model {SLUG}-gone not found"


def test_unknown_expired_and_revoked_keys_are_401(harness: Harness, tmp_path: Path) -> None:
    two_models(harness, tmp_path)
    created = add_key(harness, CUSTOM)
    unknown = send(harness, "mb-not-a-key")
    assert unknown.status_code == 401 and shown(unknown) == "invalid API key"
    with harness.sessions() as session:
        session.execute(update(ApiKey).values(expires_at=now() - timedelta(minutes=1)))
        session.commit()
    harness.app.state.gateway_config.rebuild()
    expired = send(harness, created["secret"])
    assert expired.status_code == 401 and shown(expired) == "API key expired"
    assert harness.client.delete(f"/api/keys/{created['id']}").status_code == 204
    revoked = send(harness, created["secret"])
    assert revoked.status_code == 401 and shown(revoked) == "invalid API key"


def test_an_undeployed_model_says_so_and_names_a_version_to_call(harness: Harness, tmp_path: Path) -> None:
    two_models(harness, tmp_path)
    own = add_key(harness, CUSTOM)
    other = add_key(harness, BASE, name="base only")
    assert harness.client.post(f"/api/models/{SLUG}/deploy", json={"deployed": False}).status_code == 202
    harness.app.state.gateway_config.rebuild()
    refused = send(harness, own["secret"])
    assert refused.status_code == 404
    assert shown(refused) == f"{SLUG} is not deployed; deploy it, or call one of its versions such as {SLUG}@0"
    assert send(harness, own["secret"], f"{SLUG}@0").status_code == 200
    hidden = send(harness, other["secret"])
    assert hidden.status_code == 404 and shown(hidden) == f"model {SLUG} not found"
