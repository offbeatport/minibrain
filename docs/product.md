# Product

Users: product, engineer, ml, admin
Principles: any size, own hardware, air-gapped, gated on scores

## Data
- **Upload sources** · shipped · product, ml
  Add CSV, TSV, JSON, JSON Lines or Parquet files as tables.
  UI: Data › Add › Upload file, Data › Uploads › drop a file · API: POST /api/sources
- **Duplicate uploads** · shipped · product, ml
  Store each file once; a taken name offers Replace or Keep both.
  UI: Data › Add › Upload file, Data › Add › Sample data · API: POST /api/sources, POST /api/samples/{file}
- **Sample data** · shipped · product
  Try the whole flow on bundled sample data in minutes.
  UI: Home › Get started, Models › Try with demo data, Data › Add › Sample data · API: GET /api/samples, POST /api/samples/{file}, POST /api/models/sample
- **Folder sources** · shipped · ml, admin
  Read a server folder of files in place as one table.
  UI: Data › Add › Folder on the server · API: GET /api/data/folders, POST /api/sources/folders · Policy: data_folders
- **S3 sources** · shipped · ml
  Read Parquet, CSV or JSON objects in a bucket in place.
  UI: Data › Add › S3 · API: POST /api/sources/s3
- **Database sources** · shipped · ml
  Read a PostgreSQL or MySQL table or query, read-only.
  UI: Data › Add › Database · API: POST /api/sources/database
- **Lakehouse tables** · shipped · ml
  Read Iceberg tables on S3 and Delta Lake tables in folders.
  UI: Data › Add › Lakehouse table · API: POST /api/sources/iceberg, POST /api/sources/delta
- **Connections** · shipped · admin
  Name buckets and databases once, with write-only encrypted secrets.
  UI: Settings › Connections · API: GET /api/connections, POST /api/connections, PUT /api/connections/{connection_id}, DELETE /api/connections/{connection_id}, POST /api/connections/test, POST /api/connections/{connection_id}/test, GET /api/connections/{connection_id}/tables · Config: connections
- **Offline DuckDB extensions** · shipped · admin
  Install the S3, database and lakehouse readers without internet.
  UI: Settings › Connections › DuckDB extensions · API: GET /api/extensions · CLI: minibrain extensions status, minibrain extensions install, minibrain extensions download · Config: MINIBRAIN_DUCKDB_EXTENSIONS, MINIBRAIN_DUCKDB_EXTENSION_REPOSITORY
- **Source catalogue** · shipped · product, ml
  Find sources by name, column or tag, with stats and rows.
  UI: Data › Sources · API: GET /api/sources, GET /api/sources/{source_id}, PATCH /api/sources/{source_id}, DELETE /api/sources/{source_id}, GET /api/sources/{source_id}/rows, GET /api/sources/{source_id}/stats
- **Datasets** · shipped · product, ml
  Turn sources into chat examples that models share.
  UI: Data › Add › New dataset, Data › Add › From sources, Data › Datasets · API: GET /api/datasets, POST /api/datasets, GET /api/datasets/{slug}, PATCH /api/datasets/{slug}, DELETE /api/datasets/{slug}, PUT /api/datasets/{slug}/mapping, GET /api/datasets/{slug}/preview
- **Dataset SQL** · shipped · ml
  Join, filter and clean several sources in locked-down DuckDB SQL.
  UI: Data › dataset › SQL · API: POST /api/query, POST /api/sources/{source_id}/query, POST /api/datasets/{slug}/query
- **Dataset folders** · shipped · product, ml
  Organise datasets in nested folders by drag and drop.
  UI: Data › Add › New folder · API: GET /api/dataset-folders, POST /api/dataset-folders, PATCH /api/dataset-folders/{folder_id}, PUT /api/dataset-folders/{folder_id}/parent, DELETE /api/dataset-folders/{folder_id}, PUT /api/datasets/{slug}/folder
- **Unique names** · shipped · product, ml
  No two datasets share a name in a folder, nor two sources.
  UI: Data › Datasets, Data › Sources · API: POST /api/datasets, PATCH /api/datasets/{slug}, PATCH /api/sources/{source_id}, PUT /api/datasets/{slug}/folder
- **Dataset versions** · shipped · product, ml
  Train on exactly the rows you checked.
  UI: Data › dataset › Versions · API: GET /api/datasets/{slug}/versions, POST /api/datasets/{slug}/versions, POST /api/models/{name}/dataset-versions · Config: data.row_limit, data.keep_versions
- **Version diff** · shipped · product, ml
  See rows added, removed and relabelled between two versions.
  UI: Data › dataset › Versions › Compare · API: GET /api/dataset-versions/{dataset_version_id}/diff/{other_id}
- **Change detection** · shipped · product, ml
  Know when sources or the query changed since the last version.
  UI: Data › dataset, Models › model › Train › Data
- **Version checks** · shipped · product, ml
  Catch duplicates, conflicts, imbalance, leakage and personal data before training.
  UI: Data › dataset › Checks · API: PUT /api/datasets/{slug}/checks/{check}/dismissal, DELETE /api/datasets/{slug}/checks/{check}/dismissal · Config: data.checks_off, data.majority_share, data.min_label_rows
- **Data settings** · shipped · admin
  Set the row limit, version retention and check thresholds.
  UI: Settings › Data · API: GET /api/settings/data, PUT /api/settings/data · Config: data
