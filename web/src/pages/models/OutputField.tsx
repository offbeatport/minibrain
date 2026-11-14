import { useQuery } from "@tanstack/react-query";
import { Textarea } from "obp-ui";
import { type ContractInfo, type OutputSuggestion, api, unwrap } from "~/api/client";
import { FormControl, FormRow } from "~/components/FormRows";
import { PickSelect } from "~/components/PickSelect";
import {
    ANSWER_KINDS,
    type AnswerKind,
    EXAMPLE_SCHEMA,
    answerKind,
    draftContract,
    labelsProblem,
    schemaProblem,
    startingSchema,
} from "./TaskFields";

export const OUTPUT_ID = "create-output";

export const OUTPUT_DETAIL_ID = "create-output-detail";

const ORDER: AnswerKind[] = ["labels", "json", "text"];

const META: Record<AnswerKind, string> = {
    labels: "one label per answer",
    json: "fields held to a schema",
    text: "any answer",
};

const PRESETS: Record<AnswerKind, "general" | "classify" | "custom"> = {
    text: "general",
    labels: "classify",
    json: "custom",
};

export type OutputDraft = {
    dataset: string | null;
    kind: AnswerKind;
    labels: string;
    schema: string;
    suggested: AnswerKind | null;
    basis: string | null;
};

export const BLANK_OUTPUT: OutputDraft = {
    dataset: null,
    kind: "text",
    labels: "",
    schema: EXAMPLE_SCHEMA,
    suggested: null,
    basis: null,
};

export function useOutputSuggestion(slug: string | null) {
    return useQuery({
        queryKey: ["datasets", slug, "output"],
        queryFn: () =>
            unwrap(
                api.GET("/api/datasets/{slug}/output", { params: { path: { slug: slug ?? "" } } }),
            ),
        enabled: slug !== null,
        retry: false,
        staleTime: 60_000,
    });
}

export function suggestedDraft(dataset: string, suggestion: OutputSuggestion): OutputDraft {
    const kind = answerKind(suggestion.contract);
    return {
        dataset,
        kind,
        labels: (suggestion.contract.labels ?? []).join(", "),
        schema: startingSchema(suggestion.contract),
        suggested: kind,
        basis: suggestion.basis,
    };
}

export function outputProblem(draft: OutputDraft): string | undefined {
    if (draft.kind === "labels") {
        return labelsProblem(draft.labels);
    }
    return draft.kind === "json" ? schemaProblem(draft.schema) : undefined;
}

export function outputBody(draft: OutputDraft): {
    preset: "general" | "classify" | "custom";
    contract?: ContractInfo;
} {
    const contract = draftContract(draft.kind, draft.labels, draft.schema);
    if (draft.kind === "text" || !contract) {
        return { preset: PRESETS.text };
    }
    return { preset: PRESETS[draft.kind], contract };
}

function shortName(kind: AnswerKind): string {
    return ANSWER_KINDS.find((item) => item.value === kind)?.short ?? kind;
}

function SuggestionLine({ draft, loading }: { draft: OutputDraft; loading: boolean }) {
    if (loading) {
        return <p className="text-sm text-muted-foreground">Reading the dataset's answers…</p>;
    }
    if (!draft.suggested || !draft.basis) {
        return null;
    }
    const text =
        draft.kind === draft.suggested
            ? `Suggested: ${draft.basis}.`
            : `The data suggests ${shortName(draft.suggested)}: ${draft.basis}.`;
    return <p className="text-sm text-muted-foreground">{text}</p>;
}

export function OutputField({
    draft,
    loading,
    error,
    onChange,
}: {
    draft: OutputDraft;
    loading: boolean;
    error: string | undefined;
    onChange: (draft: OutputDraft) => void;
}) {
    return (
        <FormRow
            id={OUTPUT_ID}
            label="Output"
            align="start"
            tip="What the model answers with. Version 0 is scored on it; change it later in Evaluation, How it's scored."
        >
            <FormControl width="wide">
                <div className="w-full sm:max-w-sm">
                    <PickSelect
                        id={OUTPUT_ID}
                        value={draft.kind}
                        onChange={(next) =>
                            onChange({
                                ...draft,
                                kind: ORDER.find((kind) => kind === next) ?? draft.kind,
                            })
                        }
                        options={ORDER.map((kind) => ({
                            value: kind,
                            label: shortName(kind),
                            meta:
                                kind === draft.suggested ? `${META[kind]} · suggested` : META[kind],
                        }))}
                    />
                </div>
                <SuggestionLine draft={draft} loading={loading} />
                {draft.kind === "labels" && (
                    <Textarea
                        id={OUTPUT_DETAIL_ID}
                        aria-label="Labels, separated by commas"
                        aria-invalid={error ? true : undefined}
                        className="max-h-[calc(6lh+0.875rem)] min-h-[calc(2lh+0.875rem)] overflow-y-auto"
                        value={draft.labels}
                        placeholder="billing, bug, refund"
                        onChange={(event) => onChange({ ...draft, labels: event.target.value })}
                    />
                )}
                {draft.kind === "json" && (
                    <Textarea
                        id={OUTPUT_DETAIL_ID}
                        aria-label="JSON schema"
                        aria-invalid={error ? true : undefined}
                        className="max-h-[calc(12lh+0.875rem)] min-h-[calc(6lh+0.875rem)] overflow-y-auto font-mono"
                        spellCheck={false}
                        value={draft.schema}
                        onChange={(event) => onChange({ ...draft, schema: event.target.value })}
                    />
                )}
                {error && <p className="text-sm text-destructive">{error}</p>}
            </FormControl>
        </FormRow>
    );
}
