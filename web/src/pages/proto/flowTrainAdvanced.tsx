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
import { Row } from "./flowTrainParts";
import {
    ACCUM_CHOICES,
    type Base,
    type Issue,
    LEARNING_RATES,
    MAX_RANK,
    MICRO_CHOICES,
    type MachinePlan,
    type Plan,
    type Recipe,
    type Strategy,
    rowsCut,
} from "./flowTrainPlan";
import { rate } from "./modelsFlowData";

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
    value: T | "auto";
    choices: { value: T | "auto"; label: string }[];
    onChange: (value: T | "auto") => void;
}) {
    const key = (item: T | "auto") => String(item);
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

export function Advanced({
    recipe,
    onChange,
    plan,
    pick,
    base,
    available,
    longest,
    heldOut,
    issues,
    next,
}: {
    recipe: Recipe;
    onChange: Change;
    plan: Plan;
    pick: MachinePlan | null;
    base: Base;
    available: number;
    longest: number;
    heldOut: number;
    issues: Issue[];
    next: number;
}) {
    const machine = pick?.machine.name ?? "the machine";
    const option = pick?.chosen;
    const linkedAlpha = recipe.alpha === recipe.rank * 2;
    const setRank = (rank: number) => onChange(linkedAlpha ? { rank, alpha: rank * 2 } : { rank });
    const rankError = errorFor(issues, "rank");
    const seqError = errorFor(issues, "seqLen");
    const rows = recipe.maxRows === "all" ? available : recipe.maxRows;
    const cut = rowsCut(longest, plan.seq, available);
    const general = plan.mixed - plan.rows;
    const steps = pick?.steps ?? 0;
    return (
        <div className="divide-y">
            <Group id="train-group-adapter" label="Adapter">
                <Field
                    id="train-rank"
                    label="Rank"
                    hint={`Capacity of the adapter: higher learns more and needs more memory. Serving loads up to ${MAX_RANK}.`}
                    error={rankError}
                >
                    <NumberField
                        id="train-rank"
                        value={recipe.rank}
                        onValueChange={(value) => setRank(value ?? recipe.rank)}
                        min={1}
                        max={256}
                        step={1}
                        largeStep={8}
                        format={WHOLE}
                        aria-invalid={Boolean(rankError)}
                    />
                </Field>
                <Field
                    id="train-alpha"
                    label="Alpha"
                    hint={
                        linkedAlpha
                            ? `Scales the adapter's updates; follows 2 × rank (${recipe.rank * 2}).`
                            : `Scales the adapter's updates; 2 × rank (${recipe.rank * 2}) is usual.`
                    }
                >
                    <NumberField
                        id="train-alpha"
                        value={recipe.alpha}
                        onValueChange={(value) => onChange({ alpha: value ?? recipe.alpha })}
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
                    <ChoiceSelect
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
                            `Samples ${count(rows)} of ${count(available)} rows with the seed.`
                        )
                    }
                >
                    <NumberField
                        id="train-rows"
                        value={rows}
                        onValueChange={(value) => onChange({ maxRows: value ?? rows })}
                        min={10}
                        max={100000}
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
                    hint={`Rows per forward pass. Automatic picks ${pick ? pick.micro : "the largest that fits"}${pick ? ` on ${machine}` : ""}.`}
                >
                    <ChoiceSelect<number>
                        id="train-micro"
                        value={recipe.microBatch}
                        choices={[
                            {
                                value: "auto",
                                label: pick ? `Automatic (${pick.micro})` : "Automatic",
                            },
                            ...MICRO_CHOICES.map((value) => ({ value, label: String(value) })),
                        ]}
                        onChange={(value) => onChange({ microBatch: value })}
                    />
                </Field>
                <Field
                    id="train-accum"
                    label="Gradient accumulation"
                    hint={`Batches per update: ${pick ? `${pick.micro} × ${pick.accum} = ${pick.micro * pick.accum}` : "–"} rows per step, ${count(steps)} steps.`}
                >
                    <ChoiceSelect<number>
                        id="train-accum"
                        value={recipe.gradAccum}
                        choices={[
                            {
                                value: "auto",
                                label: pick ? `Automatic (${pick.accum})` : "Automatic",
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
                        cut > 0 ? (
                            <Warn>{`Longest example: ${count(longest)} tokens. About ${count(cut)} rows are longer and get cut.`}</Warn>
                        ) : (
                            `Longest example: ${count(longest)} tokens. ${recipe.seqLen === "auto" ? "Automatic fits it." : "Longer rows get cut."}`
                        )
                    }
                    error={seqError}
                >
                    <NumberField
                        id="train-seq"
                        value={plan.seq}
                        onValueChange={(value) => onChange({ seqLen: value ?? plan.seq })}
                        min={32}
                        max={131072}
                        step={16}
                        largeStep={256}
                        format={WHOLE}
                        unit="tokens"
                        aria-invalid={Boolean(seqError)}
                    />
                </Field>
                <p className="text-sm text-muted-foreground sm:pt-7">
                    {`${base.name} reads up to ${count(base.context)} tokens. Longer sequences need more activation memory.`}
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
                                label: option ? `Automatic (${option.strategy})` : "Automatic",
                            },
                            { value: "LoRA", label: "LoRA" },
                            { value: "QLoRA", label: "QLoRA" },
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
                                label: option
                                    ? `Automatic (${option.checkpointing ? "on" : "off"})`
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
                    hint={`${count(pick?.checks ?? 1)} ${pick?.checks === 1 ? "check" : "checks"} on ${count(heldOut)} rows, the last at the end. Each costs a little time.`}
                >
                    <NumberField
                        id="train-eval"
                        value={recipe.evalEvery}
                        onValueChange={(value) =>
                            onChange({ evalEvery: value ?? recipe.evalEvery })
                        }
                        min={10}
                        max={5000}
                        step={10}
                        largeStep={100}
                        format={WHOLE}
                        unit="steps"
                    />
                </Field>
            </Group>
            <Group id="train-group-mix" label="Data mix">
                <Field
                    id="train-mix"
                    label="General instruction share"
                    hint={
                        recipe.mix === 0 ? (
                            <Warn>{`No general rows: v${next} may lose skills outside this task.`}</Warn>
                        ) : (
                            `Adds ${count(general)} general rows so v${next} keeps its general skills.`
                        )
                    }
                >
                    <NumberField
                        id="train-mix"
                        value={recipe.mix}
                        onValueChange={(value) => onChange({ mix: value ?? recipe.mix })}
                        min={0}
                        max={50}
                        step={1}
                        largeStep={5}
                        format={WHOLE}
                        unit="%"
                    />
                </Field>
            </Group>
            <Group id="train-group-seed" label="Reproducibility">
                <Field
                    id="train-seed"
                    label="Seed"
                    hint="Same seed, data and settings train the same weights."
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
