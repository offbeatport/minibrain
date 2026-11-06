import json
import os
import sys
import time
from pathlib import Path

from minibrain.ml.context import emit

if __name__ == "__main__":
    spec = json.loads(Path(sys.argv[1]).read_text())
    emit("train.step", "half way", progress=0.5, step=1, steps=2, loss=1.5, learning_rate=0.0002)
    if os.environ.get("FAKE_JOB_NOISE"):
        print("W1106 15:54:54.156000 56775 redirects.py:35] NOTE: Redirects are currently not supported.", flush=True)
        print('{"not": "ours"}', flush=True)
        print("Traceback (most recent call last):", flush=True)
        print('  File "x.py", line 1, in <module>', flush=True)
        print("ValueError: noisy", flush=True)
    time.sleep(float(os.environ.get("FAKE_JOB_SECONDS", "0")))
    code = int(os.environ.get("FAKE_JOB_EXIT", "0"))
    if code:
        error = os.environ.get("FAKE_JOB_ERROR", "boom")
        emit("job.error", error, "error", retryable=code != 2)
        sys.exit(code)
    out = spec.get("out") or spec.get("adapter_out")
    if out:
        Path(out).mkdir(parents=True, exist_ok=True)
        (Path(out) / "adapter_config.json").write_text('{"r": 16}')
    answers = {}
    if spec.get("version_kind"):
        from minibrain.data.splits import read_split

        answers = {
            name: [row.expected for row in read_split(spec["dataset_version"], name)] for name in ("golden", "eval")
        }
    result = {"summary": {"fake": True}, "metrics": {"device": "cpu"}, "answers": answers}
    Path(spec["result"]).write_text(json.dumps(result))
