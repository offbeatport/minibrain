# minibrain

Private platform for building models of any size on your own data, task-specific or general purpose. Point it at your
data, score a prompt-only baseline, train a LoRA, compare versions on the same examples, and serve the one you promote
on an OpenAI-compatible endpoint. Runs on your own hardware, offline.

Plan: [`ROADMAP.md`](ROADMAP.md).

## Run it

minibrain is a Python package with the web UI built in, so running it needs no Node. The installer puts the latest
release on Linux or macOS (Apple silicon) with uv, checking its checksum and, when cosign is installed, its signature;
`sh -s -- --docker` pulls the Docker image instead:

```sh
curl -LsSf https://raw.githubusercontent.com/offbeatport/minibrain/main/install.sh | sh
minibrain serve
```

Or run it straight from the package with uv:

```sh
uvx --python 3.12 minibrain serve
```

`uv tool install minibrain` or `pip install minibrain`, then `minibrain serve`, work too. minibrain is not on PyPI yet:
until it is, pass the wheel from [GitHub Releases](https://github.com/offbeatport/minibrain/releases) instead of
`minibrain`, or, before the first release, build it from this repo (see Develop) and run it with
`uvx --python 3.12 --from dist/minibrain-0.0.0-py3-none-any.whl minibrain serve`. With Docker, the CPU image, or the
CUDA one on a Linux host with NVIDIA GPUs:

```sh
docker run --name minibrain -p 127.0.0.1:8000:8000 -v minibrain-data:/data ghcr.io/offbeatport/minibrain
docker run -d --name minibrain --gpus all --shm-size 8g -p 127.0.0.1:8000:8000 -v minibrain-data:/data ghcr.io/offbeatport/minibrain:cuda
```

Every release file and image is signed keyless with Sigstore; the checks, online and offline, are in
[`docs/install.md`](docs/install.md#verify-a-release).

[`docs/install.md`](docs/install.md) covers every install path, PyTorch backends (CUDA, ROCm, MPS, CPU), the Docker
image and compose file, air-gapped installs, upgrades and where data lives.

On the first start, `minibrain serve` prints a one-time setup link (and opens it in the browser on a desktop) that
creates the admin account; in Docker, `docker logs minibrain | grep setup` finds it, and `minibrain admin setup-link`
prints a new one. Automated deploys set `MINIBRAIN_ADMIN_EMAIL` and `MINIBRAIN_ADMIN_PASSWORD_FILE` instead, and single
sign-on with a group mapped to admin needs no local admin at all ([`docs/install.md`](docs/install.md#first-admin)).
Then open http://127.0.0.1:8000 and sign in. `minibrain serve` starts main (UI, API, gateway) and supervises a job
worker and one model engine per base model, restarting them if they stop. Data, artifacts and the database live in
`~/.minibrain` (set `MINIBRAIN_HOME` to move them; `MINIBRAIN_DATABASE_URL` points the metadata at Postgres instead of
SQLite).

Other roles, same package:

| Command | Runs |
|---|---|
| `minibrain worker --api-url http://main:8000` | A worker on another machine; it pulls jobs from main over HTTP |
| `minibrain gateway --main-url http://main:8000 --port 8100` | A standalone `/v1` gateway that serves from a cached config and keeps answering while main restarts |

Remote workers and gateways need the tokens in `~/.minibrain/secrets` (or `MINIBRAIN_WORKER_TOKEN` and
`MINIBRAIN_GATEWAY_TOKEN`).

OpenTelemetry export to your own collector, a Prometheus `/metrics` endpoint and JSON logs are all off by default:
[`docs/observability.md`](docs/observability.md).

The first scoring job downloads the base model (Qwen3-0.6B, about 1.5 GB) into the Hugging Face cache.

To try it, upload `samples/travel_intents.jsonl` (quick) or `samples/banking77.csv` (where training pays). See
[`samples/README.md`](samples/README.md).

## Models

**Models → Discover** lists a small curated catalogue (pinned revisions, sizes, licences, an estimate of fit on this
machine). Downloads run in the background, are checked against the published SHA-256 sums and land in
`~/.minibrain/models`; nothing is loaded or deployed until you choose to. Sources:

| Source | Configure |
|---|---|
| Hugging Face or a compatible mirror (Artifactory, Nexus) | `MINIBRAIN_HF_ENDPOINT` (default `https://huggingface.co`); `HF_TOKEN` for gated models |
| S3-compatible bucket (S3, MinIO, others behind an S3 gateway) | `MINIBRAIN_MODELS_S3_URL=s3://bucket/prefix`, plus the standard `AWS_*` variables (`AWS_ENDPOINT_URL` for MinIO) |
| A folder on the server | Nothing: **Add model** → Folder, and give the path |

`MINIBRAIN_OFFLINE=1` turns off every outbound call; the bundled catalogue stays browsable and imports keep working.
Catalogue updates are fetched only when you press **Check for updates**, or daily if you turn that on.

## Use the endpoint

Create a key on a minibrain's Endpoint tab, then:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="mb_...")
reply = client.chat.completions.create(
    model="support-triage",
    messages=[{"role": "user", "content": "I was charged twice"}],
)
print(reply.choices[0].message.content)
```

`support-triage` follows the current version; `support-triage@2` pins one. A Classify model answers with one of its
labels. `response_format` (`json_object` or `json_schema`) returns JSON that matches the schema, or an error: see
[Structured output](docs/serving.md#structured-output).

## Develop

Needs [uv](https://docs.astral.sh/uv/), Node with pnpm, and [mise](https://mise.jdx.dev) for the tasks in
`mise.toml`. Development data lives in `.minibrain/` in the repo.

```sh
mise run setup       # uv sync + pnpm install
mise run dev         # API + worker on :8000, UI with hot reload on :5173
mise run check       # tests, ruff, pyright, biome, tsc
mise run build       # dist/minibrain-*.whl with the built UI inside
mise run api-types   # regenerate the TypeScript client after API changes
```

On a fresh `.minibrain/`, the `mise run dev` log prints a setup link on `http://localhost:5173/setup?token=…` that
creates the first admin; the same path on :8000 redirects there. `minibrain admin setup-link` (with
`MINIBRAIN_HOME=.minibrain`) prints a new one.

Training runs on CUDA when available, otherwise on CPU: the Metal GPU hangs during LoRA training on Apple Silicon (see
`docs/findings.md`). Set `MINIBRAIN_TRAIN_DEVICE` to override.
