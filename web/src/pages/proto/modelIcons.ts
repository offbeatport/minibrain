export type SampleModel = { name: string; base: string; version: number };

export const MODELS: SampleModel[] = [
    { name: "Support triage", base: "Qwen3 0.6B", version: 4 },
    { name: "Invoice extractor", base: "Gemma 3 1B", version: 2 },
    { name: "guy1", base: "Llama 3.2 1B", version: 1 },
    { name: "Assistant 1", base: "Qwen3 4B", version: 7 },
    { name: "Contract reviewer", base: "Ministral 8B", version: 3 },
    { name: "SQL helper", base: "Phi-4 mini", version: 5 },
];
