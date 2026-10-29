import json

from spikes.banking77.config import RESULTS_DIR

HEADER = (
    "| Version | Golden accuracy | Eval accuracy | Eval macro F1 | Invalid | p50 | p95 | Prompt tokens |\n"
    "|---|---|---|---|---|---|---|---|"
)


def row(result: dict) -> str:
    golden, held_out, latency = result["golden"], result["eval"], result["latency"]
    cells = [
        f"`{result['version']}`",
        f"{golden['accuracy']:.1%}",
        f"{held_out['accuracy']:.1%}",
        f"{held_out['macro_f1']:.3f}",
        f"{held_out['invalid_rate']:.1%}",
        f"{latency['p50_ms']:.0f} ms",
        f"{latency['p95_ms']:.0f} ms",
        f"{result['prompt_tokens']:.0f}",
    ]
    return "| " + " | ".join(cells) + " |"


def main() -> None:
    results = [json.loads(path.read_text()) for path in sorted(RESULTS_DIR.glob("*.json"))]
    print("\n".join([HEADER, *(row(result) for result in results)]))


if __name__ == "__main__":
    main()