- **Chat uploads** · shipped · product, ml
  Upload chat JSONL as conversations; question and answer tables map too.
  UI: Data › Add › Upload file · API: POST /api/sources, PUT /api/models/{name}/dataset
- **Mapping templates** · shipped · product, ml
  Turn columns or chat JSONL into chat examples, compiled to SQL.
  UI: Data › dataset › Columns · API: PUT /api/datasets/{slug}/mapping
- **Mapping editor** · planned · product, ml
  Edit message templates in the UI, proposed by a model.
  Roadmap: Transforms
- **Built-in steps** · planned · product, ml
  Clean rows with strip_html, chunk, pii_scrub and dedupe_near.
  Roadmap: Transforms
- **PII report** · planned · product, admin
  Keep, mask, fake or drop personal data per entity type.
  Roadmap: PII
- **Near duplicates** · planned · ml
  Flag near-duplicate rows with MinHash before training.
  Roadmap: Quality score
- **Teacher labelling** · planned · product, ml
  Label unlabelled rows with a local teacher, then review a sample.
  Roadmap: Labelling
- **Generated Q&A** · planned · product, ml
  Turn documents into checked question and answer pairs.
  Roadmap: Labelling
- **Distillation data** · planned · ml
  Use a teacher's logged answers as training examples.
  Roadmap: Task types
- **Zero-copy lakehouse versions** · planned · ml
  Pin Iceberg and Delta snapshot ids instead of copying rows.
  Roadmap: Dataset versions
- **API connectors** · planned · product, ml
  Load Zendesk, Jira, Confluence, Salesforce and HubSpot through dlt.
  Roadmap: v2
- **Python transforms** · planned · ml, admin
  Run admin-only Python steps in a sandbox without network.
  Roadmap: v2

## Models
- **Model catalogue** · shipped · product, ml
  Browse approved open models with size, fit and licence filters.
  UI: Discover · API: GET /api/catalog
- **Model comparison** · shipped · product, ml
  Compare candidate base models side by side, by link.
  UI: Discover › Compare
- **Fit per pool** · shipped · ml, admin
  See which named pools run a model before downloading it.
  UI: Discover, Models › Add model
- **Memory to train** · shipped · ml, admin
  See the QLoRA training memory and whether a pool's workers train it.
  UI: Discover, Discover › model, Discover › Compare, Models › Add model · API: GET /api/catalog
- **Catalogue updates** · shipped · admin
  Refresh the catalogue from a configured URL, on demand or daily.
  UI: Settings › General › Model catalogue · API: POST /api/catalog/sync, GET /api/catalog/settings, PUT /api/catalog/settings · Config: catalogue, MINIBRAIN_CATALOG_URL
- **Add from Hugging Face** · shipped · ml
  Add any Hugging Face model, with support badges.
  UI: Discover › Add from Hugging Face · API: POST /api/catalog/hub, DELETE /api/catalog/{catalog_id} · Config: MINIBRAIN_HF_ENDPOINT
- **Download base models** · shipped · admin
  Download weights pinned to a revision, hash-checked and resumable.
  UI: Discover › model › Download · API: POST /api/catalog/{catalog_id}/download
- **Import base models** · shipped · admin
  Import from Hugging Face, S3 or a server folder, previewed first.
  UI: Models › Add model › Your imports · API: POST /api/models/inspect, POST /api/models/import · Config: MINIBRAIN_MODELS_S3_URL
- **Models list** · shipped · product, ml
  Custom and base models with data, score, traffic, cost and status.
  UI: Models · API: GET /api/models
- **List view options** · shipped · product, ml
  Filter by status, kind and base, sort, pick columns, reset to default.
  UI: Models › View options
- **Versions and variants in the list** · shipped · product, ml
  Show versions under models and installed formats under base models.
  UI: Models › View options › Show versions · API: GET /api/models
- **Act on versions and variants** · shipped · product, ml, admin
  Tick versions to compare or delete, variants to deploy or delete.
  UI: Models › Show versions · API: POST /api/models/{name}/versions/{number}/promote, POST /api/models/{name}/deploy, DELETE /api/models/{name}/versions/{number}, DELETE /api/models/{name}
- **Model quick look** · shipped · product, ml
  Score history, a week of traffic and the next step.
  UI: Models › Quick look · API: GET /api/models/{name}/overview, GET /api/requests
- **Model page** · shipped · product, ml, admin
  One page per model: Overview, Versions, Monitoring, API keys and Settings.
  UI: Models › model · API: GET /api/models/{name}/overview, GET /api/models/{name}, PATCH /api/models/{name}
- **Model overview** · shipped · product, ml
  Usage by version, its facts, details and activity.
  UI: Models › model › Overview · API: GET /api/models/{name}/overview, GET /api/models/{name}/traffic
- **Model activity** · shipped · product, ml, admin
  Who changed or trained this model, by day, with bursts folded.
  UI: Models › model › Overview › Activity · API: GET /api/models/{name}/activity
- **Model monitoring** · shipped · engineer, admin
  Traffic, latency, errors, versions, callers and requests of one model.
  UI: Models › model › Monitoring · API: GET /api/models/{name}/traffic, GET /api/requests
