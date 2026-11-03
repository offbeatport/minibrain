import os
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import duckdb

DIRECTORY_ENV = "MINIBRAIN_DUCKDB_EXTENSIONS"
REPOSITORY_ENV = "MINIBRAIN_DUCKDB_EXTENSION_REPOSITORY"
OFFICIAL = "https://extensions.duckdb.org"
PLATFORMS = ("linux_amd64", "linux_arm64", "osx_arm64", "osx_amd64", "windows_amd64")
PURPOSES = {
    "httpfs": "S3 and Iceberg sources",
    "postgres_scanner": "PostgreSQL sources",
    "mysql_scanner": "MySQL sources",
    "iceberg": "Iceberg sources",
    "avro": "Iceberg sources",
}
NEEDS = {"iceberg": ("avro",)}
INSTALL_HINT = "minibrain extensions install --from <folder>"


class ExtensionMissingError(Exception):
    def __init__(self, name: str) -> None:
        super().__init__(
            f"The DuckDB {name} extension is not installed on this server, so {PURPOSES.get(name, name)} cannot be "
            f"read. minibrain never downloads it at run time; an admin can install it with: {INSTALL_HINT}"
        )
        self.name = name


@dataclass(frozen=True)
class ExtensionState:
    name: str
    purpose: str
    installed: bool
    path: str | None


HOMES: dict[str, Path] = {}


def configure(home: Path) -> None:
    HOMES["install"] = home


def home() -> Path:
    configured = HOMES.get("install")
    if configured is not None:
        return configured
    return Path(os.environ.get("MINIBRAIN_HOME", Path.home() / ".minibrain")).expanduser()


def directory() -> Path:
    explicit = os.environ.get(DIRECTORY_ENV, "").strip()
    return Path(explicit).expanduser() if explicit else home() / "duckdb" / "extensions"


def repository() -> str | None:
    return os.environ.get(REPOSITORY_ENV, "").strip() or None


def local_repository() -> Path | None:
    found = repository()
    if found is None or "://" in found:
        return None
    path = Path(found).expanduser()
    return path if path.is_dir() else None


def offline_config() -> dict[str, Any]:
    return {
        "autoinstall_known_extensions": False,
        "autoload_known_extensions": False,
        "extension_directory": str(directory()),
    }


def offline_connection() -> duckdb.DuckDBPyConnection:
    return duckdb.connect(config=offline_config())


def engine_version() -> str:
    with duckdb.connect() as connection:
        found = connection.execute("SELECT library_version FROM pragma_version()").fetchone()
    return str(found[0]) if found else f"v{duckdb.__version__}"


def platform() -> str:
    with duckdb.connect() as connection:
        found = connection.execute("PRAGMA platform").fetchone()
    return str(found[0]) if found else ""


def quoted(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def with_dependencies(names: Iterable[str]) -> list[str]:
    ordered: list[str] = []
    for name in names:
        for needed in (*NEEDS.get(name, ()), name):
            if needed not in ordered:
                ordered.append(needed)
    return ordered


def install_from(connection: duckdb.DuckDBPyConnection, name: str, source: str) -> None:
    flat = Path(source).expanduser() / f"{name}.duckdb_extension"
    if "://" not in source and flat.is_file():
        connection.execute(f"INSTALL {quoted(str(flat))}")
    else:
        connection.execute(f"INSTALL {name} FROM {quoted(source)}")


def load(connection: duckdb.DuckDBPyConnection, names: Sequence[str]) -> None:
    for name in with_dependencies(names):
        try:
            connection.execute(f"LOAD {name}")
            continue
        except duckdb.Error:
            pass
        local = local_repository()
        if local is None:
            raise ExtensionMissingError(name)
        try:
            install_from(connection, name, str(local))
            connection.execute(f"LOAD {name}")
        except duckdb.Error as error:
            raise ExtensionMissingError(name) from error


def status() -> list[ExtensionState]:
    with offline_connection() as connection:
        found = connection.execute("SELECT extension_name, installed, install_path FROM duckdb_extensions()").fetchall()
    rows = {str(name): (bool(installed), str(path) if path else None) for name, installed, path in found}
    return [
        ExtensionState(
            name=name,
            purpose=purpose,
            installed=rows.get(name, (False, None))[0],
            path=rows.get(name, (False, None))[1],
        )
        for name, purpose in PURPOSES.items()
    ]


def missing(names: Iterable[str]) -> list[str]:
    installed = {state.name for state in status() if state.installed}
    return [name for name in with_dependencies(names) if name not in installed]


def install(source: str, names: Sequence[str] = tuple(PURPOSES)) -> list[str]:
    directory().mkdir(parents=True, exist_ok=True)
    done: list[str] = []
    with offline_connection() as connection:
        for name in with_dependencies(names):
            install_from(connection, name, source)
            connection.execute(f"LOAD {name}")
            done.append(name)
    return done


def remote_file(base: str, version: str, target_platform: str, name: str) -> str:
    return f"{base.rstrip('/')}/{version}/{target_platform}/{name}.duckdb_extension.gz"


def download(
    target: Path,
    platforms: Sequence[str],
    names: Sequence[str] = tuple(PURPOSES),
    source: str = OFFICIAL,
    version: str | None = None,
) -> list[Path]:
    import httpx

    release = version or engine_version()
    saved: list[Path] = []
    with httpx.Client(timeout=httpx.Timeout(120.0, connect=10.0), follow_redirects=True) as client:
        for target_platform in platforms:
            folder = target / release / target_platform
            folder.mkdir(parents=True, exist_ok=True)
            for name in with_dependencies(names):
                url = remote_file(source, release, target_platform, name)
                path = folder / f"{name}.duckdb_extension.gz"
                with client.stream("GET", url) as response:
                    response.raise_for_status()
                    with path.open("wb") as stream:
                        for chunk in response.iter_bytes(1 << 20):
                            stream.write(chunk)
                saved.append(path)
    return saved
