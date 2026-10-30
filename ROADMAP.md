# Minibrain roadmap

Private platform for small, task-specific models. Point at a data source → build examples → train a LoRA → eval
against the base → serve an OpenAI-compatible API. Many minibrains per install. On-prem / VPC, fully offline by
default. One deployable in v1, split into services later.

Standards: HF transformers + PEFT + TRL, OpenAI API. No Axolotl, no LLaMA-Factory.

## Positioning

- A minibrain learns **behaviour** (task, format, house style, labels) and **stable domain knowledge** (jargon, how
  things relate, rarely changing policy). Exact, changing or citable facts come from retrieval.
- Facts that change, need citations, or sit behind per-document access rules come from the minibrain's own index
  (RAG), built from the same sources as training.
- Train only when it pays off. Every minibrain starts prompt-only on the large local model; the eval shows whether a
  trained small model beats it on score, latency or cost.
- Two products on one install: a **private frontier endpoint** (the large open model behind the gateway, offline) and
  **minibrains** specialized from it on the customer's data.
- The customer owns the result: weights, data, evals, and the decision when anything changes. Every minibrain carries
  forward to each new base model (rebase).

### Use cases

Good fit, v1 targets:

| Use case | Task |
|---|---|
| Support automation | Triage, routing, reply drafts in house voice, from ticket history |
| Contract review | Clause extraction and classification → JSON |
| Industry domain model | Jargon, formats, proprietary label sets |
| Financial analysis | Text-to-SQL on the customer's own schema |
| Distillation | Logged frontier-model calls → small private model at lower cost and latency |

Need the index (Answer task type): internal knowledge Q&A, sales enablement, codebase assistant, compliance and
policy, HR helpdesk, customer success onboarding.

### Why raw documents are not enough

- Training on raw pages (`{"text": ...}`) teaches vocabulary and style, not reliable recall. The model answers in the
  right tone, gets details wrong, cannot cite, and goes stale on every edit.
- Fine-tuning learns input → output. Every example needs the correct output: the **label**.
- Documents become examples three ways: teacher-generated Q&A (`generate_qa`), teacher labels for a task, or raw text
  for house style only.

## Task types

A minibrain starts from a task type. It fixes the example shape, output schema, eval metric and default recipe, so
mapping comes down to a few fields.

| Type | Input → output | Metric | Output |
|---|---|---|---|
| Classify | Text → one label from a set | Accuracy, per-label F1 | JSON schema enum |
| Extract | Text → fields | JSON validity, field F1 | JSON schema |
| Rewrite | Text → text in house style | LLM judge vs reference | Free text |
| Text-to-SQL | Question + schema → SQL | Execution match on a read-only DB | SQL |
| Distill | Any prompt → the teacher's answer | LLM judge or exact match vs teacher | As the teacher |
| Answer | Question + retrieved chunks → answer | LLM judge vs reference, citation precision | Free text + citations |

- Classify and Extract are served with `response_format: json_schema`; SGLang constrains decoding so the output always
  parses.
- Rewrite also accepts raw documents as a style source, not only input/output pairs.

## Concepts

| Term | Meaning |
|---|---|
| Minibrain | Slug, sources, base model (pinned revision), `current` version pointer, system prompt, index, API keys |
| Version | Prompt-only (model + system prompt + few-shot examples) or trained (snapshot hash + recipe + base model revision + adapter), plus its eval result. Immutable. Version 0 is always prompt-only |
| Snapshot | Final examples as content-hashed Parquet + JSONL, fixed train/eval split |
| Pool | One serving engine, one base model, N adapters loaded. The teacher runs as its own pool |
| Job | Data build, training or eval run by the worker |
| Task type | Classify, Extract, Rewrite, Text-to-SQL or Distill; sets shape, schema, metric, recipe |
| Golden set | 20–50 human-verified examples written first; defines the task and gates promotion |
| Teacher | A larger local open model that labels data, sets the quality bar and serves prompt-only versions. An API teacher is opt-in, off by default |
| Rebase | Rebuilding a minibrain on a new base model from its snapshot, golden set and config, then comparing it with `current` |
| Feedback | A flagged or corrected output from the gateway or playground; lands in the review queue |
| Index | The minibrain's fact store, built from the same sources as training: chunks, embeddings, access metadata, synced continuously |

## Flow