- **Version page** · shipped · product, ml
  A version's score, differences from live, its run, loss, logs and files.
  UI: Models › model › Versions › version · API: GET /api/models/{name}/versions, GET /api/models/{name}/versions/{number}/answers, GET /api/jobs/{job_id}/metrics, GET /api/jobs/{job_id}/events
- **Model files** · shipped · ml, admin
  List weights or the live adapter's files with their SHA-256.
  UI: Models › model › View files · API: GET /api/models/{name}, GET /api/models/{name}/versions/{number}/files
- **Unique model names** · shipped · product, ml
  Names are unique; a taken API name gets the next free suffix.
  UI: Models › Add model, Models › model › Edit · API: POST /api/models, GET /api/models/name, PATCH /api/models/{name}, POST /api/models/import
- **Try a base model** · shipped · product, ml
  Send a prompt to a base model before building on it.
  UI: Models › Test, Models › model › Playground · API: POST /api/models/{name}/test
- **Base model health** · shipped · admin
  Verify, repair, re-import or relocate damaged weights in one action.
  UI: Models › model › View files, Models › model › Overview · API: POST /api/models/{name}/verify, POST /api/models/{name}/repair, POST /api/models/{name}/reimport, POST /api/models/{name}/relocate, POST /api/models/{name}/retry, POST /api/models/{name}/recheck
- **Delete base models** · shipped · admin
  Delete a base and its files, and its models once confirmed.
  UI: Models › Delete · API: DELETE /api/models/{name}
- **Custom models** · shipped · product, ml
  Base, dataset and name; v0 is scored on held-out rows at once.
  UI: Models › Add model, Data › Add · API: GET /api/models, POST /api/models, GET /api/datasets, GET /api/models/name, GET /api/models/{name}, PATCH /api/models/{name}, DELETE /api/models/{name}
- **Duplicate models** · shipped · product, ml
  Copy a custom model's settings, data and live version, sharing its files.
  UI: Models › Duplicate, Models › model › Settings › Duplicate · API: POST /api/models/{name}/duplicate
- **Model avatars** · shipped · product
  Give each custom model a generated name and an avatar.
  UI: Models › Add model, Models › model › Settings › General · API: POST /api/models, PUT /api/models/{name}/avatar
- **Serve-only bases** · shipped · product, ml
  Build on GGUF, AWQ or FP8 bases; Train explains why not.
  UI: Models › Add model, Models › model, Models · API: GET /api/models, GET /api/models/{name}/overview
- **Switch base** · shipped · product, ml
  Move a model to another base without touching live traffic.
  UI: Models › model › Settings › Switch base, Models › Switch base · API: GET /api/models/{name}/base-options, POST /api/models/{name}/base
- **Model teardown** · shipped · product, admin
  Delete or undeploy any model safely across restarts, with retry.
  UI: Models, Models › model
- **Cancel jobs on delete** · shipped · product, ml, admin
  Delete dialogs list running jobs and cancel them before deleting.
  UI: Models › Delete, Models › model › Settings › Delete · API: DELETE /api/models/{name}, DELETE /api/models/{name}/versions/{number}
- **History outlives models** · shipped · product, admin
  Jobs and request logs of deleted models stay, marked deleted.
  UI: Training, Jobs, Monitoring › Requests, Monitoring › Overview, Jobs › job
- **Reserved API names** · shipped · product, engineer, admin
  A deleted model's API name stays reserved; calls say it was deleted.
  UI: Models › Add model, Models › Duplicate, Models › model, Playground · API: GET /api/reserved-names/{name}, GET /api/models/name, POST /v1/chat/completions
- **Release reserved names** · planned · admin
  Free a deleted model's API name from Settings, with a warning.
  Roadmap: v2
- **Model settings** · shipped · product, ml
  Rename, re-avatar, undeploy, switch base, duplicate or delete in one tab.
  UI: Models › model › Settings · API: PATCH /api/models/{name}, PUT /api/models/{name}/avatar
- **Classify preset** · shipped · product, ml
  Sort text into one label from a set that grows.
  UI: Models › model › Evaluation › How it's scored, Evaluations › version · API: GET /api/presets
- **Label proposal** · shipped · product, ml
  Offer to restrict a chat assistant to labels found in its data.
  UI: Models › model · API: PUT /api/models/{name}/label-proposal/dismissal, PUT /api/models/{name}/contract
- **Extract preset** · planned · product, ml
  Pull JSON fields out of text against a schema.
  Roadmap: Task types
- **Rewrite preset** · planned · product
  Rewrite drafts in house style, from pairs or documents.
  Roadmap: Task types
- **General preset** · partial · product, ml
  A chat assistant in the organisation's language, formats and policies.
  UI: Models › Add model, Models › model › Evaluation › How it's scored, Evaluations › version, Playground · API: GET /api/presets, POST /api/models · Roadmap: Task types
- **Text-to-SQL preset** · planned · ml
  Answer questions with SQL on your own schema.
  Roadmap: Task types
- **Custom preset** · shipped · ml
  Bring chat JSONL with your own contract and graders.
  UI: Models › model › Evaluation › How it's scored · API: PUT /api/models/{name}/graders
- **Instructions** · shipped · product, ml
  Edit the system prompt with each new version, which keeps its copy.
  UI: Models › model › Train › Instructions · API: POST /api/models/{name}/versions, PUT /api/models/{name}/instructions
- **Task engine** · shipped · ml
  One engine for chat examples, contracts, graders and promotion rules.
  UI: Models › model › Evaluation › How it's scored
