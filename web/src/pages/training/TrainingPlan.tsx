import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
    Badge,
    Button,
    Field,
    InfoTip,
    NumberField,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "obp-ui";
import { useState } from "react";
import { type TrainingOptionInfo, type TrainingPlanInfo, api, unwrap } from "~/api/client";
import { keys } from "~/api/queries";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { bytes } from "~/lib/time";

export type Strategy = "lora" | "qlora";

export type TrainingChoices = {
    strategy: Strategy | null;
    checkpointing: boolean | null;
    micro_batch: number | null;
    seq_len: number | null;
    rank: number | null;
    learning_rate: number | null;
    epochs: number | null;
    max_rows: number | null;
};

export const NO_CHOICES: TrainingChoices = {
    strategy: null,
    checkpointing: null,
    micro_batch: null,
    seq_len: null,
    rank: null,
    learning_rate: null,
    epochs: null,
    max_rows: null,
};

const AUTO = "auto";
const STRATEGY_NAMES: Record<Strategy, string> = { lora: "LoRA", qlora: "QLoRA 4-bit" };
const PART_NAMES: Record<string, string> = {
    weights: "Base weights",
    adapter: "Adapter and optimiser",
    activations: "Activations",
    logits: "Logits",
    overhead: "Runtime",
};

type Chosen = { [K in keyof TrainingChoices]?: NonNullable<TrainingChoices[K]> };

export function chosenSettings(choices: TrainingChoices): Chosen {
    return Object.fromEntries(
        Object.entries(choices).filter(([, value]) => value !== null),
    ) as Chosen;
}

export function useTrainingPlan(slug: string, snapshot: number | null, choices: TrainingChoices) {
    const query = {
        ...chosenSettings(choices),
        ...(snapshot === null ? {} : { snapshot_id: snapshot }),
    };
    return useQuery({
        queryKey: [...keys.model(slug), "training-plan", query],
        queryFn: () =>
            unwrap(
                api.GET("/api/models/{slug}/training-plan", {
                    params: { path: { slug }, query },
                }),
            ),
        placeholderData: keepPreviousData,
        retry: false,
    });
}

function tone(plan: TrainingPlanInfo) {
    if (plan.level === "fits") {
        return "success" as const;
    }
    return plan.level === "insufficient" ? ("destructive" as const) : ("neutral" as const);
}

function Breakdown({ option }: { option: TrainingOptionInfo }) {
    return (
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 tabular-nums">
            {Object.entries(option.parts).map(([part, value]) => (
                <div key={part} className="contents">
                    <dt>{PART_NAMES[part] ?? part}</dt>
                    <dd className="text-right">{bytes(value)}</dd>
                </div>
            ))}
        </dl>
    );
}

function Basis({ plan }: { plan: TrainingPlanInfo }) {
    const context = plan.context ? `, capped by the ${count(plan.context)}-token context` : "";
    return (
        <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2 text-sm">
                {plan.level === "insufficient" ? (
                    <StatusText tone="destructive">Cannot train here</StatusText>
                ) : (
                    <StatusText tone={tone(plan)} className="whitespace-normal">
                        {plan.basis}
                    </StatusText>
                )}
                {plan.machine && plan.level !== "insufficient" && (
                    <span className="text-muted-foreground">{`on ${plan.machine}`}</span>
                )}
                <InfoTip label="How the plan is chosen">
                    {`The fastest strategy whose estimated peak memory stays under 85% of the machine's. Rows are ${count(plan.seq_len)} tokens: the longest example, about ${count(plan.longest_tokens)} tokens${context}.`}
                </InfoTip>
            </div>
            {plan.level === "insufficient" && (
                <p className="text-sm text-destructive">{plan.basis}</p>
            )}
            {plan.note && <p className="text-sm text-muted-foreground">{plan.note}</p>}
        </div>
    );
}

function OptionStatus({ option, chosen }: { option: TrainingOptionInfo; chosen: boolean }) {
    if (chosen) {
        return <Badge variant="success">Chosen</Badge>;
    }
    if (!option.supported) {
        return <span className="text-muted-foreground">{option.reason}</span>;
    }
    return option.fits ? (
        <StatusText tone="success">Fits</StatusText>
    ) : (
        <StatusText tone="destructive">Does not fit</StatusText>
    );
}

function same(left: TrainingOptionInfo | null, right: TrainingOptionInfo): boolean {
    return (
        left !== null &&
        left.strategy === right.strategy &&
        left.checkpointing === right.checkpointing &&
        left.micro_batch === right.micro_batch
    );
}

