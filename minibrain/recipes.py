from typing import Any

DEFAULT_RECIPE: dict[str, Any] = {
    "max_rows": 3000,
    "epochs": 1.0,
    "batch_size": 8,
    "grad_accum": 2,
    "rank": 16,
    "alpha": 32,
    "learning_rate": 2e-4,
}