task type → golden set → version 0: prompt-only on the teacher, evaluated → stop here if it passes and the cost is
acceptable.

Otherwise: source → DuckDB (query in place or stage) → mapping / SQL → built-in steps → teacher labels + human review
→ chat JSONL snapshot (train/eval split) → quality + PII + preview → LoRA training (worker subprocess) → eval vs base,
teacher and version 0 on the golden set + human review → promote → load adapter into pool → gateway
`/v1/chat/completions`

Distill shortcut: the gateway forwards calls to the teacher and logs them → the logs are the dataset → train → apps
change the model name.

Index, alongside: the same sources → chunks → embeddings → index, synced continuously → the gateway retrieves from it
at answer time.

## Architecture

One deployable, three process types. Module boundaries are the future service boundaries.

| Module | Owns | Future service |
|---|---|---|
| registry | Minibrains, versions, keys, audit log | api |
| data | Sources, staging, transforms, quality, PII, snapshots | data |
| train | Recipes, training subprocess, eval | train |
| serve | Pools, engine lifecycle, adapter load/unload | serve |
| gateway | OpenAI API, auth, name resolution, request logging, retrieval context step | gateway |
| ui | SPA | — |

| Process | Runs |
|---|---|
| `api` | uvicorn: gateway, registry, data previews, serves the SPA |
| `worker` | Huey consumer: data builds, training, eval. Every training and eval run is its own subprocess |
| `engine` | One serving engine per pool, started and stopped by `serve` |

Modules talk through the metadata DB and artifacts in the object store, never through in-memory calls across module
lines, so the split needs no rewrite.

## Stack

| Layer | Choice |
|---|---|
| API | FastAPI + uvicorn |
| Jobs | Huey with `SqliteHuey`; Procrastinate once on Postgres; Ray for multi-node in v2 |
| Metadata | SQLite WAL via SQLAlchemy; Postgres when split |
| Staging and transforms | DuckDB, one file per minibrain, disposable |
| Connectors | DuckDB scanners in v1; dlt from the first API source |
| PII | Presidio |
| Embeddings | Local open embedding model, pinned (e.g. Qwen3-Embedding-0.6B, Apache-2.0) |
| Index | LanceDB, embedded on disk: vector + full-text (hybrid) search. DuckDB `vss` persistence is still experimental |
| Training | torch + transformers + peft + trl + datasets + accelerate |
| Serving, production | SGLang; vLLM in v2 |
| Serving, local and tests | `transformers` backend; `llamacpp` later |
| Teacher | A larger local open model (default); the pool's base model when GPUs are small; an API only by opt-in |
| Object store | fsspec over local FS or S3-compatible storage; no MinIO dependency |
| Frontend | Vite SPA: TanStack Router + Query + Table, obp-ui, Tailwind v4 |
| Packaging | uv; Docker image for production |

### Why not

- **Celery**: needs Redis or RabbitMQ; with Redis, a job longer than `visibility_timeout` (1h default) is redelivered
  while still running, so two trainings land on one GPU.
- **SQLite for datasets**: row store, slow scans, cannot read Parquet / S3 / Postgres.
- **DuckDB for metadata**: one read-write process per file; the API and the worker both write metadata.
- **Streaming without staging**: every preview hits the source, dedupe and quality need the full set, runs are not
  reproducible, and SQL would run in each source's own dialect.

## Data

### Sources

- v1: Postgres, Parquet, S3, files, queried in place by DuckDB: `ATTACH '…' AS src (TYPE postgres, READ_ONLY)`,
  `read_parquet('s3://…')`, `read_csv`, `read_json`. No state to manage.
- Materialize into the minibrain's DuckDB file only when previews get slow or the source must not be hit repeatedly.
- dlt arrives with the first API source (Zendesk, Jira, Confluence), loading into the same DuckDB file. Its incremental
  state is what v2 "retrain on new data" runs on.
- The DuckDB file is a cache, rebuildable from the source. The only durable data artifact is the snapshot.
- Gateway request logs are a source like any other; the Distill task reads them directly.
- Sources are defined once per minibrain and feed both training (a frozen snapshot) and the index (continuous sync):
  one connector, one PII policy, one set of access rules, one lineage.
- Training uses only rows every user of the minibrain may see. Rows with narrower access go to the index only, where
  retrieval filters them per user.

### Example format