- **Contracts** · shipped · engineer, ml
  Free text or a JSON schema; breaking changes confirmed once live.
  UI: Models › model › Evaluation › How it's scored · API: POST /api/models/{name}/contract/check, PUT /api/models/{name}/contract
- **Chat template parity** · planned · ml
  Prove training and serving render the same prompt per base.
  Roadmap: Base model registry
- **OCI model sources** · planned · admin
  Pull models from Harbor, Quay or KitOps ModelKits.
  Roadmap: v2
- **GGUF and adapter imports** · planned · ml
  Import GGUF models and standalone LoRA adapters.
  Roadmap: v2

## Training
- **Training data per model** · shipped · product, ml
  One dataset per model, picked at creation; each run picks its version.
  UI: Models › Add model, Models › model › Train › Data · API: PUT /api/models/{name}/dataset, PUT /api/models/{name}/mapping, POST /api/models/{name}/query, GET /api/models/{name}/preview
- **LoRA training** · shipped · product, ml
  Train a LoRA version, fresh or from an earlier version's settings.
  UI: Models › model › Train, Versions › Train again · API: POST /api/models/{name}/versions
- **Training list** · shipped · product, ml
  Every training run across models, filtered by model, status and method.
  UI: Training · API: GET /api/jobs, GET /api/jobs/facets
- **Bulk job actions** · shipped · product, ml
  Tick jobs to cancel, retry or delete them together, each one audited.
  UI: Training › select runs, Jobs › select jobs · API: POST /api/jobs/cancel, POST /api/jobs/retry, POST /api/jobs/delete
- **Versions** · shipped · product, ml
  One table of every version and its run, prompt-only or trained.
  UI: Models › model › Versions, Evaluations · API: GET /api/models/{name}/versions, DELETE /api/models/{name}/versions/{number}
- **Training memory planner** · shipped · ml, admin
  Pick LoRA or QLoRA, checkpointing and batch to fit the worker's memory.
  UI: Models › model › Train › Pool · API: GET /api/models/{name}/training-plan
- **Training pool** · shipped · ml, admin
  Train on a chosen pool; only its workers claim the job.
  UI: Models › model › Train › Pool, Models › model › Train › Training › Machine · API: GET /api/models/{name}/training-plan, POST /api/models/{name}/versions
- **QLoRA training** · partial · ml, admin
  Train a 4-bit base with bitsandbytes on CUDA, ROCm or Intel GPUs.
  UI: Models › model › Train · Roadmap: Training memory
- **Training settings** · partial · ml
  Pick Fast, Balanced, Best or Custom to tune every trainer setting.
  UI: Models › model › Train › Training, Settings › General › Default training recipe · API: POST /api/models/{name}/versions, GET /api/settings · Roadmap: For ML engineers
- **Training devices** · shipped · ml, admin
  Train on CUDA, ROCm, Intel XPU, Apple GPU or CPU, picked automatically.
  Config: MINIBRAIN_TRAIN_DEVICE
- **Training methods** · planned · ml
  Full fine-tuning, DPO from feedback and GRPO with graders.
  Roadmap: Task types
- **Rebase** · planned · product, ml
  Rebuild every model on a new base and compare with live.
  CLI: minibrain rebase · Roadmap: Rebase
- **Models as code** · planned · ml, engineer
  Keep each model in a minibrain.yaml and rerun it from CI.
  CLI: minibrain run · Roadmap: Config as code
- **Exports** · partial · ml
  Download a version's adapter; merged weights and GGUF come later.
  UI: Models › model › version › Export · API: GET /api/artifacts/{artifact_id} · Roadmap: For ML engineers
- **Multi-node training** · planned · ml, admin
  Train across GPUs and nodes with Ray.
  Roadmap: v2
- **MLflow tracking** · planned · ml
  Log runs to an MLflow server you run.
  Roadmap: v2

## Evaluation
- **Prompt-only versions** · shipped · product, ml
  Get a scored version 0 the moment a model exists.
  UI: Models › model › Train › Instructions only, Playground · API: POST /api/models/{name}/versions, POST /api/models/{name}/versions/{number}/test
- **Scores** · shipped · product, ml
  Score every version on the test set and held-out split.
  UI: Evaluations · API: GET /api/models/{name}/golden
- **Mistakes and side by side** · shipped · product, ml
  Read held-out mistakes and compare answers with the base.
  UI: Evaluations › version
- **Answer review** · shipped · product, ml
  Read free-text answers beside the expected and live ones, worse first.
  UI: Evaluations › version › Answers · API: GET /api/models/{name}/versions/{number}/answers
- **Cost and latency** · partial · product, admin
  See p50, p95 and cost per 1,000 requests per version.
  UI: Evaluations · Roadmap: Eval and promote
- **Compute prices** · shipped · admin
  Price each pool's GPU hour to get cost per request.
  UI: Settings › General › Compute prices · API: GET /api/compute/prices, PUT /api/compute/prices · Config: compute
- **Model card** · shipped · product, admin
  Generate a model card and validation report for each version.
  UI: Models › model › Versions › Model card · API: GET /api/models/{name}/versions/{number}/card, PUT /api/models/{name}/versions/{number}/card, GET /api/models/{name}/versions/{number}/card.json, GET /api/models/{name}/versions/{number}/card.md
