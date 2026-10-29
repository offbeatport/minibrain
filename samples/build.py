import csv
import json
import random
from pathlib import Path

from datasets import ClassLabel, Dataset, DatasetDict, load_dataset

OUT = Path(__file__).parent
SEED = 7
TRAVEL_INTENTS = {"book_flight", "book_hotel", "car_rental", "flight_status", "lost_luggage"}


def load_rows(repo: str, config: str | None, revision: str, label_column: str) -> list[tuple[str, str]]:
    splits = load_dataset(repo, config, revision=revision)
    if not isinstance(splits, DatasetDict):
        raise TypeError(f"expected splits for {repo}")
    rows: list[tuple[str, str]] = []
    for split in splits.values():
        if not isinstance(split, Dataset):
            raise TypeError(f"expected a Dataset in {repo}")
        feature = split.features[label_column]
        if not isinstance(feature, ClassLabel):
            raise TypeError(f"expected ClassLabel for {repo}.{label_column}")
        rows += [(row["text"], feature.names[row[label_column]]) for row in split.to_list()]
    random.Random(SEED).shuffle(rows)
    return rows


def write_csv(path: Path, header: tuple[str, str], rows: list[tuple[str, str]]) -> None:
    with path.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


def write_jsonl(path: Path, keys: tuple[str, str], rows: list[tuple[str, str]]) -> None:
    path.write_text("".join(json.dumps(dict(zip(keys, row, strict=True))) + "\n" for row in rows))


def write_parquet(path: Path, keys: tuple[str, str], rows: list[tuple[str, str]]) -> None:
    Dataset.from_list([dict(zip(keys, row, strict=True)) for row in rows]).to_parquet(str(path))


def main() -> None:
    banking = load_rows("PolyAI/banking77", None, "1846984189f2bc0ac51c6fc3a600fa9e1714e0c6", "label")
    clinc = load_rows("clinc/clinc_oos", "plus", "155b9c710419136e17307b80d0a13e68cd46b4ec", "intent")
    travel = [row for row in clinc if row[1] in TRAVEL_INTENTS]
    write_csv(OUT / "banking77.csv", ("text", "category"), banking)
    write_parquet(OUT / "clinc150.parquet", ("text", "intent"), clinc)
    write_jsonl(OUT / "travel_intents.jsonl", ("message", "intent"), travel)
    print(f"banking77={len(banking)} clinc150={len(clinc)} travel_intents={len(travel)}")


if __name__ == "__main__":
    main()