OpenAI chat messages, one per line: `{"messages": [{"role": "...", "content": "..."}]}`, optional `tools`.

### Transforms

One execution path, three ways in:

1. **Mapping UI**: fields → message slots, compiled to SQL.
2. **SQL editor**: the mapping, ejected and edited by hand.
3. **Built-in Python steps**, picked not written: `strip_html`, `chunk`, `pii_scrub`, `dedupe_near`, `generate_qa`
   (teacher model on the pool).

```sql
COPY (
  SELECT [
    {'role': 'system',    'content': 'Classify the ticket.'},
    {'role': 'user',      'content': subject || chr(10) || body},
    {'role': 'assistant', 'content': category}
  ] AS messages
  FROM tickets WHERE category IS NOT NULL
) TO 'train.jsonl' (FORMAT json);
```

- With a task type, SQL returns the task's columns (`input`, `label` or fields); the task type builds the messages.
- User SQL runs on a locked-down connection: only attached sources, no other file or network access, timeout.
- Arbitrary Python is v2: admin-only, sandboxed subprocess, no network.
- Auto-mapping: the pool's base model proposes a mapping from sampled rows; the user edits it.
- Preview: 5–10 examples rendered as chat transcripts, instantly via `LIMIT` pushdown.

### Labelling

The label is the assistant message: the correct output for an input.

| Data | Labels come from |
|---|---|
| Already paired (ticket → category, question → resolution) | The data; mapping only |
| Inputs only (tickets without a category, contracts) | Teacher labels every row; the user reviews a sample |
| Documents (wiki, PDFs) | Teacher writes Q&A per chunk and checks each pair against it (`generate_qa`); or raw text as a Rewrite style source |
| Gateway logs | The teacher's logged answers (Distill) |

Teacher labelling:

1. The teacher labels every row with the task's prompt and output schema.
2. Review queue: the user accepts or corrects rows, uncertain ones first (the teacher disagrees with itself across a few
   samples), until ~50–200 are verified.
3. Corrections go into the teacher prompt as examples; low-agreement rows are relabelled.
4. Verified rows feed the golden set and the eval split; the rest train.

Generated Q&A (`generate_qa`):

1. The teacher writes several question/answer pairs per chunk, including rephrasings and questions the chunk cannot
   answer, so the model learns to say it does not know.
2. Check pass: the teacher rereads each pair against its chunk and drops answers the chunk does not support.
3. The drop rate per source is shown; the user reviews a sample before training.

### Quality score

Empty fields, exact and near duplicates (MinHash), token length vs `max_seq_len`, label imbalance, train/eval leakage,
PII counts.

### PII

1. Presidio scans during the quality step.
2. UI shows counts per entity type and highlighted samples.
3. User picks an action per type: keep, mask, replace with a consistent fake, drop the row.
4. User spot-checks the preview.

- Custom regex recognizers per minibrain for internal IDs (customer numbers, employee IDs).
- Consistent fakes, not `<PERSON>` tags, or the model learns to emit the tags.
- Detection is risk reduction, not a guarantee; the UI says so. Minibrain access control stays the real control.

### Snapshots

- Final examples written as content-hashed Parquet + JSONL with a fixed train/eval split, referenced by a version.
- Raw source copies are optional; the snapshot is not.
- `HF_DATASETS_CACHE` points at the job directory and is deleted when the job ends.

## Training

- The worker claims a job and spawns `accelerate launch train.py <job.json>`. Never inside uvicorn.
- One lock per GPU. Train vs serve contention is a config: dedicated training GPUs, or unload the pool while training.
- On a single GPU the worker runs the steps in order: load the teacher pool → label / generate → unload → train → eval
  → load the adapter into the serving pool.
- Progress: a TRL `TrainerCallback` writes to the jobs table and a log file streamed to the UI.
- Cancel kills the process group. On start, the worker marks orphaned `running` jobs `failed`.
- One default recipe (rank, alpha, learning rate, epochs, `max_seq_len`), assistant-only loss, a small general
  instruction mix to limit forgetting. QLoRA optional on CUDA.
- The teacher can be a base model too: LoRA on the large model when prompting gets close but stays inconsistent
  (QLoRA keeps it on one GPU).

### Base model registry

