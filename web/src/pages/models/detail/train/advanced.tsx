import {
    Field,
    NumberField,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import type { ReactNode } from "react";
import { count } from "~/lib/format";
import { Row } from "./parts";
import {
    ACCUM_CHOICES,
    type Auto,
    type Issue,
    LEARNING_RATES,
    MAX_RANK,
    MICRO_CHOICES,
    type PlanInfo,
    type Recipe,
    type Strategy,
    strategyName,
} from "./recipe";

type Change = (patch: Partial<Recipe>) => void;

const WHOLE = { maximumFractionDigits: 0 };

function Warn({ children }: { children: ReactNode }) {
    return <span className="text-warning">{children}</span>;
}

function Group({ id, label, children }: { id: string; label: string; children: ReactNode }) {
    return (
        <Row id={id} label={<span className="font-normal text-muted-foreground">{label}</span>}>
            <div className="grid gap-x-field gap-y-6 pt-1 sm:grid-cols-2">{children}</div>
        </Row>
    );
}

function errorFor(issues: Issue[], field: keyof Recipe): string | undefined {
    return issues.find((issue) => issue.field === field)?.text;
}

function ChoiceSelect<T extends string | number | boolean>({
    id,
    value,
    choices,
    onChange,
}: {
    id: string;
    value: Auto<T>;
    choices: { value: Auto<T>; label: string }[];
    onChange: (value: Auto<T>) => void;
}) {
    const key = (item: Auto<T>) => String(item);
    return (
        <Select
            value={key(value)}
            onValueChange={(next) => {
                const found = choices.find((item) => key(item.value) === next);
                if (found) {
                    onChange(found.value);
                }
            }}
        >
            <SelectTrigger id={id} className="w-full">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {choices.map((item) => (
                    <SelectItem key={key(item.value)} value={key(item.value)} label={item.label}>
                        <span className="tabular-nums">{item.label}</span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function rate(value: number): string {
    return value.toExponential(0).replace("e-", "e-");
}

export function Advanced({
    recipe,
    onChange,
    plan,
    available,
    heldOut,
    issues,
    next,
}: {
    recipe: Recipe;
    onChange: Change;
    plan: PlanInfo | undefined;
    available: number;
    heldOut: number;
    issues: Issue[];
    next: number;
}) {
    const chosen = plan?.chosen;
    const machine = plan?.machine ?? "the machine";
    const alpha = recipe.alpha === "auto" ? recipe.rank * 2 : recipe.alpha;
    const rows = recipe.maxRows === "all" ? available : recipe.maxRows;
    const longest = plan?.longest_tokens ?? 0;
    const seq = plan?.seq_len ?? (recipe.seqLen === "auto" ? longest : recipe.seqLen);
    const steps = plan?.steps ?? 0;
    const evalEvery = recipe.evalEvery === "auto" ? null : recipe.evalEvery;
    const checks = evalEvery ? Math.floor(Math.max(steps - 1, 0) / evalEvery) + 1 : null;
    return (
        <div className="divide-y">
            <Group id="train-group-adapter" label="Adapter">
                <Field
                    id="train-rank"
                    label="Rank"
                    hint={`Capacity of the adapter: higher learns more and needs more memory. Serving loads up to ${MAX_RANK}.`}
                    error={errorFor(issues, "rank")}
                >
                    <NumberField
                        id="train-rank"
                        value={recipe.rank}
                        onValueChange={(value) => onChange({ rank: value ?? recipe.rank })}
                        min={1}
                        max={256}
                        step={1}
                        largeStep={8}
                        format={WHOLE}
                    />
                </Field>
                <Field
                    id="train-alpha"
                    label="Alpha"
                    hint={
                        recipe.alpha === "auto"
                            ? `Scales the adapter's updates; follows 2 × rank (${recipe.rank * 2}).`
                            : `Scales the adapter's updates; 2 × rank (${recipe.rank * 2}) is usual.`
                    }
                >
                    <NumberField
                        id="train-alpha"
                        value={alpha}
                        onValueChange={(value) =>
                            onChange({
                                alpha: value === null || value === recipe.rank * 2 ? "auto" : value,
                            })
                        }
                        min={1}
                        max={512}
                        step={1}
                        largeStep={8}
                        format={WHOLE}
                    />
                </Field>
            </Group>
            <Group id="train-group-optimisation" label="Optimisation">
                <Field
                    id="train-rate"
                    label="Learning rate"
                    hint={
                        recipe.learningRate >= 1e-3 ? (
                            <Warn>Often diverges with LoRA; 2e-4 is the usual start.</Warn>
                        ) : (
                            "Step size of each update. Lower is steadier and slower to learn."
                        )
                    }
                >
                    <ChoiceSelect<number>
                        id="train-rate"
                        value={recipe.learningRate}
                        choices={LEARNING_RATES.map((value) => ({ value, label: rate(value) }))}
                        onChange={(value) =>
                            onChange({ learningRate: value === "auto" ? 2e-4 : value })
                        }
                    />
                </Field>
                <Field
                    id="train-epochs"
                    label="Epochs"
                    hint={
                        recipe.epochs >= 5 ? (
                            <Warn>Past 4 passes the model starts to memorise its rows.</Warn>
                        ) : (
                            "Passes over the rows. More fits your data closer."
                        )
                    }
                >
                    <NumberField
                        id="train-epochs"
                        value={recipe.epochs}
                        onValueChange={(value) => onChange({ epochs: value ?? recipe.epochs })}
                        min={1}
                        max={10}
                        step={1}
                        format={WHOLE}
                    />
                </Field>
                <Field
                    id="train-rows"
                    label="Max rows"
                    hint={
                        rows >= available ? (
                            `Uses all ${count(available)} training rows.`
                        ) : rows < 200 ? (
                            <Warn>{`Only ${count(rows)} of ${count(available)} rows: fine for a smoke test, weak for a release.`}</Warn>
                        ) : (
                            `Uses ${count(rows)} of ${count(available)} rows.`
                        )
                    }
                >
                    <NumberField
                        id="train-rows"
                        value={rows}
                        onValueChange={(value) =>
                            onChange({
                                maxRows: value === null || value >= available ? "all" : value,
                            })
                        }
                        min={10}
                        max={Math.max(available, 10)}
                        step={100}
                        largeStep={1000}
                        format={WHOLE}
                        unit="rows"
                    />
                </Field>
                <div className="hidden sm:block" />
                <Field
                    id="train-micro"
                    label="Batch"
                    hint={`Rows per forward pass. Automatic picks ${chosen ? chosen.micro_batch : "the largest that fits"}${chosen ? ` on ${machine}` : ""}.`}
                >
                    <ChoiceSelect<number>
                        id="train-micro"
                        value={recipe.microBatch}
                        choices={[
                            {
                                value: "auto",
                                label: chosen ? `Automatic (${chosen.micro_batch})` : "Automatic",
                            },
                            ...MICRO_CHOICES.map((value) => ({ value, label: String(value) })),
                        ]}
                        onChange={(value) => onChange({ microBatch: value })}
                    />
                </Field>
                <Field
                    id="train-accum"
                    label="Gradient accumulation"
                    hint={
                        chosen && plan?.grad_accum
                            ? `Batches per update: ${chosen.micro_batch} × ${plan.grad_accum} = ${chosen.micro_batch * plan.grad_accum} rows per step, ${count(steps)} steps.`
                            : "Batches per update."
                    }
                >
                    <ChoiceSelect<number>
                        id="train-accum"
                        value={recipe.gradAccum}
                        choices={[
                            {
                                value: "auto",
                                label: chosen ? `Automatic (${chosen.grad_accum})` : "Automatic",
                            },
                            ...ACCUM_CHOICES.map((value) => ({ value, label: String(value) })),
                        ]}
                        onChange={(value) => onChange({ gradAccum: value })}
                    />
                </Field>
            </Group>
            <Group id="train-group-sequence" label="Sequence">
                <Field
                    id="train-seq"
                    label="Length"
                    hint={
                        recipe.seqLen !== "auto" && recipe.seqLen < longest ? (
                            <Warn>{`Longest example: about ${count(longest)} tokens; longer rows get cut.`}</Warn>
                        ) : (
                            `Longest example: about ${count(longest)} tokens. ${recipe.seqLen === "auto" ? "Automatic fits it." : "Longer rows get cut."}`
                        )
                    }
                    error={errorFor(issues, "seqLen")}
                >
                    <NumberField
                        id="train-seq"
                        value={seq}
                        onValueChange={(value) => onChange({ seqLen: value ?? "auto" })}
                        min={32}
                        max={131072}
                        step={16}
                        largeStep={256}
                        format={WHOLE}
                        unit="tokens"
                    />
                </Field>
                <p className="text-sm text-muted-foreground sm:pt-7">
                    {plan?.context
                        ? `The base reads up to ${count(plan.context)} tokens. Longer sequences need more activation memory.`
                        : "Longer sequences need more activation memory."}
                </p>
            </Group>
            <Group id="train-group-memory" label="Memory">
                <Field
                    id="train-strategy"
                    label="Method"
                    hint="QLoRA holds the base in 4 bits: about a third of the memory, a little slower."
                >
                    <ChoiceSelect<Strategy>
                        id="train-strategy"
                        value={recipe.strategy}
                        choices={[
                            {
                                value: "auto",
                                label: chosen
                                    ? `Automatic (${strategyName(chosen.strategy)})`
                                    : "Automatic",
                            },
                            { value: "lora", label: "LoRA" },
                            { value: "qlora", label: "QLoRA" },
                        ]}
                        onChange={(value) => onChange({ strategy: value })}
                    />
                </Field>
                <Field
                    id="train-checkpointing"
                    label="Gradient checkpointing"
                    hint="Recomputes activations instead of storing them: less memory, about 25% slower."
                >
                    <ChoiceSelect<boolean>
                        id="train-checkpointing"
                        value={recipe.checkpointing}
                        choices={[
                            {
                                value: "auto",
                                label: chosen
                                    ? `Automatic (${chosen.checkpointing ? "on" : "off"})`
                                    : "Automatic",
                            },
                            { value: true, label: "On" },
                            { value: false, label: "Off" },
                        ]}
                        onChange={(value) => onChange({ checkpointing: value })}
                    />
                </Field>
            </Group>
            <Group id="train-group-evaluation" label="Evaluation">
                <Field
                    id="train-eval"
                    label="Score held-out rows every"
                    hint={
                        checks === null
                            ? `Automatic scores ${count(heldOut)} held-out rows a few times during the run and at the end.`
                            : `${count(checks)} ${checks === 1 ? "check" : "checks"} on ${count(heldOut)} rows, the last at the end. Each costs a little time.`
                    }
                >
                    <NumberField
                        id="train-eval"
                        value={evalEvery}
                        onValueChange={(value) => onChange({ evalEvery: value ?? "auto" })}
                        min={10}
                        max={5000}
                        step={10}
                        largeStep={100}
                        format={WHOLE}
                        unit="steps"
                        placeholder="Automatic"
                    />
                </Field>
            </Group>
            <Group id="train-group-seed" label="Reproducibility">
                <Field
                    id="train-seed"
                    label="Seed"
                    hint={`Same seed, data and settings train the same weights for v${next}.`}
                >
                    <NumberField
                        id="train-seed"
                        value={recipe.seed}
                        onValueChange={(value) => onChange({ seed: value ?? recipe.seed })}
                        min={0}
                        max={2147483647}
                        step={1}
                        format={{ maximumFractionDigits: 0, useGrouping: false }}
                    />
                </Field>
            </Group>
        </div>
    );
}
