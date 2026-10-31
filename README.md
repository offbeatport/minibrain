# minibrain

Private platform for small, task-specific models. Point it at your data, score a prompt-only baseline, train a LoRA,
compare versions on the same examples, and serve the one you promote on an OpenAI-compatible endpoint. Runs on your own
hardware, offline.

Plan: [`ROADMAP.md`](ROADMAP.md).

## Run it

minibrain is a Python package with the web UI built in, so running it needs no Node:

```sh
uvx --python 3.12 minibrain serve
```

`uv tool install minibrain` or `pip install minibrain`, then `minibrain serve`, work too. There is no published release
yet; until then build the wheel from this repo (see Develop) and run it with
`uvx --python 3.12 --from dist/minibrain-0.0.0-py3-none-any.whl minibrain serve`.

Open http://127.0.0.1:8000. `minibrain serve` starts main (UI, API, gateway) and supervises a job worker and one model
engine per base model, restarting them if they stop. Data, artifacts and the database live in `~/.minibrain` (set
`MINIBRAIN_HOME` to move them; `MINIBRAIN_DATABASE_URL` points the metadata at Postgres instead of SQLite).

Other roles, same package:

| Command | Runs |
|---|---|
| `minibrain worker --api-url http://main:8000` | A worker on another machine; it pulls jobs from main over HTTP |
| `minibrain gateway --main-url http://main:8000 --port 8100` | A standalone `/v1` gateway that serves from a cached config and keeps answering while main restarts |

Remote workers and gateways need the tokens in `~/.minibrain/secrets` (or `MINIBRAIN_WORKER_TOKEN` and
`MINIBRAIN_GATEWAY_TOKEN`).

The first scoring job downloads the base model (Qwen3-0.6B, about 1.5 GB) into the Hugging Face cache.

To try it, upload `samples/travel_intents.jsonl` (quick) or `samples/banking77.csv` (where training pays). See
[`samples/README.md`](samples/README.md).

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

`support-triage` follows the current version; `support-triage@2` pins one.

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

Training runs on CUDA when available, otherwise on CPU: the Metal GPU hangs during LoRA training on Apple Silicon (see
`spikes/banking77/README.md`). Set `MINIBRAIN_TRAIN_DEVICE` to override.