- **Golden set authoring** · planned · product
  Write 20 to 50 verified examples before any training.
  Roadmap: Eval and promote
- **Target score** · planned · product
  Say when the prompt-only version is good enough to skip training.
  Roadmap: Eval and promote
- **Re-score on grader change** · shipped · ml
  Re-score every version when the graders or judge change.
  UI: Models › model › Evaluation › How it's scored · API: POST /api/models/{name}/rescore
- **Graders** · partial · ml
  Score with exact match, labels, JSON, similarity, a judge, SQL, Python.
  UI: Models › model › Evaluation › How it's scored, Evaluations › version · Roadmap: Task types
- **Judge model** · shipped · ml, admin
  Pick the base that judges free-text answers, per install or model.
  UI: Settings › General › Judge model, Models › model › Evaluation › How it's scored · API: GET /api/settings/judge, PUT /api/settings/judge, PUT /api/models/{name}/judge
- **Promotion rule** · partial · ml, engineer
  Gate a version on thresholds over its grader scores, in CI.
  UI: Models › model › Evaluation › How it's scored, Evaluations › Deploy · API: PUT /api/models/{name}/promotion, POST /api/models/{name}/versions/{number}/promote · Roadmap: Config as code
- **Evaluation tab** · shipped · product, ml
  Score by version against the rule, failing rows, test set and scoring.
  UI: Models › model › Evaluation · API: GET /api/models/{name}/versions, GET /api/models/{name}/versions/{number}/answers
- **Score diff** · shipped · product, ml
  Compare two versions' scores, settings and held-out answers.
  UI: Models › model › Versions › Compare · API: GET /api/models/{name}/versions/{number}/answers

## Serving
- **Deploy and roll back** · shipped · product, engineer
  Deploy a passing version, or an earlier one again.
  UI: Models › model › Deploy, Models › model › version › Deploy, Evaluations › Deploy, Models › model › Settings › Undeploy · API: POST /api/models/{name}/deploy, POST /api/models/{name}/versions/{number}/promote
- **Deploy to a pool** · shipped · engineer, admin
  Pick the pool a model serves from; workers there run it.
  UI: Models › model › Deploy › Pool, Models › model › version › Deploy › Pool · API: POST /api/models/{name}/deploy, POST /api/models/{name}/versions/{number}/promote, GET /api/models/{name}/placement · CLI: minibrain worker
- **Serve base models** · shipped · engineer
  Serve a downloaded base model by name through the gateway.
  UI: Models › model › Deploy · API: POST /api/models/{name}/deploy
- **OpenAI-compatible API** · shipped · engineer
  Call any model by name or pinned version, streamed token by token.
  UI: Models › model › API · API: POST /v1/chat/completions, GET /v1/models
- **Text completions** · shipped · engineer
  Continue a raw prompt without the chat template, for code completion.
  API: POST /v1/completions
- **Sampling settings** · shipped · engineer
  Set temperature, top_p, top_k, min_p, penalties, seed and stops.
  API: POST /v1/chat/completions, POST /v1/completions
- **Tool calling** · shipped · engineer
  Call functions from Qwen, Llama, Mistral and gpt-oss models, streamed too.
  API: POST /v1/chat/completions
- **Reasoning** · shipped · engineer
  Turn reasoning off or set its effort, returned apart.
  API: POST /v1/chat/completions
- **Safety model** · partial · engineer, admin
  Block unsafe requests and answers with a guard model, audited.
  API: GET /api/settings/safety, PUT /api/settings/safety, PUT /api/models/{name}/safety, POST /v1/chat/completions, POST /v1/completions · Roadmap: API and access
- **Structured output** · partial · engineer
  Hold answers to the model's contract or a requested JSON schema.
  API: POST /v1/chat/completions · Roadmap: API and access
- **API keys** · shipped · engineer, admin
  Issue named keys scoped to models, with expiry and an audit trail.
  UI: API keys, Models › model › API keys · API: GET /api/keys, POST /api/keys, PUT /api/keys/{key_id}/models, DELETE /api/keys/{key_id} · Policy: key_expiry_days
- **All-model API keys** · shipped · admin
  Let one key call every model, including ones added later.
  UI: API keys · API: POST /api/keys, PUT /api/keys/{key_id}/models
- **Harness configs** · shipped · engineer
  Copy ready configs, create a key and see the first request.
  UI: Models › model › Use › API Connect · API: POST /api/keys, GET /api/requests, POST /v1/chat/completions
- **Playground** · shipped · product, engineer
  Chat with any model, streamed, with every API setting and its code.
  UI: Playground · API: GET /api/playground/models, POST /api/playground/chat/completions
- **Playground presets** · shipped · product, engineer
  Save, rename and delete named settings, one loading by default.
  UI: Playground › Presets · API: GET /api/playground/presets, POST /api/playground/presets, PUT /api/playground/presets/{preset_id}, DELETE /api/playground/presets/{preset_id}
- **Playground history** · shipped · product, engineer
  Reopen, rename and delete your chats, saved encrypted per person.
  UI: Playground › Recent · API: GET /api/playground/sessions, POST /api/playground/sessions, GET /api/playground/sessions/{chat_id}, PUT /api/playground/sessions/{chat_id}, DELETE /api/playground/sessions/{chat_id} · Policy: request_bodies, log_retention_days
- **Staff chat** · planned · product, admin
  A ChatGPT-like app for staff: history, retrieval, sharing, retention.
  Roadmap: Product priorities
