from dataclasses import dataclass

from sqlalchemy.orm import Session

from minibrain.artifacts import ArtifactStore
from minibrain.data.shared import add_source
from minibrain.registry.models import Source
from minibrain.registry.service import NotFoundError
from minibrain.settings import sample_file

SAMPLE_TAG = "sample"


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


def add_sample(session: Session, store: ArtifactStore, file: str) -> Source:
    sample = find_sample(file)
    with sample_file(sample.file).open("rb") as stream:
        source = add_source(session, store, sample.file, stream)
    source.description = f"Sample: {sample.description} {sample.credit}"
    source.tags = [SAMPLE_TAG]
    return source
