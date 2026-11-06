# Serving

## Control and serving planes

```mermaid
flowchart LR
    subgraph control["Control plane"]
        main["main"]
        db[("database")]
        main --- db
    end
    subgraph serving["Serving plane"]
        lb["HAProxy / Envoy / cloud LB"]
        g1["gateway"]
        g2["gateway"]
        e1["engine A<br/>adapters: x, y"]
        e2["engine B<br/>adapters: y, z"]
        lb --> g1 & g2
        g1 & g2 --> e1 & e2
    end
    main -- "versioned config snapshot" --> g1 & g2
    g1 & g2 -- "batched request logs" --> main
    e1 & e2 -- "announce every 10 s" --> main
```

- `main` publishes a versioned config snapshot: routes, current versions, key hashes and expiry, engine replicas per
  model, the request-log switch.
- Gateways keep the last good snapshot on disk and serve from it. A `main` outage or upgrade pauses the UI and new
  jobs, not inference.
- Rolling back a deployment is republishing an earlier snapshot.
- Endpoints (`/v1`, `/internal/gateway`): [`web/openapi.json`](../web/openapi.json).

## Request path

An inference request never touches the database.

| Step | Source |
|---|---|
| Key, scope, expiry | In-memory config snapshot (key hashes) |
| Route, version, adapter | Same snapshot |
| Engine replicas for the model | Same snapshot, refreshed from engine announcements |
| Replica choice | Per-gateway memory: in-flight counts, sticky map, health from 5 s checks |
| Request log, key last-used | Buffered, written in batches every ~2 s |

- Config is up to ~1 s stale: a revoked key stays valid for at most a second.
- Scale out: more gateway replicas behind HAProxy, Envoy or a cloud load balancer, then more engines. GPUs are the
  bottleneck long before gateways or the database.
- Very high log volume moves to ClickHouse or Parquet in object storage, or to sampling.

## Sampling

`/v1/chat/completions` takes OpenAI's sampling fields and the engine extensions vLLM and SGLang share. A field left
out is not sent, so the model's default applies: its `generation_config.json` on `transformers` and MLX (greedy when
it has none), the engine's own default on SGLang, vLLM and llama.cpp. A custom model answers at temperature 0 unless
the request sets one, the way its scores were measured.

| Field | Range | SGLang, vLLM | llama.cpp | MLX | `transformers` |
|---|---|---|---|---|---|
| `max_tokens`, `max_completion_tokens` | 1 or more; unset: the context limit | Passed on | Passed on | Passed on | Passed on |
| `temperature` | 0 to 2 | Passed on | Passed on | `make_sampler` | `GenerationConfig` |
| `top_p` | above 0, up to 1 | Passed on | Passed on | `make_sampler` | `GenerationConfig` |
| `top_k` | 1 or more | Passed on | Passed on | `make_sampler` | `GenerationConfig` |
| `min_p` | 0 to 1 | Passed on | Passed on | `make_sampler` | `GenerationConfig` |
| `presence_penalty`, `frequency_penalty` | -2 to 2 | Passed on | Passed on | Logits processor | Logits processor |
| `repetition_penalty` | above 0, up to 2 | Passed on | `repeat_penalty` | `make_logits_processors` | `GenerationConfig` |
| `seed` | any integer | Passed on | Passed on | `mx.random.seed` | `torch.manual_seed` |
| `stop` | up to 4 texts | Passed on, after the model's stop tokens | Passed on | Checked as it decodes | `stop_strings` |

- A value out of range, `n` above 1, `logprobs` or `logit_bias` is a 400 with an OpenAI `error` object naming the
  field in `param`. So is any body that fails validation on `/v1/chat/completions`.
- An engine that cannot honour a field (an older `mlx-lm` without `top_k` or `min_p`, or a server that refuses one)
  answers 400 with `code: unsupported_parameter` and the field in `param`, never silently ignoring it.
- Without `max_tokens` the answer runs to the end of the model's context (`max_position_embeddings`, or 4,096 tokens
  for llama.cpp's window).

## Structured output

`/v1/chat/completions` takes OpenAI's `response_format`: `{"type": "text"}`, `{"type": "json_object"}` or
`{"type": "json_schema", "json_schema": {"name", "schema", "strict"}}`.

