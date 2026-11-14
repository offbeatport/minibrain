# Demo data

Bundled files for the Classify task. Add one under Data › Add › Demo data; the input and label columns are detected
automatically.

| File | Rows | Labels | Format | What it shows |
|---|---|---|---|---|
| `demo_travel_intents.jsonl` | 750 | 5 | JSON Lines | The quick demo. Prompting is already enough; training only buys speed |
| `demo_banking77.csv` | 13,083 | 77 | CSV | Where training pays: many similar labels |
| `demo_clinc150.parquet` | 23,850 | 151 | Parquet | The hard one: 150 intents plus `oos` (out of scope) |

## Measured on an Apple M1 Pro (Qwen3-0.6B, CPU training)

| File | Version | Held-out accuracy | Invalid labels | p50 latency | Prompt tokens | Training time |
|---|---|---|---|---|---|---|
| `demo_travel_intents.jsonl` | Prompt-only | 100% | 0% | 202 ms | 247 | – |
| `demo_travel_intents.jsonl` | Trained, 400 rows | 100% | 0% | 160 ms | 44 | 2.9 min |
| `demo_banking77.csv` | Prompt-only | 42.8% | 6.4% | 608 ms | 696 | – |
| `demo_banking77.csv` | Trained, 400 rows | 14.4% | 77.8% | 163 ms | 43 | 2.9 min |
| `demo_banking77.csv` | Trained, 5,000 rows (spike) | 83.6% | 2.2% | 188 ms | 45 | 39 min |

400 rows across 77 labels is about five examples per label: too few, and the model invents labels. Use 3,000 or more
for Banking77 and CLINC150.

## Sources and licenses

- **Banking77**: Casanueva et al., "Efficient Intent Detection with Dual Sentence Encoders", PolyAI, 2020.
  [PolyAI/banking77](https://huggingface.co/datasets/PolyAI/banking77), CC BY 4.0.
- **CLINC150**: Larson et al., "An Evaluation Dataset for Intent Classification and Out-of-Scope Prediction", EMNLP
  2019. [clinc/clinc_oos](https://huggingface.co/datasets/clinc/clinc_oos) (`plus` configuration), CC BY 3.0.

Changes from the originals: train, validation and test splits merged and shuffled (seed 7), label ids replaced by
their names, and `demo_travel_intents.jsonl` filtered from CLINC150 to `book_flight`, `book_hotel`, `car_rental`,
`flight_status` and `lost_luggage`. Rebuild with `uv run python demo_data/build.py`; dataset commits are pinned there.
