import type { VersionInfo } from "~/api/client";

type Split = NonNullable<VersionInfo["held_out"]>;

const NAMES: Record<string, string> = {
    label_accuracy: "Label accuracy",
    macro_f1: "Macro F1",
    exact_match: "Exact match",
    json_valid: "JSON valid",
    json_field_match: "JSON field match",
    text_similarity: "Text similarity",
    judge: "Judge",
};

export function metricName(metric: string | null | undefined): string {
    if (!metric) {
        return "Score";
    }
    return NAMES[metric] ?? metric.replaceAll("_", " ");
}

export function metricOf(
    split: Split | null | undefined,
    metric: string | null | undefined,
): number | null {
    if (!split || !metric) {
        return null;
    }
    return split.scores.find((item) => item.metric === metric)?.value ?? null;
}
