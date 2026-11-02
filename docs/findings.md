# Findings

Measured results that shaped the design. The code that produced them is in git history (`spikes/banking77`, removed
on 2026-11-02).

## Banking77: prompting vs LoRA (2026-10-29, Apple M1 Pro 16 GB)

Classify, 77 banking intents ([PolyAI/banking77](https://huggingface.co/datasets/PolyAI/banking77), CC-BY-4.0) on
`Qwen/Qwen3-0.6B` with thinking disabled. Golden set 50 and eval 500 from the test split; 10 few-shot examples and
9,993 training rows from the train split (seed 7).

| Version | Golden accuracy | Eval accuracy | Eval macro F1 | Invalid | p50 | p95 | Prompt tokens |
|---|---|---|---|---|---|---|---|
| Prompt only: label list and 10 few-shot turns | 32.0% | 43.0% | 0.393 | 6.0% | 429 ms | 484 ms | 758 |
| LoRA (r 16, all linear layers), short prompt | 76.0% | 83.6% | 0.818 | 2.2% | 188 ms | 284 ms | 45 |

- Training: 5,000 rows, 1 epoch, effective batch 16, on CPU, 38.8 minutes.
- Latency: per request, unbatched, MPS inference in fp32.

- **Training beats prompting by a wide margin:** eval accuracy 43% → 84%, 2.3× lower median latency, 17× fewer prompt
  tokens because the label list is no longer needed.
- **Chat template parity:** with thinking disabled on both sides, the serving prompt ends with an empty think block and
  training continues it with `label<|im_end|>`.
- **Few-shot examples must not come from the golden set,** or the prompt-only version is scored on its own examples.
- **Invalid labels stay at 2.2% with free generation.** Constrained decoding (`response_format: json_schema` on
  SGLang) should take this to zero.
- **50 golden examples are noisy:** one row moves the score 2 points, and golden and eval differ by 8–11 points.
  Promotion uses the larger held-out split, not the golden set alone.
- **The Metal GPU hangs during LoRA backward** (M1 Pro, macOS 27.0.1, torch 2.15): `kIOGPUCommandBufferCallbackError`
  within 3–8 steps, with SDPA and eager attention. Inference on MPS is fine, and CPU training was only ~1.8× slower,
  so minibrain trains on the CPU on Apple silicon (`MINIBRAIN_TRAIN_DEVICE` overrides).