function Options({ plan }: { plan: TrainingPlanInfo }) {
    if (plan.options.length === 0) {
        return null;
    }
    return (
        <div className="overflow-x-auto rounded-md border">
            <Table className="min-w-[520px]">
                <TableHeader>
                    <TableRow>
                        <TableHead>Strategy</TableHead>
                        <TableHead className="text-right">Peak memory</TableHead>
                        <TableHead className="text-right">Rows at once</TableHead>
                        <TableHead>Status</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {plan.options.map((option) => (
                        <TableRow key={`${option.strategy}-${option.checkpointing}`}>
                            <TableCell>{option.label}</TableCell>
                            <TableCell className="text-right tabular-nums">
                                <span className="inline-flex items-center gap-1.5">
                                    {bytes(option.peak_bytes)}
                                    <InfoTip label={`${option.label} memory`} side="left">
                                        <Breakdown option={option} />
                                    </InfoTip>
                                </span>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                                {option.micro_batch}
                            </TableCell>
                            <TableCell>
                                <OptionStatus option={option} chosen={same(plan.chosen, option)} />
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

function strategyDefault(plan: TrainingPlanInfo | undefined): string {
    const strategy = plan?.defaults.strategy as Strategy | null | undefined;
    return strategy ? STRATEGY_NAMES[strategy] : "chosen by the plan";
}

function onOff(value: boolean | null | undefined): string {
    if (value === null || value === undefined) {
        return "chosen by the plan";
    }
    return value ? "on" : "off";
}

function hint(value: number | null | undefined): string {
    return value === null || value === undefined
        ? "Default: chosen by the plan"
        : `Default: ${value}`;
}

function SettingsFields({
    choices,
    onChange,
    plan,
}: {
    choices: TrainingChoices;
    onChange: (next: TrainingChoices) => void;
    plan: TrainingPlanInfo | undefined;
}) {
    const defaults = plan?.defaults;
    const set = (patch: Partial<TrainingChoices>) => onChange({ ...choices, ...patch });
    return (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-field">
            <Field id="strategy" label="Strategy" hint={`Default: ${strategyDefault(plan)}`}>
                <Select
                    value={choices.strategy ?? AUTO}
                    onValueChange={(next) =>
                        set({ strategy: next === AUTO ? null : (next as Strategy) })
                    }
                >
                    <SelectTrigger id="strategy">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={AUTO}>Automatic</SelectItem>
                        <SelectItem value="lora">{STRATEGY_NAMES.lora}</SelectItem>
                        <SelectItem value="qlora">{STRATEGY_NAMES.qlora}</SelectItem>
                    </SelectContent>
                </Select>
            </Field>
            <Field
                id="checkpointing"
                label="Gradient checkpointing"
                hint={`Default: ${onOff(defaults?.checkpointing)}`}
            >
                <Select
                    value={
                        choices.checkpointing === null ? AUTO : choices.checkpointing ? "on" : "off"
                    }
                    onValueChange={(next) =>
                        set({ checkpointing: next === AUTO ? null : next === "on" })
                    }
                >
                    <SelectTrigger id="checkpointing">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={AUTO}>Automatic</SelectItem>
                        <SelectItem value="on">On</SelectItem>
                        <SelectItem value="off">Off</SelectItem>
                    </SelectContent>
                </Select>
            </Field>
            <Field id="micro-batch" label="Micro-batch" hint={hint(defaults?.micro_batch)}>
                <NumberField
                    id="micro-batch"
                    value={choices.micro_batch}
                    onValueChange={(micro_batch) => set({ micro_batch })}
                    placeholder={defaults?.micro_batch ? String(defaults.micro_batch) : undefined}
                    min={1}
                    max={64}
                    step={1}
                    format={{ maximumFractionDigits: 0 }}
                />
            </Field>
            <Field id="seq-len" label="Sequence length" hint={hint(defaults?.seq_len)}>
                <NumberField
                    id="seq-len"
                    value={choices.seq_len}
                    onValueChange={(seq_len) => set({ seq_len })}
                    placeholder={defaults ? String(defaults.seq_len) : undefined}
                    min={32}
                    step={64}
                    format={{ maximumFractionDigits: 0 }}
                />
            </Field>
            <Field id="rank" label="LoRA rank" hint={hint(defaults?.rank)}>
                <NumberField
                    id="rank"
                    value={choices.rank}
                    onValueChange={(rank) => set({ rank })}
                    placeholder={defaults ? String(defaults.rank) : undefined}
                    min={1}
                    max={64}
                    step={8}
                    format={{ maximumFractionDigits: 0 }}
                />
            </Field>
            <Field id="learning-rate" label="Learning rate" hint={hint(defaults?.learning_rate)}>
                <NumberField
                    id="learning-rate"
                    value={choices.learning_rate}
                    onValueChange={(learning_rate) => set({ learning_rate })}
                    placeholder={defaults ? String(defaults.learning_rate) : undefined}
                    min={0.000001}
                    max={0.01}
                    step={0.00005}
                    format={{ maximumSignificantDigits: 3 }}
                />
            </Field>
        </div>
    );
}

export function TrainingPlanPanel({
    plan,
    error,
    choices,
    onChange,
}: {
    plan: TrainingPlanInfo | undefined;
    error: unknown;
    choices: TrainingChoices;
    onChange: (next: TrainingChoices) => void;
}) {
    const [open, setOpen] = useState(false);
    const changed = Object.values(chosenSettings(choices)).length > 0;
    return (
        <div className="flex flex-col gap-3 border-t pt-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="text-sm font-medium">Training plan</h3>
                    {plan ? (
                        <Basis plan={plan} />
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            {error ? "No plan for these settings." : "Planning…"}
                        </p>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    {changed && (
                        <Button variant="ghost" size="sm" onClick={() => onChange(NO_CHOICES)}>
                            Reset to defaults
                        </Button>
                    )}
                    <Button
                        variant="outline"
                        size="sm"
                        aria-expanded={open}
                        onClick={() => setOpen(!open)}
                    >
                        {open ? "Hide settings" : "Settings"}
                    </Button>
                </div>
            </div>
            {plan && <Options plan={plan} />}
            {open && <SettingsFields choices={choices} onChange={onChange} plan={plan} />}
        </div>
    );
}
