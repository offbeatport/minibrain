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
  within 3–8 steps, with SDPA and eager attention. Inference on MPS is fine, and CPU training was only ~1.8× slower.
- **One example per micro-batch keeps the Metal GPU alive** (same M1 Pro, 2026-11-05): batch 4 hung in the first
  steps (`kIOGPUCommandBufferCallbackErrorHang`), while batch 1 with 4 accumulation steps trained 40 steps of
  Qwen3-0.6B LoRA (160 rows, rank 8) in 83 s, to the same loss as the CPU. minibrain trains on MPS that way, and a
  job that still fails or stalls there starts again on the CPU.

## Training memory planner on Apple silicon (2026-11-05, Apple M1 Pro 16 GB)

`Qwen/Qwen3-0.6B` LoRA (r 16, all linear layers, dropout 0.05), 160 Banking77 rows, longest example 109 tokens, so a
112-token sequence length; effective batch 16, one epoch, torch 2.15, transformers 5.21, TRL 1.16. Measured peak is
the Metal driver's allocation on MPS and the process's peak resident memory on the CPU. GB are GiB, as on screen.

| Device | Precision | Checkpointing | Micro-batch | Planned peak | Measured peak | Time |
|---|---|---|---|---|---|---|
| MPS | fp32 | off | 1 | 3.7 GB | 3.4 GB | 92 s |
| MPS | fp32 | on | 1 | 3.1 GB | 2.8 GB | 228 s |
| CPU | fp32 | off | 8 | 9.6 GB | 4.8 GB | 156 s |

- **On MPS the plan is 8–11% above the measurement,** so the 85% headroom is not eaten by the estimate. The
  machine reports 11.8 GB of GPU-usable unified memory (`torch.mps.recommended_max_memory`).
- **Checkpointing saved 0.6 GB (16%) here but took 2.5× as long** at one row per micro-batch, so the planner turns it
  on only when the faster option does not fit.
- **On the CPU the plan is twice the measurement:** the activation and logit terms are conservative there. They are
  the same per-token terms as on CUDA, which no NVIDIA GPU has checked yet; QLoRA has not run either.
- Counting parameters from the shape matters for tied embeddings: Qwen3-0.6B's safetensors hold 0.75B values (the
  tied output layer is stored twice), but training holds 0.6B; weights from the file size were 0.6 GB too high.
