# minibrain roadmap

Private platform for building models of any size on your own data, task-specific or general purpose. Point at a data
source → build examples → train a LoRA → eval against the base → serve an OpenAI-compatible API. Many minibrains per
install. On-prem / VPC, fully offline by default. One deployable in v1, split into services later.

Standards: HF transformers + PEFT + TRL, OpenAI API. No Axolotl, no LLaMA-Factory.

## Positioning

- Size follows the job: a small base where latency and cost matter, a large one where breadth matters. A minibrain can
  do one task or be a general-purpose assistant for a domain.
- A minibrain learns **behaviour** (task, format, house style, labels) and **stable domain knowledge** (jargon, how
  things relate, rarely changing policy). Exact, changing or citable facts come from retrieval.
- Facts that change, need citations, or sit behind per-document access rules come from the minibrain's own index
  (RAG), built from the same sources as training.
- Train only when it pays off. Every minibrain starts prompt-only on a local base model; the eval shows whether a
  trained version beats it on score, latency or cost.
- Two products on one install: a **private frontier endpoint** (the large open model behind the gateway, offline) and
  **minibrains** built on the customer's data, from small task models to large general-purpose ones.
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
| Distillation | Logged frontier-model calls → a private model at lower cost and latency |
| Domain assistant | A general-purpose model adapted to the organisation's language, formats and policies |

Need the index (Answer task type): internal knowledge Q&A, sales enablement, codebase assistant, compliance and
policy, HR helpdesk, customer success onboarding.

### Why raw documents are not enough

- Training on raw pages (`{"text": ...}`) teaches vocabulary and style, not reliable recall. The model answers in the
  right tone, gets details wrong, cannot cite, and goes stale on every edit.
- Fine-tuning learns input → output. Every example needs the correct output: the **label**.
- Documents become examples three ways: teacher-generated Q&A (`generate_qa`), teacher labels for a task, or raw text
  for house style only.

## Task types

Every model has an output contract, fixed for its life, and graders. Training data is always chat examples
(`messages`); a column mapping is a template that turns table rows into them. A task type is a preset that picks the
contract, the default graders, the mapping form and the serving constraint, so a team without ML specialists gets a
scored, promotable model. Fireworks and Together expose only the parts; minibrain exposes both, on one engine.

| Preset | Contract (served as) | Default graders | Example |
|---|---|---|---|
| Classify | One value from a label set (an enum in `response_format`) | Exact match: accuracy, per-label F1 | Ticket → `billing` |
| Extract | A JSON schema (`response_format: json_schema`) | JSON validity, per-field match | Invoice → `{"total": 120, "due": "2026-12-01"}` |
| Rewrite | Free text | Judge model with a rubric, similarity to the reference | Draft reply → reply in house style |
| General / Assistant | Free text, multi-turn; structured output on request | Judge model with a rubric, plus any added graders | Support conversation → answer in company tone |
| Text-to-SQL | SQL | Execution match on a read-only database | Question + schema → query |
| Custom | Any contract above, chosen | Chosen | Bring chat JSONL |

- Changing a contract makes a new model: versions, scores and API answers only compare under one contract. The base
  can change (Rebase); the contract cannot.
- Constrained decoding enforces the contract: XGrammar on SGLang and vLLM, a grammar on llama.cpp, a token trie on MLX
  and `transformers`. Classify is an Extract contract with one enum field and still answers with the bare label.
- Graders: exact match, JSON field match, text similarity, a judge model with a rubric (a model on this install, so it
  runs air-gapped), SQL execution, and Python graders `score(answer, example) -> float` run sandboxed. Graders combine
  into the promotion rule, for example `judge >= 0.8 and no_card_numbers == 1`.
- Distill is a data source, not a preset: answers logged from a teacher model become the examples for any preset.
- Rewrite also accepts raw documents as a style source, not only input/output pairs.
- Training methods: SFT with LoRA by default; full fine-tuning; DPO from feedback pairs; reinforcement fine-tuning
  (GRPO) with the same graders as rewards.

### For ML engineers

- The Custom preset: chat JSONL, the contract and graders chosen, Python graders.
- Training settings: LoRA rank, learning rate, epochs, sequence length, full fine-tuning, DPO; saved recipes.
- Everything the UI does through the API and CLI; `minibrain.yaml` per model in git (Config as code); `minibrain train`
  in CI with the promotion rule as the gate.
- Export adapters or merged weights (safetensors, GGUF), with training logs and metrics.

### Order

There are no users yet, so the engine is built from scratch with no compatibility layer; today's Classify code is
replaced, not migrated.

1. The engine, usable as Custom: chat examples, a contract (free text, label set, JSON schema), built-in graders
   (exact match, label accuracy, JSON field match, text similarity, a judge model on this install) and a promotion
   rule over them; plus the recipe format (below).
2. Classify as a preset on it, with its recipes and Start from a recipe in Add model.
3. Extract, with its recipes.
4. General / Assistant: judge rubrics, distillation from a teacher, DPO from feedback; with its recipes.
5. For ML engineers: sandboxed Python graders, training settings and saved recipes, the CLI with `minibrain.yaml`,
   reinforcement fine-tuning with the graders as rewards, exports.
6. Text-to-SQL with the execution grader.

### Recipes

A recipe is a worked use case a team can start from: `recipes/<name>/` holds a `minibrain.yaml` (preset, suggested
base, column mapping, graders, promotion rule), a small synthetic sample dataset and a `README.md` (the situation,
the data needed, the steps, and when it is not a fit). The docs render the README; Add model offers Start from a
recipe, which fills the form and loads the sample to try before using real data. Recipes name no customers.

| Area | Recipe | Preset |
|---|---|---|
| Finance | Trade break triage: break description → reason (price, quantity, settlement date, counterparty) | Classify |
| Finance | Term sheet and confirmation extraction: text → notional, maturity, coupon, counterparty | Extract |
| Finance | Communications surveillance: chat or email → flag or not, with the reason; recall-first rule | Classify |
| Finance | Research notes in house style: analyst draft → client-ready note | General |
| Insurance | Claims triage: first notice of loss → line, severity, route | Classify |
| Legal | Contract clause extraction: contract → governing law, term, termination, liability cap | Extract |
| Healthcare | Clinical note coding: note → codes, on an air-gapped install | Extract |
| Support | Ticket routing: subject and body → queue (the bundled sample) | Classify |
| IT operations | Incident classification: alert or ticket → service, severity | Classify |
| Public sector | Request routing: citizen request → department | Classify |
| Any | Distil an assistant: a large model's logged answers → a smaller model that matches them | General |

- A recipe says plainly when a language model is the wrong tool: numeric forecasting and regression on tables (for
  example predicting fund outflows) belong to classic ML; minibrain can still supply text features for it, such as
  flagging client emails that signal a redemption.

## Concepts

| Term | Meaning |
|---|---|
| minibrain | Slug, sources, base model (pinned revision), `current` version pointer, system prompt, index, API keys |
| Version | Prompt-only (model + system prompt + few-shot examples) or trained (dataset version + recipe + base model revision + adapter), plus its eval result. Immutable. Version 0 is always prompt-only |
| Dataset version | A dataset's rows copied to content-hashed Parquet when the dataset is created, its query is saved or it is updated; numbered per dataset (v1, v2, …); splits are derived from it. Internally a snapshot |
| Pool | One serving engine, one base model, N adapters loaded. The teacher runs as its own pool |
| Job | Data build, training or eval run by the worker |
| Task type | Classify, Extract, Rewrite, Text-to-SQL or Distill; sets shape, schema, metric, recipe |
| Golden set | 20–50 human-verified examples; defines the task and scores every version |
| Teacher | A larger local open model that labels data, sets the quality bar and serves prompt-only versions. An API teacher is opt-in, off by default |
| Rebase | Rebuilding a minibrain on a new base model from its dataset version, golden set and config, then comparing it with `current` |
| Feedback | A flagged or corrected output from the gateway or playground; lands in the review queue |
| Index | The minibrain's fact store, built from the same sources as training: chunks, embeddings, access metadata, synced continuously |

## Flow

task type → golden set → version 0: prompt-only on the teacher, evaluated → stop here if it passes and the cost is
acceptable.

Otherwise: source → DuckDB (query in place or stage) → mapping / SQL → built-in steps → teacher labels + human review
→ dataset version (train/eval split) → quality + PII + preview → LoRA training (worker subprocess) → eval vs base,
teacher and version 0 on the golden set + human review → promote → load adapter into pool → gateway
`/v1/chat/completions`

Distill shortcut: the gateway forwards calls to the teacher and logs them → the logs are the dataset → train → apps
change the model name.

Index, alongside: the same sources → chunks → embeddings → index, synced continuously → the gateway retrieves from it
at answer time.

## Architecture

One install is one supervised process tree: one command starts it, and minibrain starts and restarts the rest.
main is the control plane; gateways and engines are the serving plane. Production runs on GPU racks, rented or on-prem;
a laptop install is onboarding. A local main can drive remote GPU workers and engines. Details and tradeoffs:
`docs/architecture.md` and the docs it links.

| Process | Runs |
|---|---|
| main | UI and `/api`, management, job submission, deployments, gateway (`/v1`) and routing; supervises the others |
| worker | Ingestion and data preparation; launches training jobs |
| training | One child per training or eval job; writes checkpoints and results |
| engine | One model (base + many adapters) per process; SGLang, MLX, `transformers` or llama.cpp, chosen per node |

- The serving plane keeps serving without main. main publishes a versioned config snapshot (routes, versions, adapters,
  key hashes, limits); gateways keep the last good copy on disk and serve from it, and buffer request and audit logs
  until main is back. A main outage or upgrade pauses only the UI and new jobs; rollback republishes a snapshot.
- Everything long-running is a job on one contract: data preparation, training, eval, batch jobs, pipeline steps.
- One binary, many roles: `minibrain serve` runs all; `--role api|gateway|worker|engine` runs one. Compose, Helm and
  Kubernetes only start roles separately.
- The jobs table is the only job state: status, attempt, lease with heartbeat, idempotency key, cancel flag. A job is
  stored before it runs and the API returns its ID at once.
- Workers never touch the database. They claim, heartbeat, report and finish through the API, so the main process is
  the only writer and a remote worker is the same program with a URL and a token.
- At-least-once execution: jobs write to a temporary location and commit atomically; training resumes from its last
  checkpoint after a lost lease.
- Progress is events: workers post them, the UI follows over SSE. Logs are artifacts read by offset.
- Artifacts are referenced by SHA-256 ID, never by path: sources, snapshots, adapters, checkpoints, eval results, logs,
  batch outputs. Base model weights are pinned by repo and revision, and each file by its SHA-256.
- The gateway is separate from management: routing lives in memory, refreshed on version changes, with no database
  read per request. Engines are children with health checks.
- The main process leases GPUs: training and engines share them on one box, so a job states its needs and waits.
- Compute pools: workers and engines join a named pool and report GPUs, memory, CPU, platform and installed engines.
  Discover judges fit against the selected pool; the Compute page lists pools, machines and engines.
- Engines pick their engine at start from the node and the weights: SGLang on Linux with NVIDIA or ROCm, MLX on Apple
  silicon, llama.cpp for GGUF, `transformers` otherwise. Remote engines (`minibrain engine --model --pool`) pull
  adapters from main and base weights from the bucket on links main signs (from main itself when Storage is the
  folder), and announce themselves; replicas scale horizontally.
- Gateways route per model: fewest requests in flight, sticky by adapter or prompt prefix, overflow when busy, health
  checks and failover. HAProxy, Envoy or a cloud load balancer in front; sgl-router or llm-d under the gateway later.
- Several mains on Postgres: an advisory lock picks the leader for lease expiry, catalogue sync and log purge. No
  ZooKeeper; consensus is Postgres HA's or Kubernetes'. SQLite stays a single main.
- Orchestration: workers and engines started by hand or by the customer's tooling in v1, a Kubernetes launcher in v2,
  a cloud VM launcher later.
- Children die with the parent and restart with backoff. A launcher starts work: a local subprocess now, a remote
  worker or a Kubernetes Job later.
