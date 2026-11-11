import { Badge, Button, Label, Link, RadioGroup, RadioGroupItem, cn } from "obp-ui";
import type { ReactNode } from "react";
import { count } from "~/lib/format";
import { closeTrain } from "./flowOverlays";
import {
    CLOSED_POOL,
    type ComputeChoice,
    type DataPick,
    HEADROOM,
    MIN_HELD_OUT,
    type Machine,
    type MachinePlan,
    type Option,
    POOLS,
    type Plan,
    QUALITIES,
    type Quality,
    candidates,
    computeHours,
    duration,
    gigabytes,
    memoryLabel,
} from "./flowTrainPlan";
import { FLOW, shortAgo } from "./modelsFlowData";

export function Row({
    id,
    label,
    children,
}: {
    id: string;
    label: ReactNode;
    children: ReactNode;
}) {
    return (
        <section
            aria-labelledby={id}
            className="grid gap-label py-4 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-x-6"
        >
            <h3 id={id} className="text-base font-medium sm:leading-8">
                {label}
            </h3>
            <div className="flex min-w-0 flex-col gap-2">{children}</div>
        </section>
    );
}

export function Headline({
    children,
    action,
}: {
    children: ReactNode;
    action?: ReactNode;
}) {
    return (
        <div className="flex min-h-8 items-center justify-between gap-3">
            <p className="min-w-0 tabular-nums">{children}</p>
            {action}
        </div>
    );
}

export function Meta({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <p className={cn("text-sm text-muted-foreground tabular-nums", className)}>{children}</p>
    );
}

export function ToggleButton({
    open,
    onToggle,
    controls,
    label,
}: {
    open: boolean;
    onToggle: () => void;
    controls: string;
    label: string;
}) {
    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={open}
            aria-controls={controls}
            aria-label={open ? `Done choosing ${label}` : `Change ${label}`}
            onClick={onToggle}
        >
            {open ? "Done" : "Change"}
        </Button>
    );
}

const CARD =
    "flex cursor-pointer flex-col items-stretch gap-0.5 rounded-md border px-3 py-2.5 font-normal hover:bg-secondary has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-1 has-focus-visible:ring-offset-background";

const QUIET_RADIO = "focus-visible:ring-0 focus-visible:ring-offset-0";

export function QualityPicker({
    value,
    minutes,
    onPick,
}: {
    value: Quality | null;
    minutes: Record<Quality, number | null>;
    onPick: (quality: Quality) => void;
}) {
    return (
        <RadioGroup
            aria-labelledby="train-quality"
            value={value ?? ""}
            onValueChange={(next) => onPick(next as Quality)}
            className="grid gap-2 sm:grid-cols-3"
        >
            {QUALITIES.map((item) => {
                const time = minutes[item.id];
                const text = time === null ? "Does not fit" : `≈ ${duration(time)}`;
                return (
                    <Label
                        key={item.id}
                        className={cn(
                            CARD,
                            value === item.id && "border-primary bg-accent hover:bg-accent",
                        )}
                    >
                        <span className="flex items-center gap-2">
                            <RadioGroupItem value={item.id} className={QUIET_RADIO} />
                            <span className="font-medium">{item.label}</span>
                            <span className="ml-auto text-sm tabular-nums sm:hidden">{text}</span>
                        </span>
                        <span className="hidden pl-6 text-sm tabular-nums sm:block">{text}</span>
                        <span className="pl-6 text-sm text-muted-foreground">{item.blurb}</span>
                    </Label>
                );
            })}
        </RadioGroup>
    );
}

const LIST = "flex flex-col divide-y rounded-md border";
const ITEM =
    "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 gap-y-0.5 rounded-none px-3 py-2 font-normal hover:bg-secondary has-focus-visible:bg-secondary has-data-checked:bg-accent sm:grid-cols-[auto_minmax(0,1fr)_auto]";
const ITEM_OFF = "cursor-not-allowed hover:bg-transparent";

