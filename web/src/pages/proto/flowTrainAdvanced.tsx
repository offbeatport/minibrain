import {
    Field,
    InfoTip,
    NumberField,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import type { ReactNode } from "react";
import { count } from "~/lib/format";
import {
    ACCUM_CHOICES,
    LEARNING_RATES,
    MAX_RANK,
    MICRO_CHOICES,
    type Recipe,
    type Strategy,
    rowsCut,
} from "./flowTrainPlan";
import type { Trainer } from "./flowTrainState";
import { rate } from "./modelsFlowData";

const WHOLE = { maximumFractionDigits: 0 };

function Warn({ children }: { children: ReactNode }) {
    return <span className="text-warning">{children}</span>;
}

function errorFor(t: Trainer, field: keyof Recipe): string | undefined {
    return t.issues.find((issue) => issue.field === field)?.text;
}

function Tipped({ label, tip }: { label: string; tip: string }) {
    return (
        <span className="inline-flex items-center gap-1.5">
            {label}
            <InfoTip label={label}>{tip}</InfoTip>
        </span>
    );
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

const GRID = "grid gap-x-field gap-y-5 @md:grid-cols-2 @xl:grid-cols-3";

export function CoreFields({ t }: { t: Trainer }) {
    const { recipe, tune: change } = t;
    const linkedAlpha = recipe.alpha === recipe.rank * 2;
    const setRank = (rank: number) => change(linkedAlpha ? { rank, alpha: rank * 2 } : { rank });
    const rankError = errorFor(t, "rank") ? `max ${MAX_RANK}` : undefined;
    return (
        <>
            <Field
                id="train-rank"
                label="Rank"
                hint={rankError ? undefined : `max ${MAX_RANK}`}
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
                hint={linkedAlpha ? "2 × rank" : `usual ${recipe.rank * 2}`}
            >
                <NumberField
                    id="train-alpha"
                    value={recipe.alpha}
                    onValueChange={(value) => change({ alpha: value ?? recipe.alpha })}
                    min={1}
                    max={512}
                    step={1}
                    largeStep={8}
                    format={WHOLE}
                />
            </Field>
            <Field
                id="train-rate"
                label="Learning rate"
                hint={recipe.learningRate >= 1e-3 ? <Warn>may diverge</Warn> : undefined}
            >
                <ChoiceSelect
                    id="train-rate"
                    value={recipe.learningRate}
                    choices={LEARNING_RATES.map((value) => ({ value, label: rate(value) }))}
                    onChange={(value) => change({ learningRate: value === "auto" ? 2e-4 : value })}
                />
            </Field>
            <Field
                id="train-epochs"
                label="Epochs"
                hint={recipe.epochs >= 5 ? <Warn>may memorise</Warn> : undefined}
            >
                <NumberField
                    id="train-epochs"
                    value={recipe.epochs}
                    onValueChange={(value) => change({ epochs: value ?? recipe.epochs })}
                    min={1}
                    max={10}
                    step={1}
                    format={WHOLE}
                />
            </Field>
        </>
    );
}

export function OtherFields({ t }: { t: Trainer }) {
    const { recipe, change, plan, heldOut } = t;
    const pick = plan.pick;
    const general = plan.mixed - plan.rows;
    return (
        <>
            <Field
                id="train-mix"
                label={
                    <Tipped
                        label="General mix"
                        tip="General instruction rows that keep general skills"
                    />
                }
                hint={
                    recipe.mix === 0 ? (
                        <Warn>may lose general skills</Warn>
                    ) : (
                        `+${count(general)} rows`
                    )
                }
            >
                <NumberField
                    id="train-mix"
                    value={recipe.mix}
                    onValueChange={(value) => change({ mix: value ?? recipe.mix })}
                    min={0}
                    max={50}
                    step={1}
                    largeStep={5}
                    format={WHOLE}
                    unit="%"
                />
            </Field>
            <Field
                id="train-eval"
                label="Eval every"
                hint={`${count(pick?.checks ?? 1)} × ${count(heldOut)} held-out rows`}
            >
                <NumberField
                    id="train-eval"
                    value={recipe.evalEvery}
                    onValueChange={(value) => change({ evalEvery: value ?? recipe.evalEvery })}
                    min={10}
                    max={5000}
                    step={10}
                    largeStep={100}
                    format={WHOLE}
                    unit="steps"
                />
            </Field>
            <Field id="train-seed" label="Seed">
                <NumberField
                    id="train-seed"
                    value={recipe.seed}
                    onValueChange={(value) => change({ seed: value ?? recipe.seed })}
                    min={0}
                    max={2147483647}
                    step={1}
                    format={{ maximumFractionDigits: 0, useGrouping: false }}
                />
            </Field>
        </>
    );
}

export function DataFields({ t }: { t: Trainer }) {
    const { recipe, change, plan, available, longest } = t;
    const seqError = errorFor(t, "seqLen");
    const rows = recipe.maxRows === "all" ? available : recipe.maxRows;
    const cut = rowsCut(longest, plan.seq, available);
    const seqHint =
        cut > 0 ? (
            <Warn>{`~${count(cut)} rows cut · longest ${count(longest)}`}</Warn>
        ) : (
            `longest ${count(longest)}`
        );
    return (
        <>
            <Field
                id="train-rows"
                label="Max rows"
                hint={
                    rows < 200 && rows < available ? (
                        <Warn>{`of ${count(available)} · smoke test`}</Warn>
                    ) : (
                        `of ${count(available)}`
                    )
                }
            >
                <NumberField
                    id="train-rows"
                    value={rows}
                    onValueChange={(value) => change({ maxRows: value ?? rows })}
                    min={10}
                    max={100000}
                    step={100}
                    largeStep={1000}
                    format={WHOLE}
                    unit="rows"
                />
            </Field>
            <Field
                id="train-seq"
                label="Sequence length"
                hint={seqError ? undefined : seqHint}
                error={seqError}
            >
                <NumberField
                    id="train-seq"
                    value={plan.seq}
                    onValueChange={(value) => change({ seqLen: value ?? plan.seq })}
                    min={32}
                    max={131072}
                    step={16}
                    largeStep={256}
                    format={WHOLE}
                    unit="tokens"
                    aria-invalid={Boolean(seqError)}
                />
            </Field>
        </>
    );
}

export function ComputeFields({ t }: { t: Trainer }) {
    const { recipe, change, plan } = t;
    const pick = plan.pick;
    const option = pick?.chosen;
    return (
        <>
            <Field id="train-micro" label="Batch">
                <ChoiceSelect<number>
                    id="train-micro"
                    value={recipe.microBatch}
                    choices={[
                        { value: "auto", label: pick ? `Auto (${pick.micro})` : "Auto" },
                        ...MICRO_CHOICES.map((value) => ({ value, label: String(value) })),
                    ]}
                    onChange={(value) => change({ microBatch: value })}
                />
            </Field>
            <Field
                id="train-accum"
                label="Gradient accumulation"
                hint={
                    pick
                        ? `${pick.micro * pick.accum} rows/step · ${count(pick.steps)} steps`
                        : undefined
                }
            >
                <ChoiceSelect<number>
                    id="train-accum"
                    value={recipe.gradAccum}
                    choices={[
                        { value: "auto", label: pick ? `Auto (${pick.accum})` : "Auto" },
                        ...ACCUM_CHOICES.map((value) => ({ value, label: String(value) })),
                    ]}
                    onChange={(value) => change({ gradAccum: value })}
                />
            </Field>
            <Field
                id="train-strategy"
                label={<Tipped label="Method" tip="QLoRA: 4-bit base, ~⅓ the memory, slower" />}
            >
                <ChoiceSelect<Strategy>
                    id="train-strategy"
                    value={recipe.strategy}
                    choices={[
                        { value: "auto", label: option ? `Auto (${option.strategy})` : "Auto" },
                        { value: "LoRA", label: "LoRA" },
                        { value: "QLoRA", label: "QLoRA" },
                    ]}
                    onChange={(value) => change({ strategy: value })}
                />
            </Field>
            <Field
                id="train-checkpointing"
                label={<Tipped label="Checkpointing" tip="Less memory, ~25% slower" />}
            >
                <ChoiceSelect<boolean>
                    id="train-checkpointing"
                    value={recipe.checkpointing}
                    choices={[
                        {
                            value: "auto",
                            label: option
                                ? `Auto (${option.checkpointing ? "on" : "off"})`
                                : "Auto",
                        },
                        { value: true, label: "On" },
                        { value: false, label: "Off" },
                    ]}
                    onChange={(value) => change({ checkpointing: value })}
                />
            </Field>
        </>
    );
}

export function FieldGrid({ children }: { children: ReactNode }) {
    return (
        <div className="@container">
            <div className={GRID}>{children}</div>
        </div>
    );
}

export function QualityFields({ t }: { t: Trainer }) {
    return (
        <>
            <CoreFields t={t} />
            <OtherFields t={t} />
        </>
    );
}

export function Advanced({ t }: { t: Trainer }) {
    return (
        <FieldGrid>
            <QualityFields t={t} />
            <DataFields t={t} />
            <ComputeFields t={t} />
        </FieldGrid>
    );
}
