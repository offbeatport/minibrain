from typing import Any

from minibrain.ml.planner import EFFECTIVE_BATCH, LORA_DROPOUT, Settings

DEFAULTS = Settings()
DEFAULT_RECIPE: dict[str, Any] = {
    "max_rows": DEFAULTS.max_rows,
    "epochs": DEFAULTS.epochs,
    "rank": DEFAULTS.rank,
    "alpha": 2 * DEFAULTS.rank,
    "learning_rate": DEFAULTS.learning_rate,
    "dropout": LORA_DROPOUT,
    "batch": EFFECTIVE_BATCH,
}