function signed(value: number): string {
    return `${value >= 0 ? "+" : "−"}${count(Math.abs(value))}`;
}

type DataRef = { number: number; rows: number };

export function versusLive(rows: number, number: number, live: DataRef | null): string | null {
    if (!live) {
        return null;
    }
    if (live.number === number) {
        return "live's data";
    }
    return `${signed(rows - live.rows)} rows vs live's v${live.number}`;
}

export function DataPicker({
    picks,
    picked,
    live,
    dataset,
    onPick,
}: {
    picks: DataPick[];
    picked: number;
    live: DataRef | null;
    dataset: { slug: string; name: string };
    onPick: (number: number) => void;
}) {
    return (
        <div id="train-data-picker" className="flex flex-col gap-2">
            <RadioGroup
                aria-label="Data version"
                value={String(picked)}
                onValueChange={(next) => onPick(Number(next))}
                className={LIST}
            >
                {picks.map((pick, index) => {
                    const diff = versusLive(pick.rows, pick.number, live);
                    return (
                        <Label key={pick.number} className={ITEM}>
                            <RadioGroupItem
                                value={String(pick.number)}
                                className={cn(QUIET_RADIO, "mt-0.5")}
                            />
                            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                                <span className="font-medium tabular-nums">{`v${pick.number}`}</span>
                                <span className="tabular-nums">{`${count(pick.rows)} rows`}</span>
                                <span className="text-sm text-muted-foreground">
                                    {shortAgo({ hoursAgo: pick.hoursAgo })}
                                </span>
                            </span>
                            <span className="col-start-2 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground tabular-nums sm:col-start-3 sm:row-start-1 sm:justify-end">
                                {index === 0 && <Badge variant="info">Latest</Badge>}
                                {pick.usedBy.length > 0 && (
                                    <span>{`trained ${pick.usedBy.join(", ")}`}</span>
                                )}
                            </span>
                            {diff && (
                                <span className="col-start-2 text-sm text-muted-foreground tabular-nums">
                                    {diff}
                                </span>
                            )}
                        </Label>
                    );
                })}
            </RadioGroup>
            <Meta>
                {`Versions of ${dataset.name}. `}
                <Link
                    href={`${FLOW}/data/${dataset.slug}`}
                    onClick={() => closeTrain()}
                    className="text-primary hover:underline"
                >
                    Open the dataset
                </Link>
            </Meta>
        </div>
    );
}

export function HeldOutWarning({
    heldOut,
    suggested,
    next,
    onFix,
}: {
    heldOut: number;
    suggested: number;
    next: number;
    onFix: () => void;
}) {
    return (
        <div
            role="alert"
            className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5"
        >
            <p className="tabular-nums">
                <span className="font-medium text-warning">{`Only ${count(heldOut)} held-out rows. `}</span>
                {`One row moves the score by ${Math.round(100 / Math.max(heldOut, 1))} points, so versions can't be told apart. Hold out at least ${MIN_HELD_OUT}.`}
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Button type="button" variant="outline" size="sm" onClick={onFix}>
                    {`Hold out ${count(suggested)} rows`}
                </Button>
                <span className="text-sm text-muted-foreground">
                    {`10% of this version, kept out of training. v${next} and later are scored on them.`}
                </span>
            </div>
        </div>
    );
}

const SEGMENTS = [
    {
        key: "weights",
        label: "Weights",
        fill: "bg-(--flow-memory-1)",
        danger: "bg-(--flow-memory-over-1)",
    },
    {
        key: "adapter",
        label: "Adapter",
        fill: "bg-(--flow-memory-2)",
        danger: "bg-(--flow-memory-over-2)",
    },
    {
        key: "activations",
        label: "Activations",
        fill: "bg-(--flow-memory-3)",
        danger: "bg-(--flow-memory-over-3)",
    },
] as const;

