import json

from minibrain.ml.context import FinalError, JobSpec, report, run_child, write_result
from minibrain.models.files import Progress, write_stream
from minibrain.models.sources import StorageSource, location_url

TOKENIZER_FILES = ("tokenizer.json", "tokenizer_config.json")


def validate(source: StorageSource, files: list[dict]) -> None:
    names = {entry["path"] for entry in files}
    if "config.json" not in names:
        raise FinalError("No config.json: import a Hugging Face format folder (config, tokenizer, safetensors)")
    architectures = json.loads(source.read_text("config.json")).get("architectures") or []
    if not any(name.endswith("ForCausalLM") for name in architectures):
        raise FinalError(
            f"Only causal language models are supported; this folder has {architectures or 'no architecture'}"
        )
    if not any(name.endswith(".safetensors") for name in names):
        raise FinalError("No .safetensors weights in the folder")
    if not names.intersection(TOKENIZER_FILES):
        raise FinalError("No tokenizer files (tokenizer.json or tokenizer_config.json) in the folder")


def main(spec: JobSpec) -> None:
    url = location_url(spec.raw["source_type"], spec.raw["location"])
    source = StorageSource(url)
    files = source.files()
    validate(source, files)
    out = spec.path("out")
    out.mkdir(parents=True, exist_ok=True)
    progress = Progress(sum(entry["size"] for entry in files), "importing")
    manifest = []
    for entry in files:
        target = out / entry["path"]
        digest = write_stream(source.chunks(entry["path"]), target, progress, entry["path"])
        manifest.append({"path": entry["path"], "size": target.stat().st_size, "sha256": digest})
    (out / "minibrain-model.json").write_text(json.dumps({"source": url, "files": manifest}, indent=1))
    write_result(spec, {"files": manifest, "size_bytes": progress.total, "source": url})
    report(1.0, step="validated", files=len(manifest))


if __name__ == "__main__":
    run_child(main)
