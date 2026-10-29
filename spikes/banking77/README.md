# Spike: Banking77, Mac half

End-to-end check of the core path on one task, before any platform code: prompt-only version 0 → LoRA training →
eval on the same examples → serving through an OpenAI-compatible endpoint. See `ROADMAP.md` for the plan this tests.

- Task: Classify, 77 banking intents ([PolyAI/banking77](https://huggingface.co/datasets/PolyAI/banking77), CC-BY-4.0,
  pinned commit).
- Model: `Qwen/Qwen3-0.6B`, pinned commit. Thinking disabled in every rendered prompt.
- Splits (seed 7): golden set 50 and eval 500 from the test split; 10 few-shot examples and 9,993 training rows from
  the train split. Few-shot examples never come from the golden or eval sets.
- Versions:
  - `banking77@0`: prompt-only. Base model, the full label list in the system prompt, 10 few-shot turns.
  - `banking77@1`: LoRA (r 16, all linear layers), short system prompt with no label list.

## Run

```sh
uv run python -m spikes.banking77.data
uv run pytest -q
uv run python -m spikes.banking77.evaluate banking77@0
uv run python -m spikes.banking77.train
uv run python -m spikes.banking77.evaluate banking77@1
uv run python -m spikes.banking77.report
uv run uvicorn spikes.banking77.serve:app --port 8000
uv run python -m spikes.banking77.call
```

Outputs land in `spikes/banking77/out/` (ignored by git). On the M1 Pro, train with
`--limit 5000 --batch-size 8 --grad-accum 2 --device cpu` (see Findings).

## Results (2026-10-29, Apple M1 Pro 16 GB)

| Version | Golden accuracy | Eval accuracy | Eval macro F1 | Invalid | p50 | p95 | Prompt tokens |
|---|---|---|---|---|---|---|---|
| `banking77@0` | 32.0% | 43.0% | 0.393 | 6.0% | 429 ms | 484 ms | 758 |
| `banking77@1` | 76.0% | 83.6% | 0.818 | 2.2% | 188 ms | 284 ms | 45 |

- Training: 5,000 rows, 1 epoch, 313 steps, effective batch 16, on CPU: 38.8 minutes, final loss ~0.07–0.11.
- Latency is per request, unbatched, on the golden set (MPS inference, fp32).
- Serving: `/v1/models` lists `qwen3-0.6b`, `banking77`, `banking77@0`, `banking77@1`; the OpenAI Python client gets
  `card_arrival` from all three minibrain names. `banking77` resolves to `@1`; adapters switch per request in one
  process.

## Findings

- **Training beats prompting by a wide margin on this task**: eval accuracy 43% → 84%, 2.3× lower median latency,
  17× fewer prompt tokens (no label list needed).
- **Chat template parity holds**, with thinking disabled on both sides: the serving prompt ends with an empty think
  block and training continues it with `label<|im_end|>`. Four tests in `test_parity.py` pin this down.
- **Few-shot examples must not come from the golden set**, or version 0 is scored on examples in its own prompt.
  `ROADMAP.md` is corrected.
- **Invalid labels remain at 2.2%** with free generation. Constrained decoding (`response_format: json_schema` enum
  on SGLang) should take this to zero; the GPU half checks it.
- **50 golden examples are noisy**: one row moves the score 2 points, and golden vs eval differ by 8–11 points for
  both versions. Promotion decisions need the larger held-out split, not the golden set alone.
- **Metal GPU hangs during LoRA backward** on this M1 Pro (macOS 27.0.1, torch 2.15): `kIOGPUCommandBufferCallbackError`
  within 3–8 steps, with SDPA and eager attention, batch 16 and 8. Inference on MPS is fine. CPU training was only
  ~1.8× slower than MPS steps before the hang, so local mode needs an automatic CPU fallback.

## Not covered here (GPU half)

Teacher as version 0 (Qwen3-32B or similar), the 4B student on full data, SGLang with runtime adapter loading, the
`<base>:<adapter>` model name, constrained decoding, and cost per 1,000 requests.
