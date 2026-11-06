import { X } from "lucide-react";
import {
    Button,
    Field,
    NumberField,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import type { PresetsResponse, PromotionInfo, ThresholdInfo } from "~/api/client";
import { metricName } from "~/lib/metrics";

export const EXAMPLE_SCHEMA =
    '{\n  "type": "object",\n  "properties": {\n    "total": { "type": "number" }\n  },\n  "required": ["total"]\n}';

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

export function metricsFor(presets: PresetsResponse | undefined, names: string[]): string[] {
    const known = presets?.graders ?? [];
    return names.flatMap((name) => known.find((item) => item.name === name)?.metrics ?? []);
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