- **Engines per machine** · shipped · admin
  Serve on SGLang, vLLM, MLX, transformers or llama.cpp, on any machine.
  CLI: minibrain engine · Config: MINIBRAIN_SGLANG_PYTHON, MINIBRAIN_VLLM_PYTHON
- **Runtime adapters on SGLang** · partial · admin
  Load and unload LoRA adapters on SGLang without restarts.
  Roadmap: Serving
- **Gateway routing** · shipped · admin
  Balance replicas by load, stickiness and overflow, with failover.
- **Standalone gateways** · shipped · admin
  Keep serving from the last good config while main is down.
  CLI: minibrain gateway · Config: MINIBRAIN_GATEWAY_TOKEN
- **Teacher pool** · planned · ml, admin
  Keep a larger local teacher loaded; API teachers only by opt-in.
  Roadmap: Serving
- **Private frontier endpoint** · planned · engineer, admin
  Offer the large teacher model privately, with scoped keys.
  Roadmap: API and access
- **Upstream routes** · planned · engineer
  Forward calls to a teacher and log them for distillation.
  Roadmap: API and access
- **Retrieval index** · planned · product, engineer
  Answer from a synced per-model index, with citations and access filters.
  Roadmap: Retrieval
- **Batch jobs** · planned · engineer
  Run a version over a file or query, OpenAI batch compatible.
  Roadmap: v2
- **vLLM backend** · partial · admin
  Serve on vLLM; ROCm production images and llama.cpp adapters later.
  CLI: minibrain engine · Roadmap: v2
- **Dedicated instances** · planned · admin
  Give high-traffic models their own or merged-adapter instances.
  Roadmap: v2

## Improve
- **Feedback API** · shipped · engineer
  Send thumbs and corrections from apps by response id.
  UI: Models › model › Use › API Connect · API: POST /v1/feedback
- **Playground feedback** · shipped · product
  Rate or correct any playground answer.
  UI: Playground · API: POST /api/models/{name}/feedback
- **Review queue** · partial · product
  Accept, fix or reject feedback by keyboard, disagreements first.
  UI: Feedback · API: GET /api/feedback, GET /api/feedback/facets, GET /api/feedback/{feedback_id}, POST /api/feedback/{feedback_id}/assign, POST /api/feedback/{feedback_id}/review · Roadmap: Feedback loop
- **Test examples** · shipped · product, ml
  Tests the next version faces, added by hand or from the Playground.
  UI: Playground › Save as test example, Models › model › Evaluation › What it's tested on, Data › dataset › Used by · API: POST /api/models/{name}/test-examples, GET /api/models/{name}/test-examples, DELETE /api/models/{name}/test-examples/{feedback_id}
- **Train with feedback** · shipped · product, ml
  Retrain with accepted feedback merged into the training rows.
  UI: Models › model › Train › Data · API: GET /api/models/{name}/feedback/summary
- **Retrain on new data** · planned · product, ml
  Retrain in one click when sources change.
  Roadmap: v2
- **Automatic retrain** · planned · ml
  Retrain once feedback since the last version crosses a threshold.
  Roadmap: v2

## Infrastructure
- **One command install** · shipped · admin
  Start UI, API, gateway, worker and engines with one command.
  CLI: minibrain serve · Config: MINIBRAIN_HOME, MINIBRAIN_UI_URL, MINIBRAIN_WEB_DIST
- **Compute pools** · shipped · admin
  See pools, machines, GPUs, workers and engines in one place.
  UI: Infrastructure › Overview, Infrastructure › Machines · API: GET /api/compute/pools, GET /api/system/infrastructure, GET /api/system
- **Pool links** · shipped · product, ml, admin
  Where things run or are stored is named by pool, with details.
  UI: Models › Add model, Models › model › Train, Models › model › Deploy, Models › model › Overview, Models, Jobs › job · API: GET /api/compute/pools
- **Remote workers** · shipped · admin
  Join GPU machines that run training and scoring jobs.
  CLI: minibrain worker · Config: MINIBRAIN_MAIN_URL, MINIBRAIN_WORKER_TOKEN
- **Artifact storage** · shipped · admin
  Keep artifacts in a local folder or an S3-compatible bucket.
  UI: Settings › Storage · API: GET /api/settings/storage, PUT /api/settings/storage, POST /api/settings/storage/test · Config: storage, MINIBRAIN_STORAGE_S3_SECRET
- **Base weights in the bucket** · shipped · admin
  Keep base weights in the bucket; machines fetch them by signed links.
  UI: Settings › Storage › Base model files
- **Storage usage** · shipped · admin
  See disk use by stores, models and dataset versions.
  UI: Infrastructure › Storage
- **Highly available main** · shipped · admin
  Run several mains on Postgres, with a leader for background work.
  Config: MINIBRAIN_DATABASE_URL
- **Kubernetes launcher** · planned · admin
  Run training as Jobs and engines as autoscaled Deployments.
  Roadmap: v2
- **Helm and OpenShift** · planned · admin
  Install with a Helm chart or on OpenShift.
  Roadmap: v2
- **Reference hardware** · planned · admin
  Tested server configs with exact driver and image versions.
  Roadmap: Production hardware
- **Appliance** · planned · admin
  Run minibrain preinstalled on a ready server.
  Roadmap: v2

