import tempfile
from pathlib import Path

from minibrain.data import snapshot
from minibrain.data.snapshot import SnapshotError
from minibrain.data.sources import SourceError, labelled_rows, stage
from minibrain.ml.context import JobSpec, report, run_child, write_result


def main(spec: JobSpec) -> None:
    out = spec.path("out")
    with tempfile.TemporaryDirectory() as scratch:
        staging = Path(scratch) / "staging.duckdb"
        report(0.1, step="staging the source")
        stage(spec.path("source"), staging)
        report(0.4, step="running the mapping")
        rows = labelled_rows(staging, spec.raw["sql"])
    report(0.7, step="cleaning and splitting", rows=len(rows))
    files = snapshot.write(snapshot.split(snapshot.clean(rows)), out)
    write_result(spec, {"hash": files.hash, "counts": files.counts, "labels": files.labels})
    report(1.0, step="done", counts=files.counts)


if __name__ == "__main__":
    run_child(main, (SnapshotError, SourceError))
