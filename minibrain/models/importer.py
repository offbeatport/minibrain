import json
from typing import Any

from minibrain.ml.context import FinalError, JobSpec, report, run_child, write_result
from minibrain.models.files import Progress, write_stream
from minibrain.models.sources import StorageSource, location_url

TOKENIZER_FILES = ("tokenizer.json", "tokenizer_config.json")
PICKLE_SUFFIXES = (".bin", ".pt", ".pth", ".pkl", ".ckpt")
SHARD_INDEX = "model.safetensors.index.json"
HF_METADATA = ".cache/huggingface/download/config.json.metadata"


def validate(source: StorageSource, files: list[dict[str, Any]]) -> None:
    names = {entry["path"] for entry in files}
    if "config.json" not in names:
        raise FinalError("No config.json: import a Hugging Face format folder (config, tokenizer, safetensors)")
    architectures = json.loads(source.read_text("config.json")).get("architectures") or []
    if not any(name.endswith("ForCausalLM") for name in architectures):
        raise FinalError(
            f"Only causal language models are supported; this folder has {architectures or 'no architecture'}"
        )
    if not any(name.endswith(".safetensors") for name in names):
        if any(name.endswith(PICKLE_SUFFIXES) for name in source.names()):
            raise FinalError(
                "Only pickle weights found: pickle weights can run code when loaded; use the safetensors version"
            )
        raise FinalError("No .safetensors weights in the folder")
    if SHARD_INDEX in names:
        shards = set(json.loads(source.read_text(SHARD_INDEX)).get("weight_map", {}).values())
        missing = sorted(shards - names)
        if missing:
            raise FinalError(f"Sharded weights are incomplete: missing {', '.join(missing[:3])}")
    if not names.intersection(TOKENIZER_FILES):
        raise FinalError("No tokenizer files (tokenizer.json or tokenizer_config.json) in the folder")


def detected_revision(source: StorageSource) -> str | None:
    try:
        first = source.read_text(HF_METADATA).splitlines()[0].strip()
    except (FileNotFoundError, OSError, IndexError):
        return None
    return first if len(first) == 40 else None


def match(spec: JobSpec, revision: str | None) -> dict[str, Any] | None:
    variants: list[dict[str, Any]] = spec.raw.get("catalog", [])
    chosen = spec.raw.get("variant_id")
    if chosen:
        found = next((variant for variant in variants if variant["id"] == chosen), None)
        if found is None:
            raise FinalError(f"Catalogue entry {chosen} is unknown")
        return found
    return next((variant for variant in variants if revision and variant["revision"] == revision), None)


def verify(variant: dict[str, Any], copied: dict[str, dict[str, Any]]) -> None:
    for expected in variant["files"]:
        found = copied.get(expected["path"])
        if found is None:
            raise FinalError(f"{expected['path']} is missing; the folder does not match {variant['repo']}")
        wrong_size = found["size"] != expected["size"]
        if wrong_size or (expected.get("sha256") and found["sha256"] != expected["sha256"]):
            raise FinalError(f"{expected['path']} does not match the catalogue checksum for {variant['repo']}")


def main(spec: JobSpec) -> None:
    url = location_url(spec.raw["source_type"], spec.raw["location"])
    source = StorageSource(url)
    files = source.files()
    validate(source, files)
    variant = match(spec, detected_revision(source))
    out = spec.path("out")
    out.mkdir(parents=True, exist_ok=True)
    progress = Progress(sum(entry["size"] for entry in files), "importing")
    copied: dict[str, dict[str, Any]] = {}
    for entry in files:
        target = out / entry["path"]
        digest = write_stream(source.chunks(entry["path"]), target, progress, entry["path"])
        copied[entry["path"]] = {"path": entry["path"], "size": target.stat().st_size, "sha256": digest}
    if variant is not None:
        verify(variant, copied)
    manifest = sorted(copied.values(), key=lambda item: item["path"])
    record = {"source": url, "files": manifest, "variant_id": variant["id"] if variant else None}
    (out / "minibrain-model.json").write_text(json.dumps(record, indent=1))
    result = {"files": manifest, "size_bytes": progress.total, "source": url, "variant_id": record["variant_id"]}
    write_result(spec, result)
    report(1.0, step="verified against the catalogue" if variant else "imported, not verified", files=len(manifest))


if __name__ == "__main__":
    run_child(main)