- Short allowlist with the license recorded (Qwen, Mistral: Apache-2.0; Llama, Gemma: custom terms).
- Model and tokenizer pinned to an HF commit hash; every adapter records it.
- One base model per pool. Adapter rank ≤ pool `max_lora_rank`; target modules match the pool.
- Chat template parity test per base model: the prompt rendered at training time equals the one rendered at serving
  time.

## Eval and promote

- Eval first: the golden set (20–50 human-verified examples) is written or picked before any training.
- Version 0 is prompt-only on the teacher: the task type's prompt plus few-shot examples. It is usable minutes after
  the minibrain is created.
- Few-shot examples never come from the golden set, which must stay unseen: they come from other labelled rows, or,
  when the golden set is all there is, a few of its rows move out of it and stop being scored.
- If version 0 meets `promote.min_score` and its latency and cost are acceptable, the UI says no training is needed.
  Otherwise the report shows the gap a trained version has to close.
- Every version runs on the golden set and the held-out split: base, teacher and adapter on the same examples, scored
  with the task type's metric.
- Reported per model: score, p50 / p95 latency, cost per 1,000 requests (GPU time for local models, list price for API
  teachers). The headline reads like "base 54% → minibrain 91% at 1/20 of the teacher's cost".
- Side-by-side review screen. The version sits in `approval` until a user promotes it; a version that scores below
  `current` on the held-out split needs an explicit override. The golden set alone is too small to decide: in the
  spike, one of 50 rows moved the score 2 points and golden and held-out scores differed by 8–11 points.
- Promote moves `current` and loads the adapter into the pool. Rollback moves `current` back.

### Rebase

1. A new base model is registered (offline bundle, pinned commit). Its chat template parity test runs first.
2. `minibrain rebase --base <model>`, or one button, reruns every minibrain: training from the stored snapshot
   (relabelled first if the teacher changed), then eval on the golden set.
3. The report compares each rebased version with `current` on score, latency and cost.
4. Promotion stays per minibrain, through the usual review. Nothing changes until someone promotes.

### Feedback loop

1. `POST /v1/feedback` with the response id, a rating and an optional corrected output. With request logging off, the
   call carries the input too. Playground buttons call the same endpoint.
2. Feedback lands in the review queue; a reviewer accepts the correction or fixes it.
3. Accepted rows join the next snapshot; the worst failures can join the golden set.
4. Each minibrain shows feedback since its last version; retraining is one click.

## Retrieval

- Each minibrain has an index built from its sources: chunks, embeddings, full-text terms, source and access metadata.
- Sync is incremental: dlt state for API sources, change columns or file hashes otherwise. Rows deleted at the source
  leave the index.
- At answer time the gateway's context step retrieves top chunks (hybrid search, filtered by the caller's access),
  adds them to the prompt and returns citations with the answer.
- Per minibrain, retrieval is off, on, or required (no answer without supporting chunks).
- The embedding model and index run on local GPU or CPU; nothing leaves the network.
- Eval: retrieval hit rate and answer correctness on golden questions with known sources.

## Serving

- A pool is one SGLang instance started with `--enable-lora`, `--max-lora-rank` and `--lora-target-modules`.
- Adapters load and unload at runtime (`/load_lora_adapter`, `/unload_lora_adapter`), so hot-swap is v1 and needs no
  restart.
- Teacher pool: the larger model, with no adapters unless it was trained itself. Permanent when GPUs allow, otherwise
  loaded for labelling jobs and unloaded after. Prompt-only versions are served from it, so they need it permanent.
- `ServingBackend` interface: `start(pool)`, `load_adapter`, `unload_adapter`, `chat(stream)`. Implementations:
  `sglang` (production), `transformers` (local and tests), `vllm` (v2), `llamacpp` (later).
- Engines are never exposed; the gateway proxies every call.

## API and access

- `/v1/chat/completions` with streaming, `/v1/models`.
- `response_format` (`json_schema`) passed through; Classify and Extract minibrains set it by default.
- Upstream routes: the gateway forwards a model name to the teacher (local by default, an API only by opt-in) and
  logs the calls. Apps switch to the minibrain by changing the model name.
- Private frontier endpoint: the teacher model exposed by name through the gateway, with scoped keys, audit and
  logging like any minibrain.
- `POST /v1/feedback` (see Feedback loop).
- `model: "support-triage"` → current version; `"support-triage@3"` → pinned. The gateway maps it to SGLang's
  `<base>:<adapter>` name.