- Module boundaries (registry, data, train, serve, gateway) are the future service boundaries; no in-memory state
  crosses them.
- One database code path: SQLAlchemy 2 and Alembic, no raw SQL or dialect branches. `MINIBRAIN_DATABASE_URL` picks
  SQLite (default) or Postgres; tests run on both. The job claim is one statement (`UPDATE … RETURNING` with
  `FOR UPDATE SKIP LOCKED`, which SQLite ignores).

| | Local | Deployed |
|---|---|---|
| Metadata | SQLite (WAL) | SQLite; Postgres for a highly available main |
| Artifacts | Local folder | S3-compatible store |
| Workers | Local processes | Local or remote, same contract |
| Engines | Local children | Local or remote, per pool, routed by gateways across replicas |
| Roles | One process tree | Separate processes or services |

### Tradeoffs

- No Compose or Kubernetes locally: Docker on macOS has no GPU, and `uvx minibrain serve` must work air-gapped.
- Own jobs table: Procrastinate is Postgres-only, Huey keeps a second job record without leases, Celery / RQ /
  Dramatiq need a broker, Temporal / Hatchet / Prefect are separate servers. DBOS Transact is closest but its workers
  need database access. Revisit it if pipelines need durable multi-step workflows.
- Workers through the API: no database credentials outside the main process and one SQLite writer, for more API
  surface and workers that wait while the main process is down.
- At-least-once, not exactly-once: simpler, correct while every job is idempotent.
- SQLite is single-writer: one main. With a statically stable serving plane that is enough; Postgres buys a main that
  fails over without downtime.
- SQLite and Postgres only: other SQLAlchemy dialects may work but are not tested.

## Stack

| Layer | Choice |
|---|---|
| API | FastAPI + uvicorn |
| Jobs | Own jobs table with leases; workers claim through the API; Ray for multi-node training in v2 |
| Metadata | SQLAlchemy 2 + Alembic; SQLite by default, Postgres optional |
| Staging and transforms | DuckDB, one file per minibrain, disposable |
| Connectors | DuckDB scanners in v1; dlt from the first API source |
| PII | Presidio |
| Embeddings | Local open embedding model, pinned (e.g. Qwen3-Embedding-0.6B, Apache-2.0) |
| Index | LanceDB, embedded on disk: vector + full-text (hybrid) search. DuckDB `vss` persistence is still experimental |
| Training | torch + transformers + peft + trl + datasets + accelerate |
| Serving, production | SGLang; vLLM in v2 |
| Serving, Apple silicon | MLX (`mlx-lm`), optional extra |
| Serving, GGUF | llama.cpp (`llama-cpp-python`), optional extra |
| Serving, fallback and tests | `transformers` backend |
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

Data is shared across models:

- A **source** is something minibrain reads: an upload (stored once, content-addressed, staged into DuckDB), a
  folder on the server, an S3 path, a database table or query, or a Lakehouse table: Iceberg on S3 or Delta Lake in a
  server folder (all but uploads read in place; S3, database and Iceberg through a connection). Each source is a
  table in dataset SQL under a stable, readable name taken from its name when it is added (`support_tickets`,
  `support_tickets_2`); renaming the source keeps the table name, so saved SQL keeps working.
- A **dataset** stands on its own: one saved DuckDB query that returns `input` and `label`, plus any extra columns,
  over one or more sources. Columns mode picks one source and its input and label columns and generates the SELECT;
  SQL mode joins, unions, filters and cleans across sources. A dataset over one source can still say `FROM source`.
  Each custom model points at one dataset, and several models can use the same dataset to compare fairly.
  Dataset names are unique within their folder, like files in a folder, case aside; slugs stay unique across the
  install. A typed name that is taken is refused with a 409 naming the dataset that holds it and a free name
  (`detail`, `name`, `suggestion`, `taken`); a name minibrain suggests that is taken gets the next number
  (`Tickets (2)`). Moving a dataset into a folder where its name is taken is refused; deleting a folder numbers a
  dataset whose name is taken one level up.
- A **dataset version** is a full copy of a dataset's rows, never a reference (see Dataset versions). Each model
  version records the dataset version it trained and scored on.
- A dataset or source still in use cannot be deleted.
- Catalogue: sources and datasets carry a name, an optional description and tags. Search covers names, table names,
  column names, descriptions and tags. Column stats (type, empty share, approximate distinct count, range for non-text
  types) come from a bounded sample (`SUMMARIZE` over the first 10,000 rows); the preview runs the query live, shows
  its first 20 rows and counts rows per label across the whole result; a dataset shows its train / held-out / test /
  few-shot split while its latest version still matches its data and query.
- User SQL is parsed first (`json_serialize_sql`): exactly one SELECT, whose table names pick the sources to expose.
  It then runs in an in-memory DuckDB with external access off and the configuration locked: uploads are attached
  read-only, a folder is a view over its listed files and `allowed_paths` names exactly those files, and a query
  stops after 30 seconds. Sources are named by table name alone: a catalog- or schema-qualified name and the scanner
  table functions (`postgres_query`, `mysql_*`, `iceberg_*`, `delta_*`, `query`, `query_table`) are refused, so
  dataset SQL cannot reach past its sources into the rest of an attached database.

### Sources

- Uploads: CSV, TSV, JSON, JSON Lines or Parquet, staged into a DuckDB file keyed by content hash.
- Source names are unique across the install, case aside. A name minibrain takes from a file, folder, path or table
  gets the next number when it is taken (`tickets (2).csv`, table `tickets_2`); a typed name (Add source, Rename,
  Edit) that is taken is refused with the same 409 as datasets.
- One content is one upload source: uploading a file whose SHA-256 is already a source's, under any name, stores
  nothing and returns that source (`200`, `outcome: existing`), and the UI says "This file is already uploaded as
  <name>" with Open. A second source over the same content is not offered: it would be a second table name for the
  same rows, and datasets already share sources and SQL can read one table twice. Samples follow the same rule.
- A new file whose name an upload with other content holds: `POST /api/sources?name_taken=keep_both` (the default)
  adds it as `tickets (2).csv` with its own table; `replace` points the existing source at the new file, keeping its
  id, name and table, so datasets reading it say "Sources changed since vN" and Update saves the next version (a
  source that is not an upload cannot be replaced); `fail` stores nothing and answers 409 with the taken name and a
  free one. The upload button sends `fail` and, only then, asks Replace or Keep both (Keep both selected), so the same
  content never prompts; Training's upload keeps both.
- A folder, S3 path, database table or query, or Lakehouse table added again at the same location (connection,
  path or table or query, and format when one is given) returns the existing source the same way (`200`,
  `outcome: existing`) without reading it again. An S3 or Iceberg path is the same location with or without trailing
  slashes.
- An upload's stored file and staged table are deleted when it is replaced or deleted and no other source, dataset
  version or model version uses that content.
- Folders: a directory on the server, read in place as one table: every file of one format (CSV, TSV, JSON, JSON
  Lines or Parquet) under it, hidden files and symlinks skipped, joined by column name (`union_by_name`), at most
  10,000 files. Only folders inside the Folder sources policy (Settings → Security, lockable from config or
  `MINIBRAIN_POLICY_DATA_FOLDERS`) can be added, and a folder taken off that list stops being readable. Each folder
  shows its file count, size and last change.
- S3: a connection plus `s3://bucket/prefix/*.parquet` (or `.csv`, `.json`, a single object, or a prefix whose most
  common format wins), read in place by DuckDB's httpfs as one table, at most 10,000 objects; names starting with `.`
  or `_` (`_SUCCESS`) are skipped. The listing (s3fs) gives the exact objects DuckDB reads, `allowed_paths` names
  exactly those, and a DuckDB secret scoped to the bucket carries the keys. Fingerprint: SHA-256 of key, size and
  ETag per object.
- Database: a PostgreSQL or MySQL connection plus a table (`name` or `schema.name`) or one read-only query (SELECT or
  WITH, no second statement; it runs wrapped as a subquery). DuckDB's postgres or mysql scanner attaches the database
  `READ_ONLY` through a DuckDB secret; PostgreSQL sessions also get `default_transaction_read_only=on` and a 30-second
  `statement_timeout`. Fingerprint: with an updated-at column, the row count plus its maximum; without one, the query
  plus the time read, so every read counts as new data. Use a read-only database user: minibrain never writes, but
  the user's grants are the real control.
- Lakehouse tables, one group in the Data tree whose items each show their table format (the source kind stays
  `iceberg` or `delta`, so no migration); Add source → Lakehouse table picks the format, then the connection or folder:
  - Iceberg: an S3 connection plus the table's folder. minibrain lists `metadata/`, takes the highest-numbered
    `*.metadata.json` and its `current-snapshot-id`, and DuckDB's iceberg extension reads that snapshot
    (`iceberg_scan(…, version, snapshot_from_id)`) with `allowed_directories` limited to the table folder.
    Fingerprint: the snapshot id. REST catalogues come later; DuckDB can attach them, but tables on S3 need nothing
    beyond the S3 connection.
  - Delta Lake: a table folder on the server, inside the Folder sources policy (local disk, NFS, SMB or a mounted
    bucket). minibrain lists `_delta_log/`, takes the newest commit (or checkpoint) version, and DuckDB's delta
    extension reads that version (`delta_scan(…, version)`) with `allowed_directories` limited to the table folder.
    Fingerprint: `v<version>-` plus a SHA-256 of the folder, the version and the newest log file's name, size and
    modification time, so a dataset version names the table version it copied. Not from S3 or HTTPS: the extension's
    delta-kernel-rs reads the log over its own rustls and ring TLS, outside OpenSSL, so it is not FIPS-ready
    (`docs/security.md`, TLS in DuckDB extensions); those paths are refused with that reason. A folder holding
    `_delta_log` cannot be added as a plain folder source.
- Remote fingerprints are cached for 30 seconds per source so listing pages does not hit a bucket or database on
  every request. Everything goes through the row limit and the 30-second timeout, and dataset versions copy the
  rows to Parquet like any other source.
- Materialize into the minibrain's DuckDB file only when previews get slow or the source must not be hit repeatedly.
- dlt arrives with the first API source (Zendesk, Jira, Confluence), loading into the same DuckDB file. Its incremental
  state is what v2 "retrain on new data" runs on.
- The DuckDB file is a cache, rebuildable from the source. The only durable data artifact is the dataset version.
- Gateway request logs are a source like any other; the Distill task reads them directly.
- Sources are defined once per minibrain and feed both training (a saved dataset version) and the index (continuous sync):
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

Version checks, run on every dataset version (and every feedback copy) and stored with it; the report shows on the
dataset and on the Training page before a run starts:

- Hard stops, always on: no row with both an input and a label, or a single label. These refuse the version, so a
  dataset is not created and a query is not saved while they hold.
- Warnings, each with an on/off switch under Settings → Data, never block: repeated inputs; the same input with
  different labels; label balance (one label above a share, 90% by default, or labels under a row count, 10 by
  default, both editable); train/test leakage (a test or held-out input also in training once case, spacing and
  punctuation are ignored); empty inputs and inputs past the training example's length (estimated at four characters
  a token); personal data found by local patterns: email addresses, phone numbers, card numbers (Luhn-checked) and
  IBANs (mod-97-checked). The report says plainly that the patterns can miss names and addresses.
- "Dismiss for this dataset" stores the check and a signature of its result on the dataset; the warning shows again
  when a later version's result for that check differs.

### PII

1. Presidio scans during the quality step.
2. UI shows counts per entity type and highlighted samples.
3. User picks an action per type: keep, mask, replace with a consistent fake, drop the row.
4. User spot-checks the preview.

- Custom regex recognizers per minibrain for internal IDs (customer numbers, employee IDs).
- Consistent fakes, not `<PERSON>` tags, or the model learns to emit the tags.
- Detection is risk reduction, not a guarantee; the UI says so. minibrain access control stays the real control.

### Dataset versions

A dataset saves its rows when it is created, and each refresh is a new version, so what the preview shows and what
trains are the same rows. "Snapshot" is the internal name (the `snapshots` table, `/api/datasets/<slug>/snapshots`);
the UI says version.

