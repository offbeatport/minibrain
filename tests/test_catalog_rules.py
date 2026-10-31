import importlib.util
import re
from pathlib import Path
from types import ModuleType

from minibrain.models.catalog import bundled

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "build_catalog.py"


def rules() -> ModuleType:
    spec = importlib.util.spec_from_file_location("build_catalog", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_bundled_catalogue_follows_the_rules() -> None:
    build = rules()
    entries = bundled()["entries"]
    ids = {entry["id"] for entry in entries}
    assert 35 <= len(entries) <= 70
    for entry in entries:
        assert entry["repo"].split("/", 1)[0] in build.PUBLISHERS
        assert entry["license"] in build.LICENCES
        assert entry["architecture"] in build.SUPPORTED_ARCHITECTURES
        assert entry["tier"] in {"S", "M", "L", "XL"}
        assert entry["superseded_by"] is None or entry["superseded_by"] in ids
        assert entry["support"] in {"tested", "supported"}
        for variant in entry["variants"]:
            assert re.fullmatch(r"[0-9a-f]{40}", variant["revision"])
            assert variant["files"] and all(item["size"] > 0 for item in variant["files"])
            assert not any(item["path"].startswith("consolidated") for item in variant["files"])
            assert variant["weights_bytes"] > 0


def test_tiers_match_sizes_and_generations_are_kept() -> None:
    entries = {entry["id"]: entry for entry in bundled()["entries"]}
    assert entries["qwen3-0.6b"]["tier"] == "S"
    assert entries["qwen3-8b"]["tier"] == "M"
    assert entries["qwen3-30b-a3b"]["tier"] == "L"
    assert entries["gpt-oss-120b"]["tier"] == "XL"
    assert entries["gpt-oss-120b"]["variants"][0]["requires"]["gpus"] == "multi"
    assert entries["qwen2.5-7b-instruct"]["superseded_by"] == "qwen3-8b"
    assert entries["qwen3-0.6b"]["support"] == "tested"
    assert {entries[key]["gated"] for key in ("llama-3.1-8b-instruct", "qwen3-8b")} == {True, False}


def test_publisher_and_licence_rules_reject_outsiders() -> None:
    build = rules()
    assert build.tier(0.6, False, 1.5) == "S"
    assert build.tier(70, False, 140) == "XL"
    assert build.tier(30, True, 60) == "L"
    assert "qwen-research" not in build.LICENCES
    assert "cc-by-nc-4.0" not in build.LICENCES


def test_reseeding_drops_variants_that_left_the_snapshot(harness) -> None:
    from minibrain.models.catalog import upsert
    from minibrain.registry.models import CatalogModel, CatalogVariant

    entry = bundled()["entries"][0]
    with harness.sessions() as session:
        model = session.get(CatalogModel, entry["id"])
        assert model is not None
        extra = dict(entry["variants"][0]) | {"id": f"{entry['id']}:old"}
        model.variants.append(CatalogVariant(**{k: v for k, v in extra.items() if k != "id"}, id=extra["id"]))
        session.commit()
        upsert(session, entry)
        session.commit()
        assert session.get(CatalogVariant, f"{entry['id']}:old") is None