- API keys scoped to minibrains. Audit log: who, which minibrain, when.
- Request logging opt-in per minibrain; it feeds feedback and distillation.
- A context step between auth and the model call retrieves from the minibrain's index (see Retrieval).
- Citations come back in an extra `citations` field on the response.
- Login in v1: local accounts, OIDC (Entra, Okta, ADFS, Keycloak), and trusted headers from a reverse proxy. SAML
  reaches Minibrain through the customer's identity provider or a broker (Keycloak); CAC / PIV through the proxy's
  client-certificate check. Proxy headers are trusted only from configured proxy addresses.
- Harness config export: base URL, key and model name for common harnesses.

## UI

- obp-ui, operator-console style.
- Sidebar: Home · Explore (Models, Playground) · Create (Data, Training, Evaluations, Feedback) · Run (Deployments,
  Pipelines, Compute, Monitor) · Settings · user menu (Profile, Preferences, Sign out). Pages that work on one
  minibrain carry a picker, and the choice lives in the URL (`?minibrain=<slug>`).

| Need | obp-ui |
|---|---|
| Sidebar | `shell`: `AppShell`, `Rail`, `NavItem`, `SectionLabel`, `AccountMenu` |
| Status | `Badge`: queued `neutral`, training `info`, awaiting promote `approval`, current `success`, failed `destructive` |
| Training logs | `console`: `LogView`, `ConsoleDock` |
| Preview, playground, side-by-side eval | `chat`: `ChatBubble`, `AssistantTurn`, `ChatComposer` |
| Forms, tabs, tables | Primitives |

- Missing, added to obp-ui as an opt-in entry: SQL editor (CodeMirror 6).
- App-level: preview grid (TanStack Table over `Table`), loss and eval charts (Recharts).
- The chat is a playground, not open chat: the minibrain's system prompt, held-out examples as starter inputs, base vs
  adapter side by side.
- The review queue is built for domain experts (doctors, analysts, lawyers), not ML engineers: plain-language labels,
  rows assigned to people, agreement between reviewers tracked, no model terms on screen.
- Every output in the playground and review screens has thumbs-down and correct.

## Config as code

One `minibrain.yaml` per minibrain: task type, source, SQL, steps, teacher, recipe, golden set, promotion threshold.
The UI reads and writes the same file. `minibrain run <name>` rebuilds, labels, trains and evals from it, so a team
can keep minibrains in git and rerun them in CI.

```yaml
name: support-triage
task: classify
labels: [billing, bug, account, feature]
source:
  sql: |
    SELECT subject || chr(10) || body AS input, category AS label
    FROM src.tickets WHERE created_at > '2025-01-01'
steps: [strip_html, pii_scrub]
teacher: large-local
golden: golden.jsonl
recipe: default
promote:
  min_score: 0.85
```

## Offline

Fully offline by default. Nothing in the data, labelling, training, serving or gateway path calls out.

- Teacher: a larger open model on local GPUs. An API teacher is opt-in per install and off by default; the UI marks
  every minibrain whose data went to one.
- Model weights: downloaded on a connected machine, pinned to a commit (`hf download <repo> --revision <sha>`), copied
  in by disk or an internal mirror, registered by local path. `HF_HUB_OFFLINE=1` everywhere.
- Install bundle: Docker images, Python wheels, Presidio's spaCy model, the frontend build. Nothing downloads at install
  or run time.
- No telemetry.
- Air-gap test in CI: the M1 flow runs in a container with networking disabled.
- Updates: signed bundles for the app and for new base models, carried across the gap by disk. Verified offline before
  install; the previous version stays installed for rollback.

## Security and accreditation

v1, the evidence regulated buyers ask for first:

- SBOM (CycloneDX) for every image and Python dependency set.
- AI bill of materials per version: base model weights hash, license, training data snapshot hash, recipe, eval result.
- Signed images and update bundles (cosign), verified offline with a key shipped in the install bundle.
- Audit log: append-only and hash-chained so tampering shows, exported to the customer's SIEM over syslog.
- Encryption at rest for snapshots, staging files and adapters.
- Model card and validation report generated per version from the eval data: purpose, data, metrics, limits, who
  promoted it. This is the model-risk documentation US banks owe under SR 11-7.
