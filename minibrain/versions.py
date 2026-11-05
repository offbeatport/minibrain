from importlib.metadata import PackageNotFoundError, version

JOB_PROTOCOL = 2
REPORTED = ("minibrain", "torch", "transformers", "peft", "trl", "sglang", "mlx-lm", "llama-cpp-python")


def library_version(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def installed_versions() -> dict[str, str]:
    found = {name: library_version(name) for name in REPORTED}
    return {name: value for name, value in found.items() if value is not None}