| Request | SGLang | llama.cpp | MLX, `transformers` |
|---|---|---|---|
| Classify model, no `response_format` or `text` | Held to the labels (EBNF grammar) | Held to the labels (GBNF grammar) | Held to the labels (token trie) |
| `json_object` | Constrained (schema `{"type": "object"}`) | Constrained (grammar from the schema) | Free, then checked |
| `json_schema` | Constrained (`response_format` passed on) | Constrained (grammar from the schema) | Constrained when the schema has a finite set of answers (enums, booleans, objects of them); otherwise free, then checked |

- A custom model's contract is the default and stays in force: a request's `response_format` can only narrow a model
  whose contract is free text. A model that answers with labels or its own JSON schema refuses `json_object` and
  `json_schema` with a 400 (`param: response_format`, `code: unsupported_value`); `{"type": "text"}` is accepted and
  changes nothing. Base models take any format.
- A Classify answer stays the bare label, as before. If an engine refuses the label grammar, the gateway answers
  without it and logs a warning.
- Every JSON answer is checked against the schema in the gateway, whatever the engine. One that does not parse or
  match is a 422 with `error.code` `invalid_json` or `schema_mismatch`; an answer cut off by `max_tokens`
  (`finish_reason: length`) comes back as it is. A JSON answer inside a Markdown code fence is unwrapped.
- A malformed `response_format` or schema is a 400 with an OpenAI `error` object (`message`, `type`, `param`,
  `code`). A schema the engine cannot compile is a 400 too.