export function MemoryTrack({
    option,
    machine,
    className,
}: {
    option: Option;
    machine: Machine;
    className?: string;
}) {
    const ok = fitsIn(option);
    const scale = Math.max(option.available, option.peak);
    const width = (bytes: number) => `${(bytes / scale) * 100}%`;
    const summary = `${gigabytes(option.peak)} of ${machine.memoryGb} GB ${memoryLabel(machine)}: weights ${gigabytes(option.weights)}, adapter ${gigabytes(option.adapter)}, activations ${gigabytes(option.activations)}`;
    return (
        <div
            role="img"
            aria-label={summary}
            className={cn(
                "relative flex h-2 w-full overflow-hidden rounded-sm bg-secondary",
                className,
            )}
        >
            {SEGMENTS.map((segment) => (
                <span
                    key={segment.key}
                    className={cn(
                        "h-full min-w-0.5 border-r border-card last:border-r-0",
                        ok ? segment.fill : segment.danger,
                    )}
                    style={{ width: width(option[segment.key]) }}
                />
            ))}
            <span
                aria-hidden
                className="absolute inset-y-0 w-px bg-foreground"
                style={{ left: width(option.available * HEADROOM) }}
            />
        </div>
    );
}

function fitsIn(option: Option): boolean {
    return option.supported && option.peak <= option.usable;
}

export function MemoryBar({ option, machine }: { option: Option; machine: Machine }) {
    const ok = fitsIn(option);
    return (
        <div className="flex flex-col gap-1.5">
            <MemoryTrack option={option} machine={machine} />
            <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-muted-foreground tabular-nums">
                {SEGMENTS.map((segment) => (
                    <span key={segment.key} className="inline-flex items-center gap-1.5">
                        <span
                            aria-hidden
                            className={cn("size-2 rounded-xs", ok ? segment.fill : segment.danger)}
                        />
                        {`${segment.label} ${gigabytes(option[segment.key])}`}
                    </span>
                ))}
                <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden className="h-2.5 w-px bg-foreground" />
                    {`${Math.round(HEADROOM * 100)}% usable`}
                </span>
            </p>
        </div>
    );
}

export function fitText(item: MachinePlan): string {
    if (!item.chosen) {
        return item.reason ?? "does not fit";
    }
    return `fits ${gigabytes(item.chosen.peak).replace(" GB", "")} of ${item.machine.memoryGb} GB`;
}

export function waitText(item: MachinePlan): string | null {
    if (item.wait <= 0 || !item.after) {
        return null;
    }
    return `starts after ${item.after}, in ≈ ${duration(item.wait)}`;
}

function bestOf(plan: Plan, choice: ComputeChoice): MachinePlan | null {
    const allowed = candidates(choice);
    return plan.machines
        .filter((item) => item.chosen && allowed.includes(item.machine))
        .reduce<MachinePlan | null>(
            (best, item) =>
                best === null || item.wait + item.minutes < best.wait + best.minutes ? item : best,
            null,
        );
}

function ChoiceItem({
    value,
    title,
    meta,
    side,
    disabled,
    indent,
}: {
    value: ComputeChoice;
    title: ReactNode;
    meta?: ReactNode;
    side: ReactNode;
    disabled?: boolean;
    indent?: boolean;
}) {
    return (
        <Label className={cn(ITEM, disabled && ITEM_OFF, indent && "sm:pl-8")}>
            <RadioGroupItem
                value={value}
                disabled={disabled}
                className={cn(QUIET_RADIO, "mt-0.5")}
            />
            <span className="flex min-w-0 flex-col">
                <span className={cn(disabled ? "text-muted-foreground" : "text-foreground")}>
                    {title}
                </span>
                {meta && <span className="text-sm text-muted-foreground">{meta}</span>}
            </span>
            <span className="col-start-2 text-sm tabular-nums sm:col-start-3 sm:row-start-1 sm:text-right">
                {side}
            </span>
        </Label>
    );
}