## Security
- **Sign-in** · partial · admin
  Sign in with local accounts, OIDC or trusted proxy headers.
  UI: Sign-in page · API: GET /api/auth/session, POST /api/auth/login, POST /api/auth/logout, GET /api/auth/oidc/start, GET /api/auth/oidc/callback · Config: auth.oidc, auth.proxy, MINIBRAIN_OIDC_CLIENT_SECRET · Roadmap: Accounts and roles
- **First admin** · shipped · admin
  Create the first admin by one-time link, environment or SSO.
  API: POST /api/auth/setup · CLI: minibrain admin setup-link, minibrain admin create · Config: auth.admins, MINIBRAIN_ADMIN_EMAIL, MINIBRAIN_ADMIN_PASSWORD_FILE
- **Accounts** · shipped · admin
  Invite people, set roles, disable accounts and reset passwords.
  UI: Settings › Accounts · API: GET /api/accounts, POST /api/accounts, PATCH /api/accounts/{account_id}, POST /api/accounts/{account_id}/password-link, POST /api/auth/reset · CLI: minibrain admin reset-password
- **Roles** · shipped · admin
  Viewer, Builder and Admin, enforced per route, mapped from groups.
  UI: Settings › Accounts › Sign-in and roles · Config: auth.roles, auth.default_role · Policy: default_role
- **Sessions** · shipped · admin
  Idle and absolute session limits, with CSRF on every change.
  UI: Settings › Security › Sign-in · Policy: session_idle_minutes, session_hours
- **Security policies** · shipped · admin
  Change install policies in one place, locked when set by config.
  UI: Settings › Security · API: GET /api/policies, PUT /api/policies/{name} · Config: policy
- **Network policy** · shipped · admin
  Run open, allowlisted or fully offline.
  UI: Settings › Security › Network · Policy: network, allowed_hosts · Config: MINIBRAIN_OFFLINE
- **Model policy** · shipped · admin
  Limit models by publisher, licence and safe weight format.
  UI: Settings › Security › Models · Policy: model_sources, licence_mode, licences, safetensors_only
- **Request inputs and answers** · shipped · admin, engineer
  Keep or drop prompts and answers per model, lockable install-wide.
  UI: Models › model › Settings › Request content, Settings › Security › Request logs and API keys · API: PUT /api/models/{name}/request-bodies · Policy: request_bodies, request_bodies_locked
- **Audit log** · shipped · admin
  Search, filter, inspect and export every audited change, linked to its target.
  UI: Settings › Audit log · API: GET /api/audit, GET /api/audit/facets, GET /api/audit/{event_id}, GET /api/audit/export · Policy: audit_retention_days
- **Tamper-evident audit** · shipped · admin
  Prove no audit event was changed or removed.
  UI: Settings › Audit log › Integrity · API: GET /api/audit/chain · CLI: minibrain audit verify
- **SIEM export** · shipped · admin
  Stream audit events to your SIEM as RFC 5424 syslog.
  UI: Settings › Security › Audit log export · Policy: siem_protocol, siem_host, siem_port, siem_ca_bundle
- **Encryption at rest** · shipped · admin
  Seal every stored file under its own key, with rotation.
  UI: Settings › Security › Encryption at rest · API: GET /api/settings/encryption, PUT /api/settings/encryption, POST /api/settings/encryption/test, POST /api/settings/encryption/tasks · CLI: minibrain keys status, minibrain keys rotate, minibrain keys encrypt-existing · Policy: encryption · Config: MINIBRAIN_MASTER_KEY_FILE
- **External key managers** · shipped · admin
  Wrap keys with Vault Transit, a PKCS#11 HSM or AWS KMS.
  UI: Settings › Security › Encryption at rest · Policy: vault_address, vault_mount, vault_key, vault_namespace, vault_auth, vault_role_id, vault_auth_mount, vault_ca_bundle, hsm_library, hsm_token, hsm_key, kms_key, kms_region, kms_endpoint, kms_fips · Config: MINIBRAIN_VAULT_TOKEN, MINIBRAIN_VAULT_TOKEN_FILE, MINIBRAIN_VAULT_SECRET_ID, MINIBRAIN_VAULT_SECRET_ID_FILE, MINIBRAIN_HSM_PIN, MINIBRAIN_HSM_PIN_FILE
- **AI bill of materials** · shipped · admin
  Download a CycloneDX ML-BOM for each version.
  UI: Models › model › Versions › Model card · API: GET /api/models/{name}/versions/{number}/aibom.json
- **SBOMs** · shipped · admin
  CycloneDX SBOMs for the Python, web and image dependency sets.
- **Signed releases** · partial · admin
  Verify every release file and image offline with Sigstore.
  Roadmap: Security and accreditation
- **FIPS-ready crypto** · shipped · admin
  Only FIPS-approved algorithms, through OpenSSL or cryptography.
- **FIPS 140-3 mode** · planned · admin
  Validated crypto mode, with STIG and Iron Bank images.
  Roadmap: Security and accreditation
- **SAML and CAC login** · planned · admin
  Native SAML and CAC or PIV sign-in.
  Roadmap: Security and accreditation
- **Control mappings** · planned · admin
  Map controls to CMMC, NIST 800-171, NIST 800-53 and HIPAA.
  Roadmap: Security and accreditation
- **Teams** · planned · admin
  Share models and grant rights per team.
  Roadmap: v2

