from pathlib import Path

MODEL_ID = "Qwen/Qwen3-0.6B"
MODEL_REVISION = "c1899de289a04d12100db370d81485cdf75e47ca"
DATASET_ID = "PolyAI/banking77"
DATASET_REVISION = "1846984189f2bc0ac51c6fc3a600fa9e1714e0c6"

ROOT = Path(__file__).parent
OUT = ROOT / "out"
DATA_DIR = OUT / "data"
ADAPTERS_DIR = OUT / "adapters"
RESULTS_DIR = OUT / "results"

ADAPTER_NAME = "banking77-1"
SEED = 7
GOLDEN_SIZE = 50
EVAL_SIZE = 500
SHOT_COUNT = 10
