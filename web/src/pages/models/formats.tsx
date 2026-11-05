import type { CatalogEntry, CatalogVariantInfo } from "~/api/client";

type Weights = Pick<CatalogVariantInfo, "format" | "precision">;

const FULL_PRECISION = new Map([
    ["bf16", "BF16"],
    ["bfloat16", "BF16"],
    ["fp16", "FP16"],
    ["f16", "FP16"],
    ["float16", "FP16"],
    ["fp32", "FP32"],
    ["f32", "FP32"],
    ["float32", "FP32"],
]);

export type FormatKind = "full" | "quantized";

export const FORMAT_KINDS: { value: FormatKind; label: string }[] = [
    { value: "full", label: "Full precision" },
    { value: "quantized", label: "Quantized" },
];

export function quantized(variant: Weights): boolean {
    return !FULL_PRECISION.has(variant.precision.toLowerCase());
}

export function trainable(variant: Weights): boolean {
    return variant.format !== "gguf" && !quantized(variant);
}

export function scheme(variant: Weights): string {
    return FULL_PRECISION.get(variant.precision.toLowerCase()) ?? variant.precision.toUpperCase();
}

export function formatKind(variant: Weights): FormatKind {
    return quantized(variant) ? "quantized" : "full";
}

export function formatName(variant: Weights): string {
    const kind = FORMAT_KINDS.find((item) => item.value === formatKind(variant))?.label;
    return `${kind} · ${scheme(variant)}`;
}

export function formatUse(variant: Weights): string {
    return trainable(variant) ? "Trainable" : "Serve only";
}

export function fileType(variant: Weights): string {
    return variant.format === "gguf" ? "GGUF" : "Safetensors";
}

export function schemes(entry: CatalogEntry): string[] {
    return [...new Set(entry.variants.map(scheme))];
}

export function formatKinds(entry: CatalogEntry): FormatKind[] {
    return [...new Set(entry.variants.map(formatKind))];
}

export function FormatHelp() {
    return (
        <dl className="flex flex-col gap-2 p-1.5 text-left text-pretty">
            <div className="flex flex-col gap-0.5">
                <dt className="font-medium">Full precision</dt>
                <dd className="opacity-75">
                    The weights as published, usually BF16. Trains and serves.
                </dd>
            </div>
            <div className="flex flex-col gap-0.5">
                <dt className="font-medium">Quantized</dt>
                <dd className="opacity-75">
                    Weights stored in fewer bits: smaller and faster to serve, slightly less
                    accurate. Serve only: it can't be fine-tuned, so training needs full precision.
                </dd>
            </div>
        </dl>
    );
}