- PII and PHI handling as in Data; access to every minibrain is scoped and audited.
- SSO: OIDC and trusted proxy headers (see API and access).
- FIPS-ready design, so FIPS mode in v2 is a build setting, not a rewrite:
  - SHA-256 for every content hash and signature; never MD5 or SHA-1 (ruff `S324` in CI).
  - Non-security hashing (MinHash) passes `usedforsecurity=False`.
  - All crypto through OpenSSL or the `cryptography` library; nothing hand-rolled.
  - Base images that can run in FIPS mode (Red Hat UBI).

v2, for defense and critical infrastructure:

- FIPS 140-3 validated crypto mode: FIPS-enabled images, test suite run in FIPS mode.
- Hardened images: DoD STIG, Iron Bank listing.
- Native SAML and CAC / PIV login, if customers' proxies are not enough; roles by team.
- Control mappings: CMMC / NIST 800-171, NIST 800-53, HIPAA.

## Platforms

Two modes, same code, same adapter format (PEFT safetensors).

| | Local | Production |
|---|---|---|
| OS | Linux, macOS, Windows | Linux |
| Install | Native via uv (Docker on macOS has no GPU access) | Docker image + compose; Helm / OpenShift in v2 |
| Compute | PyTorch picks CUDA, ROCm, MPS, Intel XPU or CPU | NVIDIA CUDA; AMD ROCm in v2 |
| Training | Same TRL/PEFT code; models up to ~3B (CPU: ~0.5B) | Full recipe, QLoRA optional |
| Serving | `transformers` backend, PEFT multi-adapter | SGLang pool |
| Teacher | The base model itself, a larger compressed model if memory allows, or an opt-in API | Larger local model on its own pool |
| For | Evaluating, developing, small teams | Real workloads |

- `uv pip install --torch-backend=auto` (or `UV_TORCH_BACKEND=auto`) picks CUDA, ROCm, Intel or CPU wheels. Docker
  builds have no GPU, so they set `UV_CUDA_DRIVER_VERSION` or `UV_AMD_GPU_ARCHITECTURE`, otherwise they get CPU wheels.
- Backend auto-select: Linux + CUDA or ROCm + the `sglang` extra installed → `sglang`; otherwise `transformers`.
  Overridable in config.
- SGLang on Windows: WSL2 only. SGLang on macOS (MLX backend, v0.5.10+) is experimental with no confirmed LoRA support,
  so it is not used.
- MPS gaps fall back to CPU with `PYTORCH_ENABLE_MPS_FALLBACK=1`.
- Local training falls back to CPU when the Metal GPU hangs. Seen in the spike: LoRA backward on an M1 Pro (macOS
  27.0.1, torch 2.15) hangs the GPU within 3–8 steps, while inference runs fine. CPU training there was only ~1.8×
  slower.
- Tests run on the `transformers` backend with a ~0.5B model; integration tests run on a GPU box.
- Later, a `llamacpp` backend for faster local serving: Metal, Vulkan (AMD and Intel GPUs on Windows and Linux), CPU.
  Needs PEFT → GGUF conversion; per-request LoRA works, requests with different adapters are not batched together.

### Non-NVIDIA hardware

| Hardware | Status |
|---|---|
| AMD Instinct MI300X / MI325X / MI35x | Second production target. PyTorch, PEFT and TRL run on ROCm; SGLang ships ROCm images and runs LoRA tests in AMD's CI on MI325X / MI35x. Verify LoRA on MI300X before promising it |
| Apple Silicon | Local only |
| CPU | Local only, tiny models |
| Intel GPUs (XPU) | Local, through PyTorch XPU |
| Intel Gaudi 3 | Separate trainer (optimum-habana) and vLLM plugin. Skip |
| Google TPU, AWS Trainium / Inferentia | Cloud VPC only, separate stacks reachable through vLLM. Skip |

### Production hardware

- 8B student: LoRA in bf16 ~40–48GB, QLoRA ~16–24GB, serving ~16GB weights plus KV cache.
- Teacher: ~30B class ~32GB in FP8 or ~64GB in bf16; ~70B class ~40GB in 4-bit; plus KV cache.
- Minimum: one 80GB GPU, steps run in order by the worker. Recommended: two (teacher and training on one, serving on
  the other) so prompt-only versions stay up.
- Reference configs: 2–3 tested servers (1× 80GB, 2× 80GB, 8× for many minibrains), each with exact driver, CUDA and
  image versions. A preinstalled appliance comes later.

## Milestones

