import json
import os
import sys
import time
from pathlib import Path

if __name__ == "__main__":
    spec = json.loads(Path(sys.argv[1]).read_text())
    print(json.dumps({"progress": 0.5, "step": "half way"}), flush=True)
    time.sleep(float(os.environ.get("FAKE_JOB_SECONDS", "0")))
    code = int(os.environ.get("FAKE_JOB_EXIT", "0"))
    if code:
        error = os.environ.get("FAKE_JOB_ERROR", "boom")
        print(json.dumps({"error": error, "retryable": code != 2}), flush=True)
        sys.exit(code)
    out = spec.get("out") or spec.get("adapter_out")
    if out:
        Path(out).mkdir(parents=True, exist_ok=True)
        (Path(out) / "adapter_config.json").write_text('{"r": 16}')
    split = {"examples": 30, "accuracy": 0.7, "macro_f1": 0.7, "invalid_rate": 0.0}
    result = {"summary": {"fake": True}, "metrics": {"eval": split}}
    Path(spec["result"]).write_text(json.dumps(result))
