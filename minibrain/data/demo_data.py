from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.artifacts import ArtifactStore
from minibrain.data.dataset_folders import free_dataset_name
from minibrain.data.dataset_versions import take_version
from minibrain.data.shared import Added, NameTaken, Outcome, add_dataset, add_source, guessed_template, source_columns
from minibrain.registry.models import Dataset
from minibrain.registry.service import NotFoundError, latest_version
from minibrain.settings import Settings, demo_file

DEMO_TAG = "minibrain:demo"


@dataclass(frozen=True)
class DemoData:
    file: str
    name: str
    format: str
    rows: int
    labels: int
    description: str
    credit: str
    large: bool = False

    @property
    def path(self) -> Path:
        return demo_file(f"{LARGE_FOLDER}/{self.file}" if self.large else self.file)


LARGE_FOLDER = "large"
BUILD_LARGE = "uv run python demo_data/build.py --large"

DEMO_DATA = (
    DemoData(
        file="demo_travel_intents.jsonl",
        name="Demo travel intents",
        format="JSON Lines",
        rows=750,
        labels=5,
        description="Sort travel support messages into intents such as lost luggage or refunds. The quick demo.",
        credit="Filtered from CLINC150 (Larson et al., EMNLP 2019), CC BY 3.0.",
    ),
    DemoData(
        file="demo_banking77.csv",
        name="Demo Banking77",
        format="CSV",
        rows=13_083,
        labels=77,
        description="Banking customer questions in 77 intents. Where training pays: many similar labels.",
        credit="Casanueva et al., PolyAI 2020, CC BY 4.0.",
    ),
    DemoData(
        file="demo_clinc150.parquet",
        name="Demo CLINC150",
        format="Parquet",
        rows=23_850,
        labels=151,
        description="150 intents plus out of scope. The hard one.",
        credit="Larson et al., EMNLP 2019, CC BY 3.0.",
    ),
    DemoData(
        file="demo_dbpedia14.parquet",
        name="Demo DBpedia-14",
        format="Parquet",
        rows=630_000,
        labels=14,
        description="Wikipedia abstracts in 14 topics. A realistic large run.",
        credit="Zhang et al., NeurIPS 2015, from DBpedia, CC BY-SA 3.0.",
        large=True,
    ),
    DemoData(
        file="demo_amazon_polarity.parquet",
        name="Demo Amazon reviews",
        format="Parquet",
        rows=4_000_000,
        labels=2,
        description="Product reviews, positive or negative. A stress test.",
        credit="Zhang et al., NeurIPS 2015, from McAuley and Leskovec 2013, Apache 2.0.",
        large=True,
    ),
)


def available_demos() -> list[DemoData]:
    return [demo for demo in DEMO_DATA if not demo.large or demo.path.is_file()]


def find_demo(file: str) -> DemoData:
    for demo in DEMO_DATA:
        if demo.file == file:
            return demo
    raise NotFoundError(f"no demo data called {file}")


def demo_path(demo: DemoData) -> Path:
    path = demo.path
    if not path.is_file():
        raise NotFoundError(f"{demo.name} is not built on this install: run {BUILD_LARGE} first")
    return path


def add_demo(session: Session, store: ArtifactStore, file: str, name_taken: NameTaken = NameTaken.KEEP_BOTH) -> Added:
    demo = find_demo(file)
    with demo_path(demo).open("rb") as stream:
        added = add_source(session, store, demo.file, stream, name_taken)
    if added.outcome == Outcome.CREATED:
        added.source.description = f"Demo data: {demo.description} {demo.credit}"
        added.source.tags = [DEMO_TAG]
    return added


def demo_dataset(session: Session, settings: Settings, store: ArtifactStore, file: str) -> Dataset:
    demo = find_demo(file)
    source = add_demo(session, store, file).source
    template = guessed_template(source_columns(settings, store, source))
    found = session.scalars(select(Dataset).where(Dataset.source_id == source.id))
    dataset = next((item for item in found if template is not None and item.template == template), None)
    if dataset is None:
        dataset = add_dataset(session, settings, store, free_dataset_name(session, demo.name, None), source)
        dataset.description = demo.description
    if latest_version(dataset) is None:
        take_version(session, settings, dataset)
    return dataset