- Streaming works: the answer is checked, then streamed.
- The check covers `type`, `enum`, `const`, `properties`, `required`, `additionalProperties`, `items`,
  `prefixItems`, item and length bounds, number bounds, `anyOf`, `oneOf`, `allOf`, `not` and local `$ref`. It does
  not run `pattern` (a caller's regular expression could stall the gateway; llama.cpp applies it while decoding) or
  check `format`, `multipleOf` and `patternProperties`.
- `strict` is accepted and changes nothing: every answer is constrained, checked, or both.

## Engines

One engine process serves one base model with many adapters. It picks its engine when it starts, from its own
hardware and the model's weight format:

| Node | Weights | Engine |
|---|---|---|
| Linux, NVIDIA or AMD (ROCm), SGLang installed | safetensors | SGLang (`--enable-lora`, adapters loaded at runtime) |
| Linux, NVIDIA or AMD (ROCm), vLLM installed, no SGLang | safetensors | vLLM (`--enable-lora`, runtime LoRA updates on) |
| Apple silicon, `minibrain[mlx]` | safetensors | MLX (`mlx-lm`; PEFT LoRA converted on load, swapped per request) |
| Anything else | safetensors | `transformers` + PEFT |
| Any, `minibrain[llamacpp]` | GGUF | llama.cpp (Metal, CUDA or CPU); base models only |

- `--engine` overrides the choice. An automatic choice that fails to load falls back to `transformers`.
- Engines of different kinds serve at the same time: a Mac engine on MLX and a rack engine on SGLang can be replicas of
  one model.
- Remote engines: `minibrain engine --model KEY --main-url URL --pool NAME --host 0.0.0.0` pulls adapters from `main`
  and base weights from wherever Storage keeps them, never from Hugging Face, and announces its URL, engine and
  hardware every 10 s. With a bucket, `main` hands out a presigned link and the data key per file and the engine reads
  the bucket directly; with the folder, it reads the files from `main`. Either way it keeps a working copy in
  `<home>/engines/<key>/weights`, checks every file's size and SHA-256, and removes copies of models `main` no longer
  has when it starts and every 10 minutes.
- Local engines on `main` use `main`'s working copy, `<home>/models/<id>`, fetched from the bucket the first time they
  start when the model lives there.
- Fetching the working copy is its own step, before the engine loads the model: the engine answers `/health` with 503
  and `{"state": "fetching", "done", "total", "message"}`, announces state `fetching` (Infrastructure and the Models
  list say "Fetching weights") and logs its progress every 30 s. Each file gets a freshly signed link, so a fetch
  longer than the links' 15 minutes still completes. A request to a model that is still fetching waits up to 60 s,
  then gets a 503 that says how far the fetch is; the 600 s startup window starts only when loading starts. A fetch
  that fails says so and loads nothing.
- `main` starts a local engine for a deployed model only when no live replica serves it elsewhere, and starts one
  again when the remote replicas go away.
- Scale is horizontal: more replicas of the same model, on Kubernetes autoscaled. Heavy engines are optional extras;
  SGLang and vLLM pin their own torch and CUDA, so each runs from its own environment (`MINIBRAIN_SGLANG_PYTHON`,
  `MINIBRAIN_VLLM_PYTHON`). The vLLM engine shares SGLang's request path (an OpenAI-compatible server per base model)
  and has not been run on a GPU yet.

## Routing

Each gateway routes per model across its replicas, with no new setting:

| Rule | Detail |
|---|---|
| Health | Ready replicas first, then loading; a failed request or health check marks a replica down for 10 s |
| Least busy | New work goes to the replica with the fewest requests in flight |
| Sticky | By adapter (so the adapter stays loaded), by prompt prefix for base models (so the KV cache is reused) |
| Overflow | A sticky replica with 4 requests in flight hands new requests to a less busy one; the binding stays |
| Failover | Another replica is tried at once; the key rebinds to the replica that answered |

In front of gateways: HAProxy, Envoy or a cloud load balancer. Under the gateway, per pool, later: sgl-router or
llm-d. llm-d needs Kubernetes (Gateway API inference extension, its own scheduler), and minibrain must run without it.
sgl-router only routes SGLang and pays off with many SGLang replicas of one model; then it slots under the gateway as
one replica per pool, and the gateway keeps keys, routes and adapters.

## Compute pools

A pool is a named group of machines. Workers and engines join one with `--pool NAME` (default `local`, shown as "This
machine") and report their hardware when they register, each time a worker asks for work and each time an engine
announces itself.

| Reported | Example |
|---|---|
| Platform, architecture | `linux`, `x86_64` |
| Accelerator | `cuda`, `rocm`, `xpu`, `mps`, `cpu`, with the GPU name |
| GPUs | Each with its memory |
| Memory for models | Sum of GPU memory; Apple GPU-usable unified memory; RAM on CPU |
| CPU, RAM | Cores, bytes |
| Engines installed | `sglang`, `vllm`, `mlx`, `transformers`, `llamacpp` |

- The Compute page lists pools, their machines (online if seen in the last 2 minutes) and the engines serving.
- Discover judges hardware fit against the selected pool: the best machine in the pool decides. Multi-GPU (XL)
  models need a machine with two or more GPUs.
- Machines unseen for 7 days and engines unseen for an hour are forgotten.

## Flows

### Inference request

```mermaid
sequenceDiagram
    participant App
    participant LB as Load balancer
    participant GW as Gateway
    participant EN as Engine
    participant MA as main
    App->>LB: POST /v1/chat/completions (API key)
    LB->>GW: HTTPS :443 to :8100
    GW->>GW: Check key hash, pick engine (fewest in flight, sticky by adapter)
    GW->>EN: POST /generate (model, adapter ID)
    opt Adapter not loaded yet
        EN->>MA: Pull adapter by artifact ID
    end
    EN-->>GW: Completion
    GW-->>App: Response or stream
    GW-)MA: Request logs, batched every 2 s
```

### Deploy a version

```mermaid
sequenceDiagram
    participant UI as Browser
    participant MA as main
    participant GW as Gateway
    participant EN as Engine
    UI->>MA: Promote v2
    MA->>MA: Set current version
    MA->>MA: Rebuild config snapshot (about 1 s)
    GW->>MA: GET /internal/gateway/config (ETag, long-poll)
    MA-->>GW: New snapshot
    Note over GW: Next request for the model routes to v2
    GW->>EN: First request with the v2 adapter
    EN->>MA: Pull adapter by artifact ID
```

### An engine joins

```mermaid
sequenceDiagram
    participant EN as Engine (GPU box)
    participant MA as main
    participant GW as Gateway
    EN->>MA: Announce pool, hardware, engine kind, models
    MA->>MA: Record in pool, add to config
    GW->>MA: Config long-poll
    MA-->>GW: Snapshot with the new engine
    EN->>MA: Base file list (presigned links and data keys when in a bucket)
    EN->>EN: Fetch each file from the bucket or main, check SHA-256
    loop Every 10 s
        EN->>MA: Announce: alive, loaded adapters, load
    end
    Note over MA,GW: No announcement for 30 s: dropped from routing
```