- Saved when a dataset is created with its columns or SQL (version 1), when its query or columns are saved, and with
  Update on the dataset (or on Training, when its sources changed). A dataset created with no columns picked has no
  version until its first successful mapping. Saving runs the dataset's query once in the main process, sorts the
  rows (`ORDER BY ALL`) and writes them to Parquet; the file's SHA-256 is the version's hash and its artifact id, so
  identical rows are stored once. Rows identical to the latest version make no new version (Update then only records
  the sources' new fingerprints); rows identical to an older one make the next version, sharing its file.
- Versions are numbered per dataset (`snapshots.number`, unique per dataset) and listed newest first: number, saved,
  rows, labels, checks, the model versions that use it, size and hash. Migration 0038 numbered the snapshots that
  existed in the order they were taken; snapshots that had merged feedback became feedback copies with no number.
- Saving a query and saving its version are one step: a query that cannot be saved as a version (over the row limit,
  no rows, a hard-stop check) is refused with the reason and nothing changes. Creating a dataset is refused the same
  way.
- Row limit: 200,000 rows by default (Settings → Data). A larger result is refused with a message to filter or sample
  in the query (`USING SAMPLE reservoir(… ROWS) REPEATABLE (7)`) or raise the limit; the bound is what keeps saving a
  version quick enough to run in the request.
- Splits are derived from the version alone and deterministically (empty and repeated inputs dropped, seeded
  shuffle), so training, evaluation and the gateway's prompt-only context read only the version. Fewer than 100
  usable rows block training and scoring, not saving.
- Data changed: every source has a cheap fingerprint (an upload's content hash; for a folder, a hash of its file
  list with sizes and modification times; for a Delta table, its version and newest log file). A version records
  its sources' fingerprints and the query; the dataset, the model page and the Training page say "Sources changed
  since v3" or "Query changed since v3" and offer Update. Nothing updates on its own.
- Training and scoring pick a dataset version of the model's dataset (`snapshot_id` on `POST
  /api/minibrains/<slug>/versions`), the latest by default; a run never reads the live query. A model's data is its
  dataset's latest version.
- Feedback: a model's accepted feedback rows merge into the picked version when a model version starts, as a
  feedback copy (`base_id` names the dataset version, no number of its own); feedback that changes nothing reuses the
  version itself (see Feedback loop).
- Diff: any two versions compare by input (trimmed): rows added, removed and relabelled, row counts, and the share of
  rows per label, with samples of each. The model page links each model version to the diff against the one before
  it, next to the change in held-out accuracy; a model version's scores say whether its data matches the live one's.
- Retention: dataset versions a model version uses are kept (with the version a used feedback copy starts from), and
  so is each dataset's latest; feedback copies of deleted model versions are removed with their files; of the
  versions no model uses, the last N per dataset stay (Settings → Data, 5 by default). Infrastructure → Storage shows
  how much they use.
- Later, not built: zero-copy versions for Iceberg and Delta tables that pin the table's snapshot id instead of
  copying rows (the version then records the table version, not a file), and an opt-in "update when sources change".
- `HF_DATASETS_CACHE` points at the job directory and is deleted when the job ends.

### Artifact storage

- One location per install, set in Settings → Storage: a local folder under `MINIBRAIN_HOME` (default) or an
  S3-compatible bucket (AWS, MinIO, Ceph) by endpoint, bucket, prefix, region and keys. It is an `ArtifactStore`
  backend over s3fs, so uploads, dataset versions, adapters, logs and base model weights all follow it. Workers and
  engines pull artifacts through main, and base weights in a bucket straight from the bucket (Base models on disk).
- minibrain connects only to the endpoint set there, with explicit keys (no instance-metadata lookups), and signs every
  request with SigV4 (HMAC-SHA256; never SigV2, which is HMAC-SHA1). The secret key is kept in a 0600 file under
  `secrets/` (or `MINIBRAIN_STORAGE_S3_SECRET`) and never returned. "Test connection" writes, reads back and removes a
  probe object; saving S3 runs the same check. Artifacts already stored stay readable after switching either way.
- Both locations hold only ciphertext: main encrypts each artifact with its own data key before it reaches the folder
  or the bucket (client-side), so the bucket's own SSE-KMS is an optional second layer.
- One contract for both, so the folder behaves like a bucket and switching is configuration: an object is addressed by
  the SHA-256 of its plaintext, written once and never changed, and read by id. A bucket write is create-only
  (`If-None-Match: *`); the folder stages in `artifacts/.incoming` and renames into place only when the id is new.
  Nothing depends on a listing, an append or a lock: the `artifacts` table says what exists, and deletes, retention and
  key passes start from it (a key pass also lists the store, only to find strays; a registered object it cannot find
  blocks retiring the key). The one change in place is re-wrapping a key header, which never touches the content or
  its id: the folder rewrites a header slot; the bucket gets a multipart upload whose first part is the new header and
  the first 5 MiB and whose other parts it copies from the old object itself (`UploadPartCopy`, pinned to the old
  ETag), so only 5 MiB travel however large the object (one under 5 MiB is sent again whole). Uploads from workers
  stream into the store, never into memory.
- What under `MINIBRAIN_HOME` is data and what is a cache. Data: `minibrain.db`, `keys/`, `secrets/`, `artifacts/` (the
  folder store) and `models/` (base weights when Storage is the folder). Caches and scratch, safe to wipe while
  minibrain is stopped: `cache/` (unpacked artifacts), `staging/` (DuckDB databases built from uploads, rebuilt from
  the upload), `work/` (job scratch), `gateway/`, `engines/` and `worker/` (copies on serving and batch machines).

### Connections

Storage is where minibrain keeps its own files; a connection is someone else's bucket or database that minibrain reads
from. They have different endpoints and keys, so they are configured apart.

- Settings → Connections: named connections of three kinds. S3-compatible: endpoint, region, bucket (optional; when
  set, paths must be in it), access key, secret key, path-style addressing. PostgreSQL and MySQL: host, port,
  database, user, password, SSL mode. "Test connection" lists the bucket (or the buckets) or the database's tables;
  it works on unsaved changes too.
- Each connection's endpoint must pass the network policy when it is saved, tested and every time it is used; a
  blocked one says which host to add under Allowed hosts.
- Secrets are write-only: encrypted at rest with AES-256-GCM (`cryptography`, through OpenSSL) under their own data
  key, wrapped by the install's master key (see Encryption at rest in `docs/security.md`: `<home>/keys/master.key`,
  the file `MINIBRAIN_MASTER_KEY_FILE` names, Vault Transit, a PKCS#11 HSM or AWS KMS), with the connection's id as
  associated data. The API only says whether a secret is set; Replace
  writes a new one. Create, update and delete are audited (`connection.create`, `connection.update` with the changed
  field names and whether the secret was replaced, `connection.delete`), never with secret values.
- Locked-down installs declare connections in `minibrain.yaml` under `connections:` (a list with `name`, `kind` and
  the fields above), with the secret only as a reference: `secret_env: NAME` or `secret_file: /run/secrets/name`. They
  show as locked ("Set in minibrain.yaml"); a plaintext `password` or `secret_key` there is refused, and a variable or
  file that is missing shows "secret not found". A connection removed from the file goes away, unless a source still
  uses it.
- A connection used by a source cannot be deleted. Sources keep their connection's id, so renaming one is safe.
- Model import uses connections for `s3://` paths: the Import tab picks the first S3 connection whose bucket matches,
  or asks. The job's parameters hold only the connection id; the worker receives the credentials with the claim and
  hands them to the import or repair child in its environment, never on disk. Without a connection, the server's
  environment credentials (`AWS_*`) stay the fallback.

## Training

- The worker claims a job and spawns `accelerate launch train.py <job.json>`. Never inside uvicorn.
- One lock per GPU. Train vs serve contention is a config: dedicated training GPUs, or unload the pool while training.
- On a single GPU the worker runs the steps in order: load the teacher pool → label / generate → unload → train → eval
  → load the adapter into the serving pool.
- Progress: a TRL `TrainerCallback` writes to the jobs table and a log file streamed to the UI.
- Cancel kills the process group. On start, the worker marks orphaned `running` jobs `failed`.
- One default recipe (rank, alpha, learning rate, epochs), assistant-only loss, a small general instruction mix to
  limit forgetting. How it fits in memory is planned per run (Training memory).
- The teacher can be a base model too: LoRA on the large model when prompting gets close but stays inconsistent
  (QLoRA keeps it on one GPU).

### Training memory

Built (2026-11-05). Each run picks how the base fits the memory of the machine that trains it.

- Strategies: LoRA on the base in bf16 (CUDA, ROCm, Intel XPU) or fp32 (Apple MPS, CPU), and QLoRA: the base in
  4-bit NF4 with double quantisation through bitsandbytes, bf16 compute, adapters on every linear layer. Each with or
  without gradient checkpointing (non-reentrant). Micro-batches of 8, 4, 2 or 1 rows with gradient accumulation to an
  effective batch of 16; MPS takes one row at a time. 8-bit optimiser states from bitsandbytes where a worker has it:
  paged AdamW on CUDA, plain 8-bit AdamW on ROCm and XPU; fp32 AdamW otherwise.
- QLoRA runs where the pinned bitsandbytes (0.50.2, the `qlora` extra, installed in the Docker image) ships kernels:
  its Linux x86_64 wheel carries CUDA 11.8–13.2, ROCm 6.4–7.2 and Intel XPU builds, the aarch64 and Windows wheels
  CUDA. Never on Apple silicon or the CPU: there the plan says "QLoRA needs an NVIDIA GPU" whenever QLoRA would have
  fitted. MLX training stays parked (v2).
- Sequence length: the longest training example, rounded up to 16 tokens and capped by the base's context from the
  catalogue. The plan estimates it from characters (four a token plus 48 for the prompt); the worker tokenises the
  rows the way TRL does and fits it exactly.
- Peak memory per option: base weights (parameters from the catalogue's `shape`: hidden size, layers, vocabulary,
  heads, MLP width, tied embeddings; NF4 with bf16 embeddings for QLoRA), adapter with gradients and optimiser states,
  activations per token and layer (every layer, or each layer's input plus one layer with checkpointing), logits
  (vocabulary × tokens × 12 bytes for the fp32 loss), a fixed runtime overhead and 10% fragmentation. Imported bases
  take their shape from `config.json`; a base with neither gets one guessed from its size.
- Choice: the fastest option whose peak stays under 85% of the machine's memory (the largest single GPU, GPU-usable
  unified memory on Apple silicon, RAM on the CPU). Speed is relative: QLoRA ×0.7, checkpointing ×0.75, smaller
  micro-batches slower. The machine is the online worker with the fastest plan, from the hardware and libraries
  workers report (`bitsandbytes` among them); with none reported the plan is unknown and the worker that takes the job
  plans on its own.
- Nothing fits: `POST /api/minibrains/{slug}/versions` refuses up front (409) with the smallest plan, its memory and
  the machine's ("Qwen3 14B does not fit for training on L4: the smallest plan, LoRA bf16 with checkpointing at 1 row
  of 160 tokens, needs about 30 GB, …").
- Overrides on the Training page and in that call: strategy, gradient checkpointing, micro-batch, sequence length,
  LoRA rank (up to 64, the SGLang pools' limit; alpha is twice the rank), learning rate, epochs and rows, each field
  showing its default. `GET /api/minibrains/{slug}/training-plan` takes the same settings and returns the plan, every
  option's memory with its parts, and the defaults.
- The version's recipe stores the plan (strategy, checkpointing, micro-batch, accumulation, sequence length, rank,
  alpha, learning rate, dropout, optimiser, precision, device, the overrides, and the planned peak against the
  machine's memory), so a run is reproducible. The worker keeps it when it fits its machine, plans again what was not
  overridden when it does not, and fails with the refusal when overrides no longer fit. The summary records what ran,
  the measured peak memory and how many examples were longer than the sequence length.
- Evaluation scores the adapter on the full-precision base, the way serving runs it, whatever trained it.
- Discover, Add model and the base picker show Memory to run and Memory to train (QLoRA): QLoRA 4-bit with
  checkpointing on an NVIDIA GPU, one 512-token row at a time, with "Trains here" when a worker in the pool can train
  it. Runs here stays about serving.
- Measured on an M1 Pro (`docs/findings.md`); QLoRA and the CUDA estimates have not run on an NVIDIA GPU yet.

### Base model registry

- Short allowlist with the license recorded (Qwen, Mistral: Apache-2.0; Llama, Gemma: custom terms).
- Model and tokenizer pinned to an HF commit hash; every adapter records it.
- One base model per pool. Adapter rank ≤ pool `max_lora_rank`; target modules match the pool.
- Chat template parity test per base model: the prompt rendered at training time equals the one rendered at serving
  time.

### Base model health

Every install (download, import) saves a SHA-256 list of its files: the hub's LFS hashes where published, a local hash
otherwise. It is stored on the model and as `minibrain-model.json` in its folder. The base's content hash is the
SHA-256 of that list. Health handling never deletes anything: a repair writes to `.part` files and replaces a file only
once it matches; only deleting a base removes its files.

| Failure | Detected by | State | Primary action |
|---|---|---|---|
| Corrupt files | "Verify files": a job that re-hashes every file, with progress, log and cancel | Corrupt (n files) | Repair: re-download only the bad files; Re-import when the hub is unreachable or the model has no hub source |
| Missing files | Size check at start-up, on every list, before load, deploy and train | Missing files | Repair, Point to new location (checked against the saved list, then verified), Remove |
| Interrupted download | Failed or cancelled transfer job; `.part` files resume with HTTP ranges | Download failed | Resume (keeps complete files) |
| Disk full | Free space checked in the job before writing; `ENOSPC` while writing | Not enough space | Free up space (Infrastructure → Storage), then Try again |
| Access revoked, token expired | 401 or 403 from the hub | Needs access | Get access (the gated-model steps), then Retry |
| Upstream revision gone | 404 on the pinned revision | Can't repair from source | Re-import; the local copy stays usable if it verifies |
| Runtime missing or not supported | Engine load error reported to main; GGUF with no llama.cpp in any pool | Can't run here | The reason with what to install, or another variant |
| Not enough memory | Out of memory while loading | Failed to start | A smaller or quantized catalogue variant |
| Adapter vs base mismatch | Each LoRA version records the base's content hash when training starts | Base changed | Refused at the gateway, the engine and deploy; train again |

- Repair and Re-import are one job kind (`repair`) that reads from the hub at the pinned revision, a folder or an S3
  path, and accepts only files matching the saved list; a copy with different files is refused ("import it as a new
  model"), so adapters keep their base.
- Failure codes travel with the job (`needs_access`, `source_gone`, `no_space`, `offline`); engines report load
  failures (`cant_run`, `no_memory`) to main, which records them on the model until "Try again".
- A base with any of these problems is not started by the gateway; requests get a 503 with the reason. Custom models
  and deployments on it show "Base …" with a link to the base.
- Audit events: `model.verify`, `model.repair`, `model.reimport`, `model.relocate`. Deleting a relocated model keeps
  its external folder.
- UI: the state is the Models list status cell, the primary action is the row button, the rest are in the row menu.
  The model page's Files section lists each file with size and hash state, the last verified time and "Verify files".

### Base models on disk

- A base stays until someone deletes it, and deleting it removes its files. A base with models built on it is deleted
  together with them, once the cascade checkbox in the delete dialog is ticked.
- Rows an earlier cache budget left in status `evicted` keep "Removed to free space" with Download again or Re-import
  (the repair job, checked against the saved SHA-256 list).
- Where a base's main copy lives follows Settings → Storage when it is downloaded, imported, repaired or downloaded
  again (`models.store`, migration 0039). Folder: main's `<home>/models/<id>`, as before. S3: each file is an object in
  the bucket under its SHA-256, sealed with its own data key like every artifact and registered as a `weights`
  artifact; identical files are stored once.
- Files reach the bucket one at a time. The job checks a file's size and SHA-256 in `<home>/work/models/<id>`, the
  worker streams it to main, main seals and uploads it (create-only) and the staged file goes, so main's disk needs
  about twice the largest file free: the download check and the Add model gauge use that. A resumed job skips files
  already in the bucket.
- Every machine that runs a base keeps a working copy, because engines need local files: main (its local engines and
  its worker share `<home>/models/<id>`), remote engines (`<home>/engines/<key>/weights`) and remote workers
  (`<home>/worker/models/<key>`). It is made when an engine starts or a training or eval job needs it. Each file is
  checked against the saved list as it arrives (size and SHA-256) and lands under a temporary name; the folder's
  `minibrain-model.json` records the content hash it holds. A copy whose content hash no longer matches is replaced; a
  missing or short file is fetched again. Remote machines get each file's size and SHA-256 from the saved list, never
  from a folder listing.
- Machines fetch from the bucket, not through main, and never hold bucket keys. main answers
  `/internal/gateway/bases/<key>` (gateway token) and `/internal/worker/bases/<key>` (worker token) with a presigned
  GET link per file, SigV4 and valid 15 minutes, for the configured endpoint only, plus the file's data key, which main
  unwraps with the master key; the answer is `Cache-Control: no-store`. The machine decrypts with AES-256-GCM through
  `cryptography`, checks the plaintext SHA-256 and keeps the data key in memory only. A data key opens that one object;
  the node channel carried the plaintext itself before.
- Working copies are not the removed cache: no budget, no pins, nothing removed to free space, and the bucket is the
  copy that counts. The Models list and health read the database (an `artifacts` row per file), never a working copy,
  so a model does not go missing with one. Verify files reads every object through signed links; Repair writes a
  damaged object again.
- Deleting a base deletes its bucket objects (unless another model has the same file), main's working copy and its
  rows. Remote engines and workers remove copies of models main no longer has when they start and every 10 minutes.
- Switching Storage to S3 leaves bases on main's disk usable, served from main as before; a base moves to the bucket
  only when it is downloaded, imported or repaired again. A base in the bucket stays there if Storage goes back to the
  folder, while the bucket settings remain.
- Free space: S3 reports none. The Add model gauge names its store ("S3 · <bucket>" or "Main server disk"); for S3 it
  shows the model's size and main's free disk instead of a fill level.

### Deleting and undeploying

- Deleting a custom or base model and undeploying one are teardowns: a row in `teardowns` (one per model) that a loop on
  the leader main advances, so they survive a restart and run however small or large the model is. Not jobs: workers
  never touch the database or the artifact store, and only main can remove rows and files. The API stores the teardown
  and answers 202 with the new state at once.
- States on the Models table, the model pages and Deployments: Deleting (row greyed, actions off, gone when done),
  Delete failed, Stopping and Stop failed, each failure with its reason and a Retry that repeats the same call. Toasts
  come from a watcher in the shell, so they show on whichever page the person is on.
- Stopping waits until every live gateway (main's own and standalone ones, which report what they route) has stopped
  routing the model's names and every engine of its base has drained its requests in flight through those names and
  unloaded its adapters. A base no route needs any more is released: main stops its local engines once they are idle.
  Ten minutes without that is Stop failed, naming what did not confirm.
- Deleting a deployed model needs `undeploy=true`; it stops first, then removes versions, adapters, snapshots only it
  uses, the minibrain folder and API key scopes. A base with models built on it answers 409 with their names unless
  the call says `cascade=true`; the cascade deletes them first, then the base.
- Audit: `model.delete` and `model.undeploy` when a person starts one (`retry` on a retry), and `model.delete_finished`
  and `model.undeploy_finished` with the outcome, what went and the reason a failure gives.

## Eval and promote

- Eval first: the golden set (20–50 human-verified examples) is written or picked before any training.
- Version 0 is prompt-only on the teacher: the task type's prompt plus few-shot examples. It is usable minutes after
  the minibrain is created.
- Few-shot examples never come from the golden set, which must stay unseen: they come from other labelled rows, or,
  when the golden set is all there is, a few of its rows move out of it and stop being scored.
- If version 0 meets `target.min_score` and its latency and cost are acceptable, the UI says no training is needed.
  Otherwise the report shows the gap a trained version has to close.
- Every version runs on the golden set and the held-out split: base, teacher and adapter on the same examples, scored
  with the task type's metric.
- Eval decodes the way serving does: a Classify answer is held to the label set, so the score is what apps get and
  "not a label" only counts answers cut off by the token limit.
- Reported per model: score, p50 / p95 latency, cost per 1,000 requests (GPU time for local models, list price for API
  teachers). The headline reads like "base 54% → minibrain 91% at 1/20 of the teacher's cost".
- Local cost: the eval job times the device per batch of 8 held-out rows and records GPU-seconds, requests, tokens in
  and out, the device and the worker's pool (`metrics.cost`, source `device_time`). Cost per 1,000 requests is that
  time × the pool's price per hour from Settings → General → Compute prices (one currency per install, audited as
  `settings.prices`). With no price it shows the GPU time instead; prices are never looked up online. An API teacher
  will record source `list_price` with its token counts.
- Deploy at any step. A custom model can be deployed the moment it exists: with no version yet it serves its base model.
  Any ready version can then be deployed, scored or not, whatever its score; scores inform the choice and never block
  it. Training or scoring never changes what is live.
- Side-by-side review screen. The golden set alone is too small to decide: in the spike, one of 50 rows moved the
  score 2 points and golden and held-out scores differed by 8–11 points.
- Deploying a version moves `current` and loads its adapter into the pool. Rollback deploys an earlier version.

### Rebase

1. A new base model is registered (offline bundle, pinned commit). Its chat template parity test runs first.
2. `minibrain rebase --base <model>`, or one button, reruns every minibrain: training from the stored dataset version
   (relabelled first if the teacher changed), then eval on the golden set.
3. The report compares each rebased version with `current` on score, latency and cost.
4. Deploying stays per minibrain and explicit. Nothing that is live changes until someone deploys.

### Feedback loop

1. `POST /v1/feedback` with an API key: `model`, `response_id` (the chat completion's `id`), `rating` (`up` or
   `down`), and optionally `correction` (the right answer, with `down` only) and `comment`. The key must cover the
   model; base models take no feedback. When the model does not keep request inputs and answers, the call carries
   `input` too (and optionally `output`, the answer the app got), and a call without it gets a 422 that names the
   model's switch; otherwise the response id is enough. A second call on the same
   response while it waits for review updates it. The standalone gateway forwards the call to main. Playground thumbs
   and "Correct it" store the same record through `/api/minibrains/<slug>/feedback`.
2. Request logs always carry each response id. "Keep request inputs and answers", a per-model switch on the model's
   deployment page (off by default; see API and access), also keeps the last user message and the answer, for as long
   as the logs. Feedback is stored per model and version and links to its request log by response id.
3. Feedback lands in the review queue (the Feedback page): accept the suggested answer (the correction, or the model's
   own answer for a thumbs-up), fix and accept with another answer, or reject. Disagreement comes first (feedback on
   the same input, ignoring case and spacing, that suggests different answers), then thumbs-down with no answer, then
   the rest, newest first. Assignment is "Assign to me"; every review and assignment is audited.
4. Accepted feedback becomes the model's feedback rows: input and accepted answer, the latest review winning per input.
   When a model version starts, they merge into the dataset version it trains on: a row with the same trimmed input
   is replaced, a new input is added, and a row the dataset already agrees with changes nothing. The result is a
   feedback copy of that dataset version that records how many rows feedback added or relabelled (the model card
   shows "Version 3, plus N rows from feedback"); dataset versions themselves never hold feedback, so models that
   share a dataset do not see each other's. Feedback rows fall into the derived splits like any
   other row; sending the worst failures to the golden set waits for golden set authoring.
5. The model page and the Training page show "Feedback since vN: total (accepted)" and the reviews still waiting;
   "Train with feedback" trains a new version with the last trained version's recipe.

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
- `ServingBackend` interface: `load(model)`, `complete(request)`, `status()`. Implementations: `sglang`
  (production), `mlx` (Apple silicon, PEFT LoRA converted on load), `transformers` (fallback and tests), `llamacpp`
  (GGUF base models), `vllm` (v2).
- Engines are never exposed; the gateway proxies every call.

## API and access

- `/v1/chat/completions` with streaming, `/v1/models`.
- `response_format` (`json_object`, `json_schema`) passed through and the answer checked against the schema;
  Classify minibrains hold decoding to their labels by default, Extract minibrains will set their schema.
- Upstream routes: the gateway forwards a model name to the teacher (local by default, an API only by opt-in) and
  logs the calls. Apps switch to the minibrain by changing the model name.
- Private frontier endpoint: the teacher model exposed by name through the gateway, with scoped keys, audit and
  logging like any minibrain.
- `POST /v1/feedback` (see Feedback loop).
- `model: "support-triage"` → current version; `"support-triage@3"` → pinned. The gateway maps it to SGLang's
  `<base>:<adapter>` name.
- API keys cover one or more models; a call to a model the key does not cover gets 403. Keys are managed on
  Deployments and on each endpoint. Audit log: who created, changed or revoked which key, when.
- Request metadata is logged for every `/v1` call: time, model, version, key, status, latency, tokens, finish reason
  and response id, never content. Monitor, Overview, cost and the Requests tab depend on it, so it cannot be turned
  off; log retention deletes it.
- Request inputs and answers (the last user message and the model's answer) are kept per model: "Keep request inputs
  and answers" on the model's deployment page, off by default, changed by Builders and audited as
  `model.request_bodies` (before and after). They feed feedback by response id, distillation and the Requests tab, and
  are deleted with the request logs. The install-wide "Request inputs and answers" policy is the default for new models
  and for base models served through `/v1`; an admin can lock it for every model ("Lock for every model" under
  Settings → Security, or `request_bodies` in `minibrain.yaml` or the environment), and then each model's switch shows
  the locked value and cannot be changed. Gateways, standalone ones included, get each model's value in their config
  snapshot. Migration 0034 turned it on for existing models only where the install kept inputs and answers before.
- A context step between auth and the model call retrieves from the minibrain's index (see Retrieval).
- Citations come back in an extra `citations` field on the response.
- Login in v1: local accounts, OIDC (Entra, Okta, ADFS, Keycloak), and trusted headers from a reverse proxy. SAML
  reaches minibrain through the customer's identity provider or a broker (Keycloak); CAC / PIV through the proxy's
  client-certificate check. Proxy headers are trusted only from configured proxy addresses.
- Harness config export: base URL, key and model name for common harnesses.
- API reference (`/developers`): Scalar, bundled into the web build and loaded as its own chunk, with its telemetry,
  fonts, request proxy, agent, MCP, developer tools, SDK generation and client.scalar.com links off, so the page makes
  no call outside the install. Two documents cut from main's schema, for any role: `GET /api/openapi/v1.json` (the
  gateway, with `/v1` as its server and the bearer key scheme) and `GET /api/openapi/api.json` (every `/api` route
  with the role it needs, and the CSRF header on changes). The page fills in this install's base URL and deployed
  model names, and curl, Python and JavaScript samples (the `openai` SDK for `/v1`). Try it: `/v1` with a key pasted
  into the page, kept in memory and never sent to main; `/api` with the signed-in session, the page adding the CSRF
  token to same-origin `/api` calls only, so a call runs with the person's role and is audited like the same change in
  the UI. FastAPI's `/docs`, `/redoc` and `/openapi.json` are off on main, gateways and engines (404), and the schema
  carries the package version; `minibrain openapi` still prints the whole schema for generated clients.

### Accounts and roles

Built, with the details in `docs/security.md`; OIDC is tested against an in-process fake provider and proxy headers
against test clients, not yet against Entra, Okta, ADFS, Keycloak or a real proxy. People sign in; apps keep using API
keys, and `/v1` stays key-only.

- Sign-in sources, any mix: local accounts, OIDC (authorization code with PKCE; Entra, Okta, ADFS, Keycloak) and
  trusted proxy headers (user, email and groups headers, honoured only from configured proxy addresses).
- Accounts are always on, loopback included; there is no single-user mode. Audit actors are always people; workers,
  engines and `/v1` keep their tokens and API keys.
- First admin, any of: a one-time setup link that `minibrain serve` prints on the first start with no accounts (and
  opens in the browser on a desktop; token from `secrets`, stored as its SHA-256 so it survives restarts until used;
  `minibrain admin setup-link` prints a new one); `MINIBRAIN_ADMIN_EMAIL` plus `MINIBRAIN_ADMIN_PASSWORD_FILE` for
  automated deploys, read on the first start only; or single sign-on with a group mapped to admin, which issues no
  link. Recovery: `minibrain admin create` and `minibrain admin reset-password`. Air-gapped installs need no identity
  provider.
- Passwords: PBKDF2-HMAC-SHA256 through `cryptography` (FIPS-approved; not argon2 or scrypt). OIDC through Authlib,
  which uses `cryptography` for its tokens.
- Sessions: a server-side row per session holding the SHA-256 of its token; an HttpOnly, SameSite=Lax cookie,
  Secure except on plain HTTP loopback (Safari drops Secure cookies on `http://localhost`); idle and absolute
  lifetimes as policies; a CSRF token on every state-changing `/api` call. Signing out or disabling an account ends
  its sessions at once.
- Roles are install-wide in v1. Per-model and per-team rights arrive with Teams in v2.

| Can | Viewer | Builder | Admin |
|---|---|---|---|
| See models, versions, scores, deployments, Monitor and Infrastructure | Yes | Yes | Yes |
| Use the Playground | Yes | Yes | Yes |
| See data rows: previews, golden sets, mistakes | No | Yes | Yes |
| Upload data, edit mappings, add, train and evaluate models, label | No | Yes | Yes |
| Deploy, undeploy, roll back; create and revoke API keys | No | Yes | Yes |
| Download, import and delete base models | No | No | Yes |
| Security policies, install settings, worker and engine tokens | No | No | Yes |
| Accounts, role mapping, audit log | No | No | Yes |

- Role mapping: identity-provider groups (the OIDC `groups` claim or the proxy groups header) map to roles in
  `minibrain.yaml` (`auth.roles: {minibrain-admins: admin, ml-team: builder}`); values set there are locked in the UI,
  like policies. A person with no mapped group gets the `auth.default_role` policy: none by default, so they see "Ask
  an admin for access" until an admin assigns a role.
- Enforcement is in the backend: one dependency per route states the role it needs, and a test lists every `/api`
  route with its role so a new route cannot ship unguarded. The UI hides what a role cannot do, but never decides.
- Audit events record the person and how they signed in (local, OIDC, proxy). API keys record who created them. Events
  already record the client address of the connection; a forwarded address will count only from configured proxy
  addresses.
- UI: a sign-in page; Settings → Accounts for admins (people, role, sign-in source, last sign-in, disable, reset a
  local password with a one-time link shown once); the user menu shows the person and Sign out.
- Tables: `users` (email, name, source, subject, role, disabled, password hash for local accounts, last sign-in) and
  `sessions` (user, token hash, created, last seen, expiry, address, user agent).

## UI

- obp-ui, operator-console style.
- Sidebar: Home · Explore (Models, Discover, Playground) · Create (Data, Training, Evaluations, Feedback) · Run
  (Deployments, Pipelines, Batch jobs in v2, Infrastructure, Monitor) · user menu (Settings, API reference, Theme,
  Sign out). Sidebar links are plain paths; no page carries a model into another.
- Training, Evaluations and Feedback cover every model, like Deployments and Monitor. Training and Evaluations are the
  kit's `DataGrid` with model and status filters kept in the URL: `?model=<slug>,<slug>&status=<status>,<status>`.
  - Training lists training and scoring jobs: model, version, job, status, progress, started, duration. A row opens
    the job's log (`?job=<id>`). "Train a model" picks a model and opens `/training/<slug>`: its training data
    (picking a dataset saves its first version if it has none), new version (the dataset version to use, latest by
    default, then score a prompt or train) and recent jobs.
  - Evaluations lists every version: model, version, kind, held-out accuracy, change against the live version, created,
    status. A row opens its scores and held-out mistakes (`?version=<slug>@<n>`); Deploy sits on the row and in that
    view.
  - Feedback is the review queue across models: input, the model's answer, the suggested answer, status (To
    review, Accepted, Rejected) and model, paged on the server and filtered by model, status and assignee
    (`?model=<slug>&status=pending&assignee=me`), disagreement first. A row opens its review screen
    (`?item=<id>`): the input, the model's answer, the suggestion, other feedback on the same input and a
    right-answer box with the known answers; Accept (A), Fix and accept (F, or Enter in the box), Reject (R),
    Next and Previous (J, K), Esc back to the list, Assign to me. The keys show on the buttons.
- Monitor has three tabs: Overview (`/monitor`), Jobs (`/monitor/jobs`) and Requests (`/monitor/requests`), every
  `/v1` call as it arrives. Overview charts the request logs for a time range and models
  (`?range=&model=<slug>,<slug>`): requests per minute (stacked), error rate, p50 or p95 latency and tokens in or out,
  one series per model for the five busiest and "Other models" for the rest, in buckets sized to the range (about 60;
  15 seconds for 15 minutes, 30 minutes for a day), aggregated in SQL that runs on SQLite and Postgres
  (`/api/requests/overview`). The Requests summary sits above, a per-model table below (requests, error rate, p50,
  p95, tokens, last request; a row opens Requests for that model), refreshed every 10 seconds unless paused. Requests
  is the kit's `DataGrid`, paged on the server by request id: time, model@version, key, status, latency, tokens in and
  out, finish reason, response id and a feedback mark. New rows join the top every 3 seconds (Pause stops that) and
  leave a scrolled reader in place. Model, version, key, status (OK, 4xx, 5xx), a response id search and a time range
  (`?model=&version=<slug>@<n>&key=&status=&q=&range=`) filter the list and the summary above it: requests, error
  rate, p50 / p95 latency, tokens in and out. A row opens its detail (`?request=<id>`): the metadata, the key's name,
  the kept input and answer for Builders and Admins (Viewers see that it needs the Builder role; when the model does
  not keep them, "Not kept for this model", with a link to its switch for Builders) and the feedback on its response
  id.
- API reference: two `TabNav` pages, OpenAI-compatible API (`/developers`) and Management API
  (`/developers/management`), each a Scalar reference themed from the obp-ui tokens (Cobalt, light and dark, the
  kit's sans and mono). Create a key (Builders) links to Deployments; the user menu, Connect on Deployments and a base
  model's API link to it, and the copy-paste harness configs stay where they are.
- Playground chats with one model at a time: a picker in the page, `?model=<slug>` for links, the last pick remembered
  in the browser.
- Add model (`/models/new`) asks for the task first, then the base model from one picker (the kit's
  `TabbedSearchList` in a dialog): one search over four tabs. Only Classify can be picked today; the other tasks are
  listed under Coming and cannot be chosen.
  - Recommended: recently used bases, then 2–3 that run on this machine and 1–2 that need more compute, ranked by fit
    for the task (capability, size tier, the catalogue's tested default; superseded models left out), then
    popularity. Being downloaded is not a ranking factor.
  - Catalogue: every entry, with size, fit and licence-use filters. My models: start from a custom model (same base,
    its training data, and its trained version's rows and epochs, carried to the Training page as `?rows=&epochs=`),
    or an imported base. Import: a Hugging Face id or link, an `s3://` path or a folder.
  - Each option shows publisher, parameters, licence use, "On this install" or the download size, and a fit hint.
  - Logos: a base model shows its publisher's logo (a letter tile when the publisher is unknown); a custom model
    always shows a letter tile from its own name, with its base named in text, on every page.
  - Under the picker: the download against free space on the model files disk (blocked when it does not fit), the
    variant and licence, and for a base that needs more compute, the pools it fits and how to join a GPU machine to a
    pool. It can always be downloaded now and run later.
  - `?model=<catalogue id>&variant=` and `?base=<key>` preselect the base, `?dataset=` the training data, and
    `?source=import` opens Import.
- Old links redirect: `?minibrain=<slug>` on Training, Evaluations and Playground becomes `?model=<slug>`;
  `/deployments?minibrain=<slug>` goes to `/deployments/<slug>`; `/m/<slug>/<tab>` goes to the matching page.
- Settings replaces the sidebar with its own: Back (the last page outside Settings, else Home), then its sections.
  General: You (appearance; profile once accounts exist), the model catalogue, recipe and splits. Security: the
  policies, locked when set by config, with a link to their changes in the audit log. Accounts (admin) once accounts
  exist. Install settings and the audit log become admin-only with accounts.
- Settings → Audit log: every audited change in the kit's `DataGrid`, newest first: time, actor and client address,
  action, target and a details summary. Search, action, actor and a date range (`?q=&action=&actor=&from=&to=`, local
  days) stay in the URL; paging is server-side by event id (`?before=<id>`, `?after=<id>`), so history size does not
  matter. A row opens the full event as fields with before and after values (`?event=<id>`). Export downloads CSV or
  JSONL of the current filter from `/api/audit/export`, with each event's `seq`, `prev_hash` and `hash`. Retention
  is the `audit_retention_days` policy: keep forever by default; the hourly purge deletes older sealed events up to a
  chain anchor and records an `audit.prune` event with the `seq` and hash it cuts at. Integrity shows whether the hash
  chain verifies, or its first break, and whether SIEM export (set under Security) is keeping up, with Verify again.
- Settings → This install, read only: minibrain version and build commit, Python, DuckDB, PyTorch, Transformers, OS
  and architecture; home, database (location and size), artifact storage (folder, or bucket and endpoint; never
  credentials) and the web build; catalogue version and when catalogue and model files were last checked; pools,
  machines, workers and engines online; outbound access and which endpoints the network policy allows. "Download
  diagnostics" is a plain link to `/api/system/diagnostics`: a zip of versions, settings, policies, job counts and
  recent server warnings, with every known secret value scrubbed and secret-named fields redacted.
- Panels are the kit's `Card`; a table sits edge to edge in its panel.
- Data is an explorer: a resizable, searchable tree (the kit's `Tree`) on the left with two sections, Datasets and
  Sources; the selected item's detail on the right. Sources holds one group per kind (Uploads, Folders, S3, Databases,
  Lakehouse), shown only once it has a source; an empty Sources points to Add source, and a link to an empty group
  opens Sources. Lakehouse holds Iceberg and Delta Lake tables, each with its format's `FileTypeIcon` and a format
  badge (`group:iceberg` links open it). One "Add source" menu: Upload a file, Connect a folder, S3 path, Database
  table or query, Lakehouse table (Iceberg, Delta Lake; the dialog picks the format first), and the samples. A source
  shows its table name, columns, stats, first rows and the datasets that read it; a folder also shows its file count,
  size and last change; a connected source shows its connection, path, table or query, and
  how its changes are tracked.
  A dataset shows the sources it reads, its query (Columns or SQL mode, the table names beside the SQL editor), a live
  preview, label balance, splits, its versions (tick two to compare), the models that use it, Update when its sources
  or query changed since the latest version, and "Train a model". Every item shows its sources → dataset → models trail. `/data?item=<kind>:<id>`
  (`group:datasets`, `group:sources`, `group:upload`, `folder:3`, `source:12`, `dataset:<slug>`, plus
  `&compare=<id>~<id>` for a version diff) is the permalink; `/data/datasets/<slug>` redirects to it.
- Dataset folders (`dataset_folders`, `datasets.folder_id`) only organise; nothing a model trains on depends on them.
  They nest, sort before datasets (both by name), and a folder name is unique among its sibling folders and a dataset
  name among the datasets beside it, case aside. Every dialog that names or renames a folder, dataset or source (New
  folder, Rename, Edit, New dataset, Make a dataset, Add source) checks the name as it is typed, says which item holds
  it and keeps the button off, and a suggested name is already free; Move to… and drag and drop refuse a folder where
  the name is taken. New folder sits
  on Datasets and on every folder; a folder shows its contents with counts, and Rename, Move to… and Delete. Rows move
  by drag and drop in the tree (the kit's `Tree` with `onMove`), or from the keyboard with "Move to…", a dialog with a
  folder picker; a folder cannot move into itself or below itself. Deleting a folder moves its datasets and
  subfolders up one level (a clashing name gets a number, `Billing (2)`) and deletes nothing else. Search still finds
  datasets inside folders and opens their path. Create, rename, move and delete are audited (`dataset_folder.*`), and
  so is a dataset changing folder (`dataset.move`).
- Settings → Data: most rows in one version, how many unused versions stay per dataset, and the version checks with
  their limits. Settings → Storage: where artifacts live.
- Settings → Connections: the buckets and databases that sources and imports read (see Connections), with each
  one's address, secret state, sources and test, and which DuckDB extensions are installed.

| Need | obp-ui |
|---|---|
| Sidebar | `shell`: `AppShell`, `Rail`, `NavItem`, `SectionLabel`, `AccountMenu` |
| Status | `Badge`: queued `neutral`, training `info`, ready `approval`, live `success`, failed `destructive` |
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

One `minibrain.yaml` per minibrain: task type, source, SQL, steps, teacher, recipe, golden set, target score.
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
target:
  min_score: 0.85
```


## Config file

Done (2026-11-05). One `minibrain.yaml` per install, apart from the per-minibrain file above: everything an admin sets
in the UI can be provisioned from it, so a locked-down or GitOps install starts fully configured with no clicks.

- Sections: `policy`, `auth` (with `admins`, roles by group, proxy, OIDC), `logging`, `metrics`, `storage`, `data`,
  `compute` (currency and prices by pool), `catalogue` and `connections`. Pools and machines stay runtime: they join
  with `--pool`.
- Set in the file or by `MINIBRAIN_<SECTION>_<KEY>` means locked in the UI; the API refuses the change with 409.
- Secrets are named, never written: `secret_env` or `secret_file`. A secret in the file stops the start.
- main validates the file at startup and names the key; unknown keys are warnings.
- `minibrain config export` prints the effective settings in the same format without secrets, and round-trips.
- Next: hot reload on file change, and a JSON Schema for editors.

## Observability

Off by default, and only ever towards systems the customer runs. Details: `docs/observability.md`.

- OpenTelemetry: OTLP over HTTP (protobuf; no gRPC) to the customer's collector, set as admin policies (endpoint,
  headers encrypted and write-only, protocol, service name, CA bundle) that `minibrain.yaml` and the standard
  `OTEL_EXPORTER_OTLP_*` variables lock. The collector is reached whatever the network policy, like the SIEM, and
  nothing else: no proxy variables, no redirects. Standalone gateways read the same settings from their own
  `minibrain.yaml` and environment.
- One SERVER span per `/v1` request on the GenAI semantic conventions (`gen_ai.operation.name`,
  `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.usage.input_tokens` and
  `output_tokens`, `gen_ai.response.finish_reasons`, `server.address`, `error.type`) plus `minibrain.model.slug`,
  `minibrain.model.version` and `minibrain.api_key.id`, joined to the caller's trace by `traceparent`. Never a prompt
  or an answer.
- Metrics: `gen_ai.client.operation.duration` and `gen_ai.client.token.usage` histograms, `minibrain.gateway.requests`
  by route, status and model, `minibrain.jobs.queued` by kind, `minibrain.jobs.queued.oldest_age` and
  `minibrain.workers.online` by pool. Unknown models count as `_unknown`, so callers cannot grow the series.
- Prometheus: `/metrics` in text format with the same metrics, answering only once `metrics.addresses` or a scrape
  token (`metrics.token_file`, `MINIBRAIN_METRICS_TOKEN`) is set, like the trusted proxy addresses; no user session.
- Logs: `MINIBRAIN_LOG_FORMAT=json` (or `logging.format`) writes one JSON line per event with level, logger, message,
  request id and response id; plain text stays the default. Every response carries `X-Request-ID`.
- A Grafana dashboard over the Prometheus metrics ships in `docs/grafana/minibrain.json`.

## Offline

Fully offline by default. Nothing in the data, labelling, training, serving or gateway path calls out.

- Teacher: a larger open model on local GPUs. An API teacher is opt-in per install and off by default; the UI marks
  every minibrain whose data went to one.
- Model weights: downloaded on a connected machine, pinned to a commit (`hf download <repo> --revision <sha>`), copied
  in by disk or an internal mirror, registered by local path. `HF_HUB_OFFLINE=1` everywhere.
- Install bundle: Docker images, Python wheels, Presidio's spaCy model, the frontend build. Nothing downloads at install
  or run time.
- No telemetry. OpenTelemetry export is opt-in and goes only to the customer's collector (see Observability).
- DuckDB extensions: S3, database, Iceberg and Delta Lake sources need httpfs, postgres_scanner, mysql_scanner,
  iceberg, avro and delta. DuckDB downloads extensions from the internet by default; minibrain never lets it
  (`autoinstall_known_extensions` and `autoload_known_extensions` off on every connection) and loads them only from its
  own extension directory (`<home>/duckdb/extensions`, or `MINIBRAIN_DUCKDB_EXTENSIONS`). They are not in git or the
  wheel: the image's set is 85 MB compressed on linux_amd64 for DuckDB v2.0.0, 30.5 MB of it delta (78 and 28.3 MB on
  linux_arm64). Vendoring: on a connected machine,
  `minibrain extensions download --to ./duckdb-extensions --platform linux_amd64 --platform linux_arm64` saves
  DuckDB's repository layout (`<version>/<platform>/<name>.duckdb_extension.gz`) for the installed DuckDB version; the
  folder goes into the install bundle or the image (`MINIBRAIN_DUCKDB_EXTENSION_REPOSITORY` pointing at it), and
  `minibrain extensions install --from <folder or internal mirror URL>` installs it. A missing extension is installed
  from that local folder on first use; never from a URL at run time. DuckDB still checks each extension's signature
  when loading it. Updating DuckDB means downloading the set for the new version (paths are versioned, so both can
  sit side by side). `minibrain extensions` and Settings → Connections show what is installed, and a source that needs
  a missing extension names it and the install command.
- Air-gap test in CI: the M1 flow runs in a container with networking disabled.
- Updates: signed bundles for the app and for new base models, carried across the gap by disk. Verified offline before
  install; the previous version stays installed for rollback. Bundles reuse the release's blob signing: one
  `.sigstore.json` per bundle, checked offline with Sigstore's trusted root.

## Security and accreditation

v1, the evidence regulated buyers ask for first:

- SBOM (CycloneDX) for every image and Python dependency set. Built: CI uploads Python (uv export from `uv.lock`)
  and web (syft from `web/pnpm-lock.yaml`) SBOMs beside the wheel; each release adds an SBOM per image (syft against
  the image it pushes), attached to the release and attested on the image. Details: `docs/security.md`.
- AI bill of materials per version: base model weights hash, license, training data snapshot hash, recipe, eval result.
  Built: a deterministic CycloneDX 1.6 ML-BOM per version (`aibom.json`, Download AI-BOM on the model card) with
  the adapter's SHA-256, the sources' fingerprints and its own SHA-256, validated against the schema in tests.
- Signed images and update bundles (cosign), verified offline. Built for releases: keyless Sigstore signing from the
  release workflow (OIDC identity, Rekor; no long-lived key), a `.sigstore.json` bundle per release file, signatures
  on every image digest, SBOM attestations and SLSA provenance (`actions/attest`). Offline checks use the bundle and
  Sigstore's trusted root carried across, not a shipped key. Update bundles not yet. Details: `docs/releasing.md`.
- Audit log: append-only and hash-chained so tampering shows, exported to the customer's SIEM over syslog. The
  chain has to survive retention: a prune is itself an audited event that carries the hash it cuts at. Built: the
  leader seals each event with a sequence number, the previous hash and the SHA-256 of its canonical form (so
  out-of-order commits on Postgres just seal later); `minibrain audit verify`, `GET /api/audit/chain` and the Audit log
  page report the first break; SIEM export is RFC 5424 over TLS, TCP or UDP with a stored cursor. Format, canonical
  form and guarantees: `docs/security.md`.
- Encryption at rest for snapshots, staging files and adapters. Built: every stored file (uploads, snapshots,
  adapters, logs, staging databases, base weights in a bucket; local folder or S3 bucket) is sealed with its own
  AES-256-GCM data key in a chunked STREAM format, wrapped by a master key from a local key file (default), HashiCorp
  Vault Transit, a PKCS#11 HSM or AWS KMS (FIPS endpoints); content hashes stay over the plaintext. DuckDB reads sealed
  files through a decrypting filesystem, so main keeps no plaintext copies; workers, engines and gateways keep plain
  working copies.
  `minibrain keys status | rotate | encrypt-existing` and Settings → Security re-wrap headers without re-encrypting
  bodies and encrypt older files in place. Format, providers and measurements: `docs/security.md`.
- Model card and validation report generated per version from the eval data: purpose, data, metrics, limits, who
  promoted it. This is the model-risk documentation US banks owe under SR 11-7.
- PII and PHI handling as in Data; access to every minibrain is scoped and audited.
- SSO: OIDC and trusted proxy headers (see API and access).
- FIPS-ready design, so FIPS mode in v2 is a build setting, not a rewrite:
  - SHA-256 for every content hash and signature; never MD5 or SHA-1 (ruff `S324` in CI).
  - Non-security hashing (MinHash) passes `usedforsecurity=False`.
  - All crypto through OpenSSL or the `cryptography` library; nothing hand-rolled. Native code that brings its own TLS
    stays off the network: DuckDB's delta extension (rustls and ring in delta-kernel-rs) reads Delta tables from
    server folders only, while httpfs does S3 and Iceberg TLS through OpenSSL (`docs/security.md`).
  - Base images that can run in FIPS mode (Red Hat UBI).
  - Enforced in CI and `mise run check` by ruff `S324` and `scripts/check_crypto.py` (tested in
    `tests/test_check_crypto.py`), which fails on: MD5, SHA-1 or BLAKE2 through `hashlib` without
    `usedforsecurity=False`; HMAC or PBKDF2 with anything but SHA-256; scrypt; imports of PyCryptodome, PyNaCl,
    bcrypt, argon2, passlib, `rsa`, `ecdsa` and other crypto outside OpenSSL and `cryptography`; `cryptography`'s
    non-approved primitives (MD5, SHA-1, BLAKE2, ChaCha20, the `decrepit` module); `random` feeding a token, secret,
    password, salt, nonce or API key (`secrets` does that); in `web/`, SHA-1 or MD5 literals (Web Crypto included)
    and JavaScript crypto libraries (crypto-js, tweetnacl, noble, node-forge, the md5 and sha1 packages). The same
    library lists are checked against `uv.lock`, `web/package.json` and `web/pnpm-lock.yaml`, so no dependency
    brings one in transitively.

v2, for defense and critical infrastructure:

- FIPS 140-3 validated crypto mode: FIPS-enabled images, test suite run in FIPS mode.
- Hardened images: DoD STIG, Iron Bank listing.
- Native SAML and CAC / PIV login, if customers' proxies are not enough; roles by team.
- Control mappings: CMMC / NIST 800-171, NIST 800-53, HIPAA.

## CI

GitHub Actions (`.github/workflows/ci.yml`) on every branch push and pull request; no secrets, and tests make no
outbound calls.

- Python, on 3.12 and 3.13: `uv sync --locked`, ruff, ruff format, `scripts/check_crypto.py`, pyright, pytest. The
  mlx and llama.cpp extras are not installed on Linux, so pyright reports their imports as warnings, only in the three
  files that use them (`executionEnvironments` in `pyproject.toml`).
- Both stores: tests marked `both_stores` (uploads, dataset versions, adapters, logs, deletes, key passes) run twice,
  on the folder and on an S3 bucket. The bucket is moto's `ThreadedMotoServer`, started once per test run on
  127.0.0.1 with a random port, a fresh bucket per test; `uv run pytest -q` runs both, offline, locally and in CI.
  Base weights in a bucket (downloads, imports, signed links, working copies, verify, repair, delete) have their own
  tests on the same server.
  moto is a dev dependency only (`moto[s3]` with flask, not its heavy `server` extra) and never ships. If moto's
  fidelity falls short of a real server, the next step is a nightly job against a real S3-compatible server (SeaweedFS
  or MinIO); there is none yet.
- Web: `pnpm install --frozen-lockfile`, Biome, `tsc`, `vite build`.
- Wheel and sdist, once both pass: `uv build` with the built UI inside both, uploaded as the `minibrain-wheel` and
  `minibrain-sdist` artifacts.
- Releases: a `v*` tag runs `.github/workflows/release.yml`, which calls this workflow (`workflow_call`), builds the
  CPU and CUDA images for amd64 and arm64 from its wheel, signs and attests everything keyless with cosign, and
  publishes the images to GHCR and the wheel, sdist, SBOMs, `install.sh`, `SHA256SUMS` and their Sigstore bundles to
  GitHub Releases; `workflow_dispatch` is a dry run. Details: `docs/releasing.md`.
- ShellCheck on `install.sh` and `scripts/*.sh`.
- `mise run check` runs the same checks locally; change both together.
- Third-party actions pinned to full commit SHAs; uv, Node and pnpm versions fixed; uv and pnpm caches on.

## Platforms

Two modes, same code, same adapter format (PEFT safetensors).

| | Local | Production |
|---|---|---|
| OS | Linux, macOS, Windows | Linux |
| Install | Native via uv (Docker on macOS has no GPU access) | Docker image + compose; Helm / OpenShift in v2 |
| Compute | PyTorch picks CUDA, ROCm, MPS, Intel XPU or CPU | NVIDIA CUDA; AMD ROCm in v2 |
| Training | Same TRL/PEFT code; LoRA in fp32 on MPS or CPU, sized by the planner (~2B on a 16 GB Mac) | LoRA or QLoRA, picked by the training planner |
| Serving | `transformers` backend, PEFT multi-adapter | SGLang pool |
| Teacher | The base model itself, a larger compressed model if memory allows, or an opt-in API | Larger local model on its own pool |
| For | Evaluating, developing, small teams | Real workloads |

- `uv pip install --torch-backend=auto` (or `UV_TORCH_BACKEND=auto`) picks CUDA, ROCm, Intel or CPU wheels. Docker
  builds have no GPU, so they set `UV_CUDA_DRIVER_VERSION` or `UV_AMD_GPU_ARCHITECTURE`, otherwise they get CPU wheels.
- Engine auto-select, per engine process: Linux + CUDA or ROCm + SGLang → `sglang`; Apple silicon + `mlx-lm` → `mlx`;
  GGUF weights → `llamacpp`; otherwise `transformers`. `--engine` overrides; a failed automatic choice falls back to
  `transformers`. SGLang pins its own torch, so it runs from its own environment (`MINIBRAIN_SGLANG_PYTHON`).
- SGLang on Windows: WSL2 only. SGLang's own MLX backend is not used; minibrain drives `mlx-lm` directly.
- MPS gaps fall back to CPU with `PYTORCH_ENABLE_MPS_FALLBACK=1`.
- Local training falls back to CPU when the Metal GPU hangs. Seen in the spike: LoRA backward on an M1 Pro (macOS
  27.0.1, torch 2.15) hangs the GPU within 3–8 steps, while inference runs fine. CPU training there was only ~1.8×
  slower. MPS trains one example per micro-batch with gradient accumulation, which does not hang there; a GPU error
  or a step that takes ten times the slowest one so far (at least 3 minutes; 15 for the first) starts the job again
  on the CPU, and it stays there.
- Tests run on the `transformers` backend with a ~0.5B model; integration tests run on a GPU box.
- `llamacpp` serves GGUF base models (Metal, CUDA, CPU). Adapters on llama.cpp need PEFT → GGUF conversion: later.

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

- 8B student, planner estimates at 160-token rows and an effective batch of 16: LoRA in bf16 ~32GB at micro-batch 8
  (~20GB with checkpointing), QLoRA with checkpointing ~10GB; serving ~16GB weights plus KV cache.
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

- [x] minibrains: create, list, select, delete
- [ ] Task types: Classify, Extract, Rewrite, Text-to-SQL, Distill, Answer
- [ ] Index per minibrain: chunks, local embeddings, hybrid search, incremental sync, per-user access filter,
      citations
- [ ] Golden set authoring; eval-first flow
- [ ] Prompt-only version 0 on the teacher pool
- [ ] Teacher pool, permanent or temporary; API teacher opt-in, off by default
- [ ] `generate_qa` with check pass
- [ ] Teacher labelling with review queue
- [ ] Gateway upstream routes for distillation
- [ ] `response_format` with `json_schema` (built: SGLang gets EBNF or `json_schema`, llama.cpp grammars, MLX and
      `transformers` token tries for labels and finite schemas, every JSON answer checked in the gateway; llama.cpp,
      MLX and `transformers` verified on Qwen3-0.6B, SGLang only against a fake process: verify on a GPU box)
- [ ] Cost and latency in eval (p50 / p95, GPU time and cost per 1,000 requests priced per pool, and the headline
      against v0 on Evaluations and model cards done; list price for API teachers waits for the teacher pool, and
      "no training needed" for `target.min_score`, which does not exist yet)
- [ ] `minibrain.yaml` and `minibrain run`
- [x] Sources: uploads, server folders, S3, PostgreSQL, MySQL and Lakehouse tables via DuckDB (Iceberg on S3; Delta
      Lake from server folders only, as its S3 reads use TLS outside OpenSSL), through connections with encrypted
      write-only secrets; DuckDB extensions, delta included, installed offline and baked into the image
- [ ] Auto-mapping proposal, mapping editor compiled to SQL, SQL editor (column picker and SQL over several sources
      done; CodeMirror editor and auto-mapping not yet)
- [ ] Built-in steps: `strip_html`, `chunk`, `pii_scrub`, `dedupe_near`, `generate_qa`
- [ ] Preview of 5–10 examples as chat transcripts (the preview shows the query's first 20 rows as a table, with
      label counts; chat transcripts not yet)
- [ ] Quality score and PII report (version checks with pattern-based PII done; Presidio and near duplicates
      not yet)
- [x] Dataset versions: content-hashed Parquet copies saved when a dataset is created or updated, picked at training
      time; derived splits, row limit, diff, retention
- [x] Artifact store on a local folder or an S3-compatible bucket
- [x] Job contract: jobs table with leases, workers over HTTP, retries with backoff, cancel, events over SSE
- [x] Artifacts by SHA-256 ID; Alembic migrations; `MINIBRAIN_DATABASE_URL`
- [ ] Base model registry, default recipe, chat template parity tests
- [ ] Training memory: LoRA or QLoRA (bitsandbytes), gradient checkpointing, 8-bit optimisers and a fitted sequence
      length, chosen per run by the planner, with overrides stored on the version (built and measured with LoRA on
      MPS and CPU; QLoRA and the CUDA estimates: verify on a GPU box)
- [x] Base model health: saved SHA-256 file list, verify, repair, re-import, relocate, failure states with one action
      each, adapters pinned to their base's content hash
- [x] Base models stay on disk until deleted; deleting removes their files, and a base with models built on it goes
      with them after the cascade checkbox
- [x] Eval against the base (a prompt-only version on it, scored on the same held-out rows), side-by-side review,
      deploy any version at any step, rollback; against a teacher waits for the teacher pool
- [ ] SGLang pool with runtime adapter load/unload (built; tested against a fake SGLang process, verify on a GPU box)
- [x] Catalogue by rules: approved publishers, all generations, size tiers, built at release, no runtime Hugging Face
      calls, optional sync from our catalogue URL; Add from Hugging Face with support badges
- [x] Security policies under Settings: network, model sources, licences, safetensors only, request inputs and answers
      (default and lock), log retention, key expiry; config-locked values; audited; enforced in the backend
- [x] Compute pools with hardware reported by workers and engines; fit per pool in Discover
- [x] Engines chosen per node (SGLang, MLX, `transformers`, llama.cpp); remote engines join pools
- [x] Gateway routing across replicas: least in-flight, sticky, overflow, health checks
- [x] Several mains on Postgres with an advisory-lock leader for background loops
- [x] `transformers` backend for local mode and tests
- [x] Gateway: chat completions with streaming, models, `name@version`, scoped API keys, batched request logs; serves
      from a versioned config snapshot, standalone role, engines as supervised children with LRU adapters
- [ ] Gateway: `response_format`, per-model request bodies, retrieval context step (`response_format`, response ids
      on request logs and per-model request inputs and answers done)
- [x] Monitor → Requests: live `/v1` request log, server-paged, with filters and a summary, finish reasons recorded
      (migration 0033), and a detail with the kept input and answer (Builder and up) and linked feedback
- [x] Request metadata always logged; request inputs and answers kept per model, with an install default and an admin
      lock (migration 0034)
- [x] Monitor → Overview (first tab): requests per minute, error rate, p50 / p95 latency and tokens by model (top 5
      and Other) in buckets sized to the range, a per-model table, live with Pause; SQL checked on SQLite and Postgres
- [x] OpenTelemetry export, opt-in: OTLP over HTTP/protobuf to the customer's collector only; a GenAI-convention span
      per `/v1` request and duration, token, request, queue and worker metrics; settings as policies with
      write-only encrypted headers, `OTEL_EXPORTER_OTLP_*` honoured (checked against OpenTelemetry Collector 0.130)
- [x] Prometheus `/metrics`, off by default, by scrape token or scrape addresses, no session (scraped by Prometheus 3.5;
      `promtool check metrics` passes)
- [x] JSON logs on standard output (`MINIBRAIN_LOG_FORMAT=json`) with request and response ids; `X-Request-ID` on every
      response
- [ ] Grafana dashboard (`docs/grafana/minibrain.json`; imports into Grafana 12 and its queries run against
      Prometheus, not yet looked at with real traffic)
- [x] Playground
- [x] Harness config export: curl, Python, JavaScript, .env, LangChain, LlamaIndex, LiteLLM, Continue, Open WebUI
- [ ] Login: local accounts, OIDC, trusted reverse-proxy headers; sessions; always on, with the first admin from a
      one-time setup link, the environment or single sign-on (built; OIDC tested against a fake provider: verify on
      Entra, Okta, ADFS and Keycloak and behind a real proxy)
- [x] Roles: Admin, Builder, Viewer enforced per route; group-to-role mapping; Settings → Accounts
- [x] FIPS-ready crypto rules enforced in CI: ruff `S324` and `scripts/check_crypto.py`
- [x] Local install via uv on Linux and macOS
- [ ] Local install via uv on Windows (documented in `docs/install.md`; not verified yet)
- [ ] Production Docker image, CUDA 13.2 with a CPU variant and the DuckDB extensions baked in (built for amd64 and
      arm64 and started without a GPU; verify on a GPU box)
- [x] Wheel ships the built UI: `uvx minibrain serve` needs no Node
- [x] Developer tasks in `mise.toml` (setup, dev, check, build)
- [x] CI on every push: the `mise run check` checks, then build the UI and the wheel
- [ ] Releases: wheels on GitHub Releases, then PyPI or a private index; Docker image built from the same wheel
      (built: `release.yml` on `v*` tags puts the wheel, sdist, SBOMs and `SHA256SUMS` on GitHub Releases and CPU
      and CUDA images for amd64 and arm64 on GHCR, the images installing that same wheel; dry run passed, no tag
      pushed yet. PyPI not yet: Trusted Publishing steps in `docs/releasing.md`; no private index)
- [x] Install docs for `uvx`, `uv tool install`, `pip install` and Docker: `docs/install.md`
- [x] `curl … | sh` installer (`install.sh`): the release wheel with uv and the right torch backend, checked against
      `SHA256SUMS` and, with cosign, its signature; `--docker` pulls the image (tested on macOS, Debian 13 and
      Ubuntu 24.04 against dry-run files; not yet against a tagged release)
- [x] Python 3.13: allowed in `requires-python`; CI tests 3.12 and 3.13
- [ ] Offline install bundle; air-gap CI test
- [ ] Signed offline update bundles (app and base models) with rollback (release files are signed with cosign
      now; bundles will reuse that signing)
- [ ] Private frontier endpoint: the teacher model through the gateway, scoped keys
- [ ] Rebase: rebuild every minibrain on a new base model, compare, promote
- [x] Feedback endpoint (`POST /v1/feedback`, scoped keys, input required unless kept), thumbs and "Correct it"
      in the playground → review queue; accepted rows join the next version's training data; "Train with feedback"
- [ ] Review queue for domain experts: plain language, assignment, reviewer agreement (plain language,
      Assign to me, keyboard review and disagreement first done; agreement between reviewers not yet)
- [ ] SBOM, AI bill of materials per version, signed images (Python and web SBOMs in CI, image SBOMs per release,
      the per-version AI-BOM, and keyless cosign signatures, SBOM attestations and SLSA provenance on every image and
      release file built; signing first runs for real on the first tag)
- [x] Audit log page: filters, server-side paging, CSV and JSONL export, retention policy, client address
- [x] This install page with a diagnostics zip that never carries secrets
- [x] Hash-chained audit log with SIEM export; encryption at rest: hash chain sealed by the leader, prune anchors,
      verify in the UI, API and `minibrain audit verify`, RFC 5424 syslog over TLS, TCP or UDP; every stored file
      under its own AES-256-GCM data key wrapped by a local key file, Vault Transit, a PKCS#11 HSM or AWS KMS, with
      rotation and in-place encryption of older files (Vault tested on 1.20.4 dev, HSM on SoftHSM 2.7.0, KMS on moto;
      not yet on a production HSM or real AWS KMS; worker, engine and gateway caches stay plain)
- [x] Model card and validation report per version: in-app page, Markdown and JSON with a SHA-256 of the canonical card, editable intended use and known limits (audited)
- [ ] Reference hardware configs
- [ ] PyPI publishing through Trusted Publishing (`release.yml`, environment `pypi`, steps in `docs/releasing.md`):
      the last step before tagging v1

## v2

- Split into services: data, train, serve, gateway
- Adapters trained to answer from retrieved context and cite it
- dlt API connectors: Zendesk, Jira, Confluence, Salesforce, HubSpot
- One-click retrain on new data (dlt incremental)
- Automatic retrain when feedback since the last version crosses a threshold
- Version diff (scores; the data diff is done)
- Notifications bell in the top bar: failed jobs, results ready to review, models that need examples, missing
  files
- Batch jobs (Run → Batch jobs): run a version over a file, snapshot or SQL query in the background, on the job
  worker; resumable, with progress; results as CSV or Parquet with inputs, outputs and the version; OpenAI-compatible
  `/v1/files` and `/v1/batches`
- Preset recipes
- Arbitrary Python transforms (admin-only, sandboxed)
- Teams, sharing
- Multi-GPU and multi-node (Ray), serving pools across nodes
- Kubernetes launcher: training as Jobs, engine replicas as autoscaled Deployments; cloud VM launcher later
- sgl-router per pool under the gateway for many SGLang replicas of one model; llm-d on Kubernetes
- vLLM backend, AMD ROCm production image, LoRA adapters on llama.cpp
- Dedicated or merged-adapter instances for high-traffic minibrains
- Optional MLflow
- FIPS 140-3 mode, STIG / Iron Bank images, native SAML + CAC / PIV, control mappings
- Helm chart, OpenShift
- [ ] OCI / container registry model sources (Harbor, Quay; KitOps ModelKits)
- [ ] Catalogue export/import and model bundles for air-gapped sites — only if needed
- [ ] Import GGUF models (llamacpp backend) and standalone LoRA adapters
- [ ] Public catalogue page on the website (browse, pinned revision, checksums, download command)
- [ ] Custom model logos: PNG, JPEG or WebP up to 256 KB, stored with the model; never SVG, which can carry scripts
- Preinstalled appliance
- Later, kept simple until the engine settles:
  - [ ] Start from data: point at a table or folder and get a proposed preset, mapping, graders and base
  - [ ] Pick the base from a chart: train two or three bases at once, plot quality against cost and latency
  - [ ] Distil what you run: record a large model's answers through `/v1` and train a smaller copy from them
  - [ ] Shadow mode: copy live requests to a new version, grade both, promote only if it wins
  - [ ] MLX training on Macs behind a flag, only if MPS training is too slow for local use: a second trainer plus an
    MLX-to-PEFT adapter converter, so Mac-trained adapters still serve on SGLang and vLLM

## Fixes

Known defects and leftovers, smallest first. No users yet, so leftovers are deleted rather than kept.

- [x] Switching the OS from dark to light with the page open left some Cobalt colours dark (`--input-background`):
  the preset is applied with obp-ui's `applyPresetStyle`, which clears every preset property before setting a mode.
- [x] Training on a Mac used the CPU: training now picks CUDA (or ROCm), Intel XPU, the Apple GPU, then CPU, in bf16 or
  fp16 where the GPU has it and fp32 on MPS, with the MPS fallback in Platforms.
- [x] Quantized bases in the bucket were not refused for training up front: the check read `config.json` from main's
  disk, which a bucket model may not have. It reads it through the store from the saved file list.
- [x] A local engine's first start included downloading its model, which could exceed the 600 s startup limit for very
  large models. Fetching the working copy is now its own step before loading, with progress (`docs/serving.md`), and
  each file gets a fresh signed link.
- [x] Key rotation re-uploaded every bucket object whole, which is slow for large weights. It sends the new header and
  the first 5 MiB and the bucket copies the rest server-side (Artifact storage).
- [x] Deleted Copy to the bucket (moving bases from main's disk when Storage switches to S3) and the repair seed behind
  it; it only served older installs.
- [x] Deleted the job format version check that turned away older workers; there are no older workers.
- [x] Deleted inline secrets in `policy.otel_headers` and `auth.oidc.client_secret`: the headers are named with
  `secret_env` or `secret_file` (or `OTEL_EXPORTER_OTLP_HEADERS`), the client secret with `MINIBRAIN_OIDC_CLIENT_SECRET`
  or `client_secret_file`, and a value written in `minibrain.yaml` stops the start.
- [x] Deleted three routes no UI used: `POST /api/minibrains/{slug}/source` (uploading straight to a model, with its
  own replace-the-dataset rule; the UI uploads a source and picks a dataset), `GET /api/minibrains/bases` (the Models
  list replaced it) and `GET /api/snapshots/{snapshot_id}` (versions come from the dataset's list and the diff).
- [ ] Rename after the task engine lands: `Minibrain` and the `minibrains` table become `Model` and `models` (a
  model you own), today's `Model` becomes `BaseModel` and `base_models`, `/api/minibrains/{slug}/…` becomes
  `/api/models/{slug}/…` and `/api/models/base/{key}` becomes `/api/base-models/{key}`; the UI already says model.
- [x] S3 locations differing only by a trailing slash counted as different sources; an S3 or Iceberg path is compared
  without its trailing slashes.
- [x] Prototype pages (`/proto/*`, such as `/proto/logos`) were reachable in production builds. Their routes are
  registered only in development (`import.meta.env.DEV`), and the build leaves them and their code out.
- [x] Add model offered six tasks but only Classify works: the others are listed under Coming and cannot be picked.
  "Preview of 5–10 examples" is unticked (the preview is a table of rows, not chat transcripts) and "Eval vs base" says
  what it is (a prompt-only version on the base; no teacher yet).

## Risks to verify early

- SGLang LoRA on ROCm, MI300X specifically.
- `transformers` backend throughput with several adapters; serialize requests if PEFT adapter switching is not safe
  under concurrency.
- DuckDB Postgres scanner load on customer databases: read replicas, `LIMIT`, materialize.
- MPS dtype and op gaps during local training; Metal GPU hangs in LoRA backward (seen on M1 Pro, macOS 27.0.1).
- Teacher quality on generated Q&A: track the check-pass drop rate per source.
- Banking77 on a GPU (`docs/findings.md` has the laptop run): the teacher as version 0, a 4B student on full data,
  SGLang with runtime adapters, constrained decoding to zero invalid labels, and cost per 1,000 requests.