### M1: one task, end to end

- One task type: Extract or Classify
- Sources: Postgres, files
- Golden set, prompt-only version 0 on a local teacher, teacher labelling with review queue
- Training; eval vs base and teacher with cost and latency; promote
- `transformers` and `sglang` backends
- Gateway: chat completions, `response_format`, scoped API keys
- Air-gapped install bundle

### v1

Everything in the v1 scope below, after M1.

## v1 scope

- [x] Minibrains: create, list, select, delete
- [ ] Task types: Classify, Extract, Rewrite, Text-to-SQL, Distill, Answer
- [ ] Index per minibrain: chunks, local embeddings, hybrid search, incremental sync, per-user access filter,
      citations
- [ ] Golden set authoring; eval-first flow
- [ ] Prompt-only version 0 on the teacher pool
- [ ] Teacher pool, permanent or temporary; API teacher opt-in, off by default
- [ ] `generate_qa` with check pass
- [ ] Teacher labelling with review queue
- [ ] Gateway upstream routes for distillation
- [ ] `response_format` with `json_schema`
- [ ] Cost and latency in eval
- [ ] `minibrain.yaml` and `minibrain run`
- [ ] Sources: Postgres, Parquet, S3, files via DuckDB scanners
- [ ] Auto-mapping proposal, mapping editor compiled to SQL, SQL editor
- [ ] Built-in steps: `strip_html`, `chunk`, `pii_scrub`, `dedupe_near`, `generate_qa`
- [x] Preview of 5–10 examples
- [ ] Quality score and PII report
- [x] Content-hashed snapshots with train/eval split
- [x] Worker (Huey), training subprocess, streamed logs, cancel
- [ ] Base model registry, default recipe, chat template parity tests
- [x] Eval vs base, side-by-side review, promote, rollback
- [ ] SGLang pool with runtime adapter load/unload
- [x] `transformers` backend for local mode and tests
- [ ] Gateway: chat completions with streaming, models, `name@version`, scoped API keys, audit log, opt-in request
      logs, retrieval context step
- [x] Playground
- [ ] Harness config export
- [ ] Login: local accounts, OIDC, trusted reverse-proxy headers
- [ ] FIPS-ready crypto rules enforced in CI
- [ ] Local install via uv on Linux, macOS, Windows; production Docker image (CUDA)
- [ ] Offline install bundle; air-gap CI test
- [ ] Signed offline update bundles (app and base models) with rollback
- [ ] Private frontier endpoint: the teacher model through the gateway, scoped keys
- [ ] Rebase: rebuild every minibrain on a new base model, compare, promote
- [ ] Feedback endpoint, thumbs-down / correct in playground and review screens → review queue
- [ ] Review queue for domain experts: plain language, assignment, reviewer agreement
- [ ] SBOM, AI bill of materials per version, signed images
- [ ] Hash-chained audit log with SIEM export; encryption at rest
- [ ] Model card and validation report per version
- [ ] Reference hardware configs

## v2

- Split into services: data, train, serve, gateway
- Adapters trained to answer from retrieved context and cite it
- dlt API connectors: Zendesk, Jira, Confluence, Salesforce, HubSpot
- One-click retrain on new data (dlt incremental)
- Automatic retrain when feedback since the last version crosses a threshold
- Version diff (data and scores)
- Preset recipes
- Arbitrary Python transforms (admin-only, sandboxed)
- Teams, sharing
- Multi-GPU and multi-node (Ray), serving pools across nodes
- vLLM backend, AMD ROCm production image, `llamacpp` local backend
- Dedicated or merged-adapter instances for high-traffic minibrains
- Optional MLflow
- FIPS 140-3 mode, STIG / Iron Bank images, native SAML + CAC / PIV, control mappings
- Helm chart, OpenShift
- Preinstalled appliance

## Risks to verify early

- SGLang LoRA on ROCm, MI300X specifically.
- `transformers` backend throughput with several adapters; serialize requests if PEFT adapter switching is not safe
  under concurrency.
- Huey on SQLite with the API and the worker writing at the same time.
- DuckDB Postgres scanner load on customer databases: read replicas, `LIMIT`, materialize.
- MPS dtype and op gaps during local training; Metal GPU hangs in LoRA backward (seen on M1 Pro, macOS 27.0.1).
- Teacher quality on generated Q&A: track the check-pass drop rate per source.
