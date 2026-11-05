from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from minibrain.artifacts import ArtifactStore
from minibrain.data.dataset_folders import free_dataset_name
from minibrain.data.dataset_versions import take_version
from minibrain.data.shared import Added, NameTaken, Outcome, add_dataset, add_source
from minibrain.presets.recipes import Recipe
from minibrain.registry.models import Dataset, Source
from minibrain.registry.service import NotFoundError, latest_version
from minibrain.settings import Settings, sample_file

SAMPLE_TAG = "minibrain:sample"


@dataclass(frozen=True)
class Sample:
    file: str
    name: str
    format: str
    rows: int
    labels: int
    description: str
    credit: str


SAMPLES = (
    Sample(
        file="travel_intents.jsonl",
        name="Travel intents",
        format="JSON Lines",
        rows=750,
        labels=5,
        description="Sort travel support messages into intents such as lost luggage or refunds. The quick demo.",
        credit="Filtered from CLINC150 (Larson et al., EMNLP 2019), CC BY 3.0.",
    ),
    Sample(
        file="banking77.csv",
        name="Banking77",
        format="CSV",
        rows=13_083,
        labels=77,
        description="Banking customer questions in 77 intents. Where training pays: many similar labels.",
        credit="Casanueva et al., PolyAI 2020, CC BY 4.0.",
    ),
    Sample(
        file="clinc150.parquet",
        name="CLINC150",
        format="Parquet",
        rows=23_850,
        labels=151,
        description="150 intents plus out of scope. The hard one.",
        credit="Larson et al., EMNLP 2019, CC BY 3.0.",
    ),
)


def find_sample(file: str) -> Sample:
    for sample in SAMPLES:
        if sample.file == file:
            return sample
    raise NotFoundError(f"no sample called {file}")


def add_sample(session: Session, store: ArtifactStore, file: str, name_taken: NameTaken = NameTaken.KEEP_BOTH) -> Added:
    sample = find_sample(file)
    with sample_file(sample.file).open("rb") as stream:
        added = add_source(session, store, sample.file, stream, name_taken)
    if added.outcome == Outcome.CREATED:
        added.source.description = f"Sample: {sample.description} {sample.credit}"
        added.source.tags = [SAMPLE_TAG]
    return added


def recipe_dataset(session: Session, source: Source, recipe: Recipe) -> Dataset | None:
    found = session.scalars(select(Dataset).where(Dataset.source_id == source.id))
    return next((dataset for dataset in found if dataset.template == recipe.mapping), None)


def load_recipe_sample(session: Session, settings: Settings, store: ArtifactStore, recipe: Recipe) -> Dataset:
    with recipe.data_path().open("rb") as stream:
        added = add_source(session, store, recipe.data, stream)
    source = added.source
    if added.outcome == Outcome.CREATED:
        source.description = f"Sample for the {recipe.name} recipe: synthetic data, no real customers."
        source.tags = [SAMPLE_TAG]
    dataset = recipe_dataset(session, source, recipe)
    if dataset is None:
        name = free_dataset_name(session, f"{recipe.name} sample", None)
        dataset = add_dataset(session, settings, store, name, source, template=dict(recipe.mapping))
        dataset.description = recipe.summary or None
    if latest_version(dataset) is None:
        take_version(session, settings, dataset)
    return dataset
