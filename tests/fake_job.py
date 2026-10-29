import os
import sys
import time

if __name__ == "__main__":
    print(f"fake job {sys.argv[1]}", flush=True)
    time.sleep(float(os.environ.get("FAKE_JOB_SECONDS", "0")))
    sys.exit(int(os.environ.get("FAKE_JOB_EXIT", "0")))
