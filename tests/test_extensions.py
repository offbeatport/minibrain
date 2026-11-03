from pathlib import Path

from minibrain.data import extensions


def test_bundled_lists_only_the_extensions_a_local_folder_carries(tmp_path: Path) -> None:
    versioned = tmp_path / extensions.engine_version() / extensions.platform()
    versioned.mkdir(parents=True)
    for name in ("httpfs", "iceberg", "avro"):
        (versioned / f"{name}.duckdb_extension.gz").write_bytes(b"")
    (tmp_path / "postgres_scanner.duckdb_extension").write_bytes(b"")
    (tmp_path / "v0.0.1" / "linux_amd64").mkdir(parents=True)
    (tmp_path / "v0.0.1" / "linux_amd64" / "mysql_scanner.duckdb_extension.gz").write_bytes(b"")
    assert extensions.bundled(str(tmp_path)) == ["httpfs", "postgres_scanner", "iceberg", "avro"]
    assert extensions.bundled(str(tmp_path / "empty")) == []
    assert extensions.bundled("https://mirror.internal/duckdb") == list(extensions.PURPOSES)
