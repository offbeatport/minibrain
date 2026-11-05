import { X } from "lucide-react";
import {
    Button,
    CheckboxSelect,
    Field,
    Input,
    NumberField,
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
    Switch,
    Textarea,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import type {
    ContractInfo,
    GraderConfig,
    PresetsResponse,
    PromotionInfo,
    ThresholdInfo,
} from "~/api/client";
import { metricName } from "~/lib/metrics";

export type AnswerKind = "text" | "json";

export type TaskDraft = {
    labels: string;
    answer: AnswerKind;
    schema: string;
    graders: string[];
    rubric: string;
    judge: string;
    instructions: string;
    promotion: PromotionInfo;
};

export const EMPTY_TASK: TaskDraft = {
    labels: "",
    answer: "text",
    schema: '{\n  "type": "object",\n  "properties": {\n    "total": { "type": "number" }\n  },\n  "required": ["total"]\n}',
    graders: [],
    rubric: "",
    judge: "",
    instructions: "",
    promotion: { thresholds: [], beats_live: true },
};

const OPERATORS: ThresholdInfo["op"][] = [">=", "<=", "==", ">", "<"];
const OPERATOR_NAMES: Record<ThresholdInfo["op"], string> = {
    ">=": "at least",
    "<=": "at most",
    "==": "exactly",
    ">": "above",
    "<": "below",
};

export function splitLabels(text: string): string[] {
    return [
        ...new Set(
            text
                .split(/[,\n]/)
                .map((label) => label.trim())
                .filter(Boolean),
        ),
    ];
}

export function schemaProblem(text: string): string | undefined {
    try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return "The schema must be a JSON object.";
        }
        return (parsed as { type?: unknown }).type === "object"
            ? undefined
            : 'The schema must describe an object: "type": "object".';
    } catch (error) {
        return `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
}

export function contractOf(preset: string, draft: TaskDraft): ContractInfo | null {
    if (preset !== "custom") {
        return null;
    }
    if (draft.answer === "text") {
        return { kind: "text" };
    }
    return schemaProblem(draft.schema)
        ? null
        : { kind: "json", json_schema: JSON.parse(draft.schema) };
}

function kindOf(preset: string, draft: TaskDraft): string {
    return preset === "classify" ? "labels" : draft.answer;
}

export function defaultGraders(
    presets: PresetsResponse | undefined,
    preset: string,
    draft: TaskDraft,
): string[] {
    const found = presets?.presets.find((item) => item.key === preset);
    return (found?.graders[kindOf(preset, draft)] ?? []).map((item) => item.name);
}

export function graderConfigs(
    preset: string,
    draft: TaskDraft,
    base: string,
): GraderConfig[] | null {
    if (preset !== "custom" || draft.graders.length === 0) {
        return null;
    }
    return draft.graders.map((name) =>
        name === "judge"
            ? { name, rubric: draft.rubric.trim(), model: draft.judge || base }
            : { name },
    );
}

export function metricsFor(presets: PresetsResponse | undefined, names: string[]): string[] {
    const known = presets?.graders ?? [];
    return names.flatMap((name) => known.find((item) => item.name === name)?.metrics ?? []);
}

export function PresetSelect({
    presets,
    value,
    onChange,
}: {
    presets: PresetsResponse | undefined;
    value: string;
    onChange: (preset: string) => void;
}) {
    return (
        <Field id="create-task" label="Task">
            <Select value={value} onValueChange={(next) => onChange(String(next ?? value))}>
                <SelectTrigger id="create-task" className="w-full">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {(presets?.presets ?? []).map((item) => (
                        <SelectItem key={item.key} value={item.key} description={item.hint}>
                            {item.label}
                        </SelectItem>
                    ))}
                    <SelectSeparator />
                    <SelectGroup>
                        <SelectLabel>Coming</SelectLabel>
                        {(presets?.planned ?? []).map((item) => (
                            <SelectItem
                                key={item.key}
                                value={item.key}
                                disabled
                                description={item.hint}
                            >
                                {item.label}
                            </SelectItem>
                        ))}
                    </SelectGroup>
                </SelectContent>
            </Select>
        </Field>
    );
}

export function ClassifyFields({
    draft,
    onChange,
    found,
    error,
}: {
    draft: TaskDraft;
    onChange: (draft: TaskDraft) => void;
    found: string[];
    error?: string;
}) {
    const typed = splitLabels(draft.labels);
    const extra = found.filter((label) => !typed.includes(label));
    return (
        <Field
            id="create-labels"
            label={found.length > 0 ? "Labels (optional)" : "Labels"}
            error={error}
            hint={
                found.length > 0
                    ? `Found in the data: ${found.join(", ")}. Labels you add here join them.`
                    : "At least two, separated by commas. Labels found in its data later join the set."
            }
        >
            <Input
                id="create-labels"
                aria-invalid={Boolean(error)}
                value={draft.labels}
                onChange={(event) => onChange({ ...draft, labels: event.target.value })}
                placeholder={
                    extra.length > 0 ? extra.slice(0, 4).join(", ") : "billing, bug, account"
                }
            />
        </Field>
    );
}

export function CustomFields({
    draft,
    onChange,
    presets,
    bases,
    base,
    problems,
}: {
    draft: TaskDraft;
    onChange: (draft: TaskDraft) => void;
    presets: PresetsResponse | undefined;
    bases: { key: string; name: string }[];
    base: string;
    problems: { schema?: string; rubric?: string; graders?: string };
}) {
    const kind = draft.answer;
    const options = (presets?.graders ?? [])
        .filter((item) => item.contracts.includes(kind))
        .map((item) => ({ value: item.name, label: item.label }));
    const choose = (answer: AnswerKind) => {
        const kept = draft.graders.filter((name) =>
            presets?.graders.find((item) => item.name === name)?.contracts.includes(answer),
        );
        onChange({
            ...draft,
            answer,
            graders:
                kept.length > 0 ? kept : defaultGraders(presets, "custom", { ...draft, answer }),
        });
    };
    return (
        <>
            <Field id="create-answer" label="Answer">
                <Select
                    value={kind}
                    onValueChange={(next) => choose(next === "json" ? "json" : "text")}
                >
                    <SelectTrigger id="create-answer" className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="text" description="Any text, checked by the graders">
                            Free text
                        </SelectItem>
                        <SelectItem value="json" description="JSON held to a schema you paste">
                            JSON schema
                        </SelectItem>
                    </SelectContent>
                </Select>
            </Field>
            {kind === "json" && (
                <Field
                    id="create-schema"
                    label="JSON schema"
                    error={problems.schema}
                    hint="Every answer is decoded to match it. Adding optional fields later is free; removing or renaming one needs a confirmation."
                >
                    <Textarea
                        id="create-schema"
                        aria-invalid={Boolean(problems.schema)}
                        className="min-h-40 font-mono"
                        spellCheck={false}
                        value={draft.schema}
                        onChange={(event) => onChange({ ...draft, schema: event.target.value })}
                    />
                </Field>
            )}
            <Field id="create-graders" label="Graders" error={problems.graders}>
                <CheckboxSelect
                    label="Graders"
                    allLabel="No graders"
                    noun="graders"
                    options={options}
                    value={draft.graders}
                    onValueChange={(graders) => onChange({ ...draft, graders })}
                />
            </Field>
            {draft.graders.includes("judge") && (
                <>
                    <Field
                        id="create-rubric"
                        label="Judge rubric"
                        error={problems.rubric}
                        hint="The judge scores each answer from 1 to 5 against this; scores are cached per answer, rubric and judge."
                    >
                        <Textarea
                            id="create-rubric"
                            aria-invalid={Boolean(problems.rubric)}
                            value={draft.rubric}
                            onChange={(event) => onChange({ ...draft, rubric: event.target.value })}
                            placeholder="Is the answer correct, complete and polite?"
                        />
                    </Field>
                    <Field id="create-judge" label="Judge model">
                        <Select
                            value={draft.judge || base}
                            onValueChange={(next) =>
                                onChange({ ...draft, judge: String(next ?? "") })
                            }
                        >
                            <SelectTrigger id="create-judge" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {bases.map((item) => (
                                    <SelectItem key={item.key} value={item.key}>
                                        {item.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>
                </>
            )}
            <Field
                id="create-instructions"
                label="Instructions (optional)"
                hint="The system prompt every version starts from. Leave it empty for the default."
            >
                <Textarea
                    id="create-instructions"
                    value={draft.instructions}
                    onChange={(event) => onChange({ ...draft, instructions: event.target.value })}
                />
            </Field>
        </>
    );
}

function ThresholdRow({
    threshold,
    metrics,
    onChange,
    onRemove,
}: {
    threshold: ThresholdInfo;
    metrics: string[];
    onChange: (threshold: ThresholdInfo) => void;
    onRemove: () => void;
}) {
    const choices = metrics.includes(threshold.metric) ? metrics : [threshold.metric, ...metrics];
    return (
        <div className="flex flex-wrap items-center gap-2">
            <Select
                value={threshold.metric}
                onValueChange={(next) =>
                    onChange({ ...threshold, metric: String(next ?? threshold.metric) })
                }
            >
                <SelectTrigger aria-label="Metric" className="w-48">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {choices.map((metric) => (
                        <SelectItem key={metric} value={metric}>
                            {metricName(metric)}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <Select
                value={threshold.op}
                onValueChange={(next) =>
                    onChange({ ...threshold, op: OPERATORS.find((op) => op === next) ?? ">=" })
                }
            >
                <SelectTrigger aria-label="Comparison" className="w-32">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {OPERATORS.map((op) => (
                        <SelectItem key={op} value={op}>
                            {OPERATOR_NAMES[op]}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            <NumberField
                aria-label="Threshold"
                value={threshold.value}
                min={0}
                max={1}
                step={0.01}
                format={{ style: "percent", maximumFractionDigits: 0 }}
                onValueChange={(value) => onChange({ ...threshold, value: value ?? 0 })}
                className="w-36"
            />
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove threshold"
                        onClick={onRemove}
                    >
                        <X aria-hidden="true" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent>Remove threshold</TooltipContent>
            </Tooltip>
        </div>
    );
}

export function PromotionEditor({
    id,
    value,
    metrics,
    onChange,
}: {
    id: string;
    value: PromotionInfo;
    metrics: string[];
    onChange: (value: PromotionInfo) => void;
}) {
    const thresholds = value.thresholds ?? [];
    const update = (index: number, next: ThresholdInfo) =>
        onChange({
            ...value,
            thresholds: thresholds.map((item, at) => (at === index ? next : item)),
        });
    const remove = (index: number) =>
        onChange({ ...value, thresholds: thresholds.filter((_, at) => at !== index) });
    const add = () =>
        onChange({
            ...value,
            thresholds: [
                ...thresholds,
                { metric: metrics[0] ?? "label_accuracy", op: ">=", value: 0.85 },
            ],
        });
    return (
        <Field
            id={id}
            label="Promotion rule"
            hint="A version goes live only when every threshold holds on its held-out rows."
        >
            <div className="flex flex-col gap-2">
                {thresholds.map((threshold, index) => (
                    <ThresholdRow
                        key={`${index}:${threshold.metric}`}
                        threshold={threshold}
                        metrics={metrics}
                        onChange={(next) => update(index, next)}
                        onRemove={() => remove(index)}
                    />
                ))}
                <div className="flex flex-wrap items-center gap-4">
                    <Button type="button" variant="outline" size="sm" onClick={add}>
                        Add threshold
                    </Button>
                    <label htmlFor={`${id}-beats`} className="flex items-center gap-2 text-sm">
                        <Switch
                            id={`${id}-beats`}
                            checked={value.beats_live ?? true}
                            onCheckedChange={(checked) =>
                                onChange({ ...value, beats_live: checked })
                            }
                        />
                        At least as good as the live version on its main metric
                    </label>
                </div>
            </div>
        </Field>
    );
}