## Operations
- **Home** · shipped · product
  See models, serving and running jobs at a glance.
  UI: Home
- **Monitoring overview** · shipped · engineer, admin
  Chart requests, errors, latency and tokens per model, live.
  UI: Monitoring › Overview · API: GET /api/requests/overview
- **Request log** · shipped · engineer, admin
  Browse every /v1 call live, filtered, with its kept input.
  UI: Monitoring › Requests · API: GET /api/requests, GET /api/requests/facets, GET /api/requests/summary, GET /api/requests/{request_id} · Policy: log_retention_days
- **Jobs** · shipped · ml, admin
  Every job of every kind, by status; cancel, retry or delete.
  UI: Jobs · API: GET /api/jobs, GET /api/jobs/facets, GET /api/jobs/{job_id}, GET /api/jobs/{job_id}/events, POST /api/jobs/{job_id}/cancel, POST /api/jobs/{job_id}/retry, GET /api/artifacts/{artifact_id}
- **Job page** · shipped · product, ml, admin
  One job's progress, settings, data, loss and log; delete it.
  UI: Training › job, Jobs › job, Models › model › Versions › version · API: GET /api/jobs/{job_id}, GET /api/jobs/{job_id}/metrics, GET /api/jobs/{job_id}/events, POST /api/jobs/{job_id}/cancel, POST /api/jobs/{job_id}/retry, DELETE /api/jobs/{job_id}
- **Job log** · shipped · ml, admin
  Read a job's own events apart from library output, by level.
  UI: Jobs › job › Logs · API: GET /api/jobs/{job_id}/events
- **OpenTelemetry export** · shipped · admin
  Send traces and metrics to your own collector only.
  UI: Settings › Security › OpenTelemetry export · Policy: otel_protocol, otel_endpoint, otel_headers, otel_service_name, otel_ca_bundle · Config: OTEL_EXPORTER_OTLP_ENDPOINT
- **Prometheus metrics** · shipped · admin
  Scrape gateway, job and worker metrics by token or address.
  API: GET /metrics · Config: metrics, MINIBRAIN_METRICS_TOKEN, MINIBRAIN_METRICS_ADDRESSES
- **JSON logs** · shipped · admin
  Log JSON lines with request and response ids.
  Config: logging, MINIBRAIN_LOG_FORMAT
- **Grafana dashboard** · partial · admin
  Import a ready dashboard over the Prometheus metrics.
  Roadmap: Observability
- **Health checks** · shipped · admin
  Probe liveness and readiness from a load balancer.
  API: GET /healthz, GET /readyz
- **This install** · shipped · admin
  See versions, locations, pools and outbound access on one page.
  UI: Settings › This install · API: GET /api/system/install
- **Diagnostics** · shipped · admin
  Download a support zip with every secret scrubbed.
  UI: Settings › This install › Download diagnostics · API: GET /api/system/diagnostics
- **API reference** · shipped · engineer, ml
  Browse /v1 and /api with this install's examples and try calls.
  UI: User menu › API reference, Models › model › API · API: GET /api/openapi/v1.json, GET /api/openapi/api.json
- **OpenAPI schema** · shipped · engineer
  Print the /api and /v1 schema for generated clients.
  CLI: minibrain openapi
- **Install anywhere** · partial · admin
  Install with uvx, pip, Docker or one curl command.
  Roadmap: Platforms
- **Air-gapped bundle** · planned · admin
  Install from one offline bundle, tested in CI without network.
  Roadmap: Offline
- **Signed update bundles** · planned · admin
  Carry signed app and model updates across the gap, with rollback.
  Roadmap: Offline
- **PyPI releases** · planned · admin
  Publish wheels to PyPI through Trusted Publishing.
  Roadmap: v1 scope
- **Notifications** · planned · product, admin
  A bell for failed jobs, results to review and missing files.
  Roadmap: v2

## Settings
- **Appearance** · shipped · product
  Choose a light, dark or device theme.
  UI: Settings › General › Appearance
- **Settings search** · shipped · product, admin
  Find any setting by name or keyword.
  UI: Settings › Search
- **Install config file** · shipped · admin
  Provision every admin setting from minibrain.yaml, locked in the UI.
  Config: MINIBRAIN_CONFIG
- **Config export** · shipped · admin
  Print the effective settings as minibrain.yaml, secrets named only.
  CLI: minibrain config export
- **Config reload and schema** · planned · admin
  Reload minibrain.yaml on change and check it with a JSON Schema.
  Roadmap: Config file

## Use cases
- **Trade break triage** · partial · uses: Classify preset, Dataset versions, Scores
- **Term sheet extraction** · planned · uses: Extract preset, Structured output
- **Communications surveillance** · partial · uses: Classify preset, Promotion rule, Review queue
- **Research notes in house style** · planned · uses: General preset, Graders
- **Claims triage** · partial · uses: Classify preset, Dataset versions
- **Contract clause extraction** · planned · uses: Extract preset, Structured output
- **Clinical note coding** · planned · uses: Extract preset, Air-gapped bundle
- **Ticket routing** · partial · uses: Classify preset, Dataset versions, Deploy and roll back
- **Incident classification** · partial · uses: Classify preset, Feedback API
- **Request routing** · partial · uses: Classify preset, Train with feedback
- **Distil an assistant** · planned · uses: Distillation data, Upstream routes, General preset