function sideFor(item: MachinePlan | null, fallback: string): ReactNode {
    if (!item?.chosen) {
        return <span className="text-destructive">{item?.reason ?? fallback}</span>;
    }
    const wait = waitText(item);
    return (
        <span className="flex flex-col text-muted-foreground">
            <span>{`${fitText(item)} · ≈ ${duration(item.minutes)}`}</span>
            {wait && <span>{wait}</span>}
        </span>
    );
}

export function ComputePicker({
    plan,
    choice,
    onChoice,
}: {
    plan: Plan;
    choice: ComputeChoice;
    onChoice: (choice: ComputeChoice) => void;
}) {
    const auto = bestOf(plan, "auto");
    return (
        <div id="train-compute-picker" className="flex flex-col gap-2">
            <RadioGroup
                aria-label="Where to train"
                value={choice}
                onValueChange={(next) => onChoice(next as ComputeChoice)}
                className={LIST}
            >
                <ChoiceItem
                    value="auto"
                    title="Automatic"
                    meta="The machine that finishes first, queue included."
                    side={
                        auto ? (
                            <span className="text-muted-foreground">{auto.machine.name}</span>
                        ) : (
                            <span className="text-destructive">Nothing fits</span>
                        )
                    }
                />
                {POOLS.map((pool) => {
                    const machines = plan.machines.filter((item) => item.machine.pool === pool);
                    const best = bestOf(plan, `pool:${pool}`);
                    return [
                        <ChoiceItem
                            key={`pool:${pool}`}
                            value={`pool:${pool}`}
                            title={`${pool} pool`}
                            meta={
                                machines.length === 1
                                    ? "Its only machine"
                                    : `Whichever of its ${machines.length} machines finishes first`
                            }
                            side={
                                best ? (
                                    <span className="text-muted-foreground">
                                        {best.machine.name}
                                    </span>
                                ) : (
                                    <span className="text-destructive">Nothing fits</span>
                                )
                            }
                            disabled={!best}
                        />,
                        ...machines.map((item) => (
                            <ChoiceItem
                                key={item.machine.name}
                                value={`machine:${item.machine.name}`}
                                title={item.machine.name}
                                meta={[
                                    item.machine.accelerator,
                                    `${item.machine.memoryGb} GB ${memoryLabel(item.machine)}`,
                                    item.machine.note,
                                ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                side={sideFor(item, "does not fit")}
                                disabled={!item.chosen}
                                indent
                            />
                        )),
                    ];
                })}
            </RadioGroup>
            <Meta>{`The ${CLOSED_POOL.name} pool (${CLOSED_POOL.machines.join(", ")}) only serves; it takes no jobs.`}</Meta>
        </div>
    );
}

export function computeTitle(choice: ComputeChoice, pick: MachinePlan | null): string {
    const where =
        choice === "auto"
            ? "Automatic"
            : choice.startsWith("pool:")
              ? `${choice.slice(5)} pool`
              : null;
    if (!pick?.chosen) {
        return where ? `${where} · nothing fits` : `${choice.slice(8)} · does not fit`;
    }
    return [where, pick.machine.name, pick.chosen.strategy].filter(Boolean).join(" · ");
}

export function planDetail(pick: MachinePlan): string {
    const option = pick.chosen;
    if (!option) {
        return "";
    }
    return [
        option.checkpointing ? "Gradient checkpointing" : "No checkpointing",
        `batch ${pick.micro} × ${pick.accum}`,
    ].join(", ");
}

export function TimeLine({ pick }: { pick: MachinePlan }) {
    const wait = waitText(pick);
    return (
        <p className="flex flex-wrap items-center gap-x-2 tabular-nums">
            <span>{`≈ ${duration(pick.minutes)}`}</span>
            <span className="text-muted-foreground">·</span>
            <span>{computeHours(pick)}</span>
            {wait && (
                <>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{wait}</span>
                </>
            )}
        </p>
    );
}
