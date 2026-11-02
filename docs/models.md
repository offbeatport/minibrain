# Models

## Catalogue

- Built at release by `scripts/build_catalog.py` from live Hugging Face metadata and bundled as a snapshot. At runtime
  minibrain never calls Hugging Face for the catalogue; the optional sync reads only our own catalogue URL
  (`MINIBRAIN_CATALOG_URL`).
- Rules: approved publishers (Qwen, Google, Meta, Mistral, Microsoft, IBM, NVIDIA, DeepSeek, OpenAI gpt-oss, Allen AI,
  HuggingFaceTB, Z.ai GLM), instruct or chat variants, reviewed commercial licences, architectures our engines support,
  safetensors present.
- GLM: GLM-4-0414 (`glm4`) and GLM-4.5 / 4.6 (`glm4_moe`) run on transformers 5, SGLang, mlx-lm and llama.cpp. GLM-4.5
  and 4.6 are hybrid reasoning models; minibrain turns thinking off through the chat template. GLM-4.5-Air and 4.6 are
  XL (mixture of experts, 106B and 355B).
- Every generation stays; older ones show "Newer version available".
- Size tiers: S ≤4B, M 7–14B, L 24–35B or a small mixture of experts, XL 70B+ (multi-GPU).
- Default order: recommended for the selected pool; also by popularity, size or name. Filters: hardware fit levels on
  the selected pool, can fine-tune, latest generation only, download access, publisher, task, size and licence (long
  groups show five options and "Show more"), with removable chips. Columns can be shown or hidden; a row opens the
  model's page (`/discover/<id>`): variants with fit, requirements, licence and files.
- Catalogue updates: Settings → General → Model catalogue (Check for updates, or every day).

## Add from Hugging Face

Paste a link or id; `main` reads that one repository's metadata, on request, from the configured endpoint (Hugging Face
or a mirror), checks `config.json`'s architecture and refuses architectures our engines do not run. Only when an admin sets the Model
sources [policy](security.md#policies) to Any; the default, Approved publishers, keeps everyone on the curated list.

## Sources

| Source | Configured by |
|---|---|
| Hugging Face or a mirror | `MINIBRAIN_HF_ENDPOINT` (or `HF_ENDPOINT`) |
| S3-compatible bucket | A full `s3://` URL, or a path under `MINIBRAIN_MODELS_S3_URL`; `AWS_ENDPOINT_URL_S3` for non-AWS stores |
| Folder on the server | A path |

Weights are pinned by repository and revision and fetched by a `download` or `import` [job](jobs.md).

## Import formats

- A Hugging Face format folder: `config.json`, the tokenizer and `.safetensors` weights, sharded or not.
- Pickle weights (`.bin`, `.pt`, `.pth`, `.pkl`, `.ckpt`) are refused: they can run code when loaded.
- An import whose revision and files match a catalogue variant is verified and takes the catalogue's details; anything
  else is listed as unverified.
- GGUF files run on llama.cpp, base models only ([engines](serving.md#engines)).
