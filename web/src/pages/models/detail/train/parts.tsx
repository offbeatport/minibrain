import { Badge, Button, Label, RadioGroup, RadioGroupItem, cn } from "obp-ui";
import type { ReactNode } from "react";
import type { DatasetVersionInfo } from "~/api/dataQueries";
import { count } from "~/lib/format";
import { relativeTime } from "~/lib/time";
import {
    HEADROOM,
    type MachinePlan,
    type OptionInfo,
    QUALITIES,
    type Quality,
    deviceHours,
    duration,
    gigabytes,
} from "./recipe";

export function Row({
    id,
    label,
    children,
}: { id: string; label: ReactNode; children: ReactNode }) {
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

export function Headline({ children, action }: { children: ReactNode; action?: ReactNode }) {
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
    minutes: Record<Quality, number | null | undefined>;
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
                const text =
                    time === undefined
                        ? "Estimating…"
                        : time === null
                          ? "Does not fit"
                          : `≈ ${duration(time)}`;
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

export type DataRef = { id: number; number: number | null | undefined; rows: number };

export function versusLive(pick: DataRef, live: DataRef | null): string | null {
    if (!live) {
        return null;
    }
    if (live.id === pick.id) {
        return "live's data";
    }
    return `${signed(pick.rows - live.rows)} rows vs live's v${live.number ?? "–"}`;
}

export function DataPicker({
    versions,
    picked,
    live,
    onPick,
    footer,
}: {
    versions: DatasetVersionInfo[];
    picked: number;
    live: DataRef | null;
    onPick: (id: number) => void;
    footer: ReactNode;
}) {
    return (
        <div id="train-data-picker" className="flex flex-col gap-2">
            <RadioGroup
                aria-label="Data version"
                value={String(picked)}
                onValueChange={(next) => onPick(Number(next))}
                className={LIST}
            >
                {versions.map((item, index) => {
                    const diff = versusLive(
                        { id: item.id, number: item.number, rows: item.rows },
                        live,
                    );
                    return (
                        <Label key={item.id} className={ITEM}>
                            <RadioGroupItem
                                value={String(item.id)}
                                className={cn(QUIET_RADIO, "mt-0.5")}
                            />
                            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                                <span className="font-medium tabular-nums">{`v${item.number ?? "–"}`}</span>
                                <span className="tabular-nums">{`${count(item.rows)} rows`}</span>
                                <span className="text-sm text-muted-foreground">
                                    {relativeTime(item.taken_at ?? item.created_at)}
                                </span>
                            </span>
                            <span className="col-start-2 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground tabular-nums sm:col-start-3 sm:row-start-1 sm:justify-end">
                                {index === 0 && <Badge variant="info">Latest</Badge>}
                                {item.versions.length > 0 && (
                                    <span>{`trained ${item.versions.join(", ")}`}</span>
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
            <Meta>{footer}</Meta>
        </div>
    );
}

const SEGMENTS = [
    {
        key: "weights",
        label: "Weights",
        fill: "bg-(--chart-memory-1)",
        danger: "bg-(--chart-memory-over-1)",
    },
    {
        key: "adapter",
        label: "Adapter",
        fill: "bg-(--chart-memory-2)",
        danger: "bg-(--chart-memory-over-2)",
    },
    {
        key: "activations",
        label: "Activations",
        fill: "bg-(--chart-memory-3)",
        danger: "bg-(--chart-memory-over-3)",
    },
] as const;

type Segment = (typeof SEGMENTS)[number]["key"];

function partsOf(option: OptionInfo): Record<Segment, number> {
    const parts = option.parts;
    return {
        weights: parts.weights ?? 0,
        adapter: parts.adapter ?? 0,
        activations: (parts.activations ?? 0) + (parts.logits ?? 0) + (parts.overhead ?? 0),
    };
}

function fits(option: OptionInfo): boolean {
    return option.fits;
}

export function MemoryTrack({
    option,
    memoryLabel,
    className,
}: {
    option: OptionInfo;
    memoryLabel: string;
    className?: string;
}) {
    const ok = fits(option);
    const available = option.available_bytes ?? option.peak_bytes;
    const scale = Math.max(available, option.peak_bytes);
    const width = (bytes: number) => `${(bytes / scale) * 100}%`;
    const parts = partsOf(option);
    const summary = `${gigabytes(option.peak_bytes)} of ${gigabytes(available)} ${memoryLabel}: weights ${gigabytes(parts.weights)}, adapter ${gigabytes(parts.adapter)}, activations ${gigabytes(parts.activations)}`;
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
                    style={{ width: width(parts[segment.key]) }}
                />
            ))}
            {option.available_bytes !== null && option.available_bytes !== undefined && (
                <span
                    aria-hidden
                    className="absolute inset-y-0 w-px bg-foreground"
                    style={{ left: width(option.available_bytes * HEADROOM) }}
                />
            )}
        </div>
    );
}

export function MemoryBar({ option, memoryLabel }: { option: OptionInfo; memoryLabel: string }) {
    const ok = fits(option);
    const parts = partsOf(option);
    return (
        <div className="flex flex-col gap-1.5">
            <MemoryTrack option={option} memoryLabel={memoryLabel} />
            <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-muted-foreground tabular-nums">
                {SEGMENTS.map((segment) => (
                    <span key={segment.key} className="inline-flex items-center gap-1.5">
                        <span
                            aria-hidden
                            className={cn("size-2 rounded-xs", ok ? segment.fill : segment.danger)}
                        />
                        {`${segment.label} ${gigabytes(parts[segment.key])}`}
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

export function fitText(option: OptionInfo | null | undefined): string {
    if (!option) {
        return "does not fit";
    }
    return `fits ${gigabytes(option.peak_bytes).replace(" GB", "")} of ${gigabytes(option.available_bytes)}`;
}

function ChoiceItem({
    value,
    title,
    meta,
    side,
    disabled,
    indent,
}: {
    value: string;
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
            <span className="col-start-2 text-sm tabular-nums sm:col-start-3 sm:row-start-1 sm:max-w-64 sm:text-right">
                {side}
            </span>
        </Label>
    );
}

export const AUTO = "auto";

function sideFor(item: MachinePlan): ReactNode {
    if (!item.chosen) {
        return <span className="text-destructive">{item.reason ?? "Does not fit"}</span>;
    }
    return (
        <span className="text-muted-foreground">{`${fitText(item.chosen)} · ≈ ${duration(item.minutes)}`}</span>
    );
}

export function ComputePicker({
    machines,
    choice,
    onChoice,
}: {
    machines: MachinePlan[];
    choice: string;
    onChoice: (choice: string) => void;
}) {
    const pools = [...new Set(machines.map((item) => item.pool))];
    const fastest = machines
        .filter((item) => item.chosen)
        .reduce<MachinePlan | null>(
            (best, item) =>
                best === null || (item.minutes ?? 0) < (best.minutes ?? 0) ? item : best,
            null,
        );
    return (
        <div id="train-compute-picker" className="flex flex-col gap-2">
            <RadioGroup
                aria-label="Plan for"
                value={choice}
                onValueChange={(next) => onChoice(String(next))}
                className={LIST}
            >
                <ChoiceItem
                    value={AUTO}
                    title="Automatic"
                    meta="The memory planner's choice: the fastest plan that fits."
                    side={
                        fastest ? (
                            <span className="text-muted-foreground">{fastest.name}</span>
                        ) : (
                            <span className="text-destructive">Nothing fits</span>
                        )
                    }
                />
                {pools.flatMap((pool) => [
                    <div
                        key={`pool-${pool}`}
                        className="px-3 py-1.5 text-sm text-muted-foreground"
                    >{`${pool} pool`}</div>,
                    ...machines
                        .filter((item) => item.pool === pool)
                        .map((item) => (
                            <ChoiceItem
                                key={item.name}
                                value={item.name}
                                title={item.name}
                                meta={`${gigabytes(item.available_bytes)} ${item.memory_label}`}
                                side={sideFor(item)}
                                disabled={!item.chosen}
                                indent
                            />
                        )),
                ])}
            </RadioGroup>
            <Meta>
                Any training worker can take the job; the plan is sized for the machine you pick.
            </Meta>
        </div>
    );
}

export function TimeLine({
    minutes,
    kind,
    ahead,
}: {
    minutes: number;
    kind: string | null | undefined;
    ahead: number;
}) {
    return (
        <p className="flex flex-wrap items-center gap-x-2 tabular-nums">
            <span>{`≈ ${duration(minutes)}`}</span>
            <span className="text-muted-foreground">·</span>
            <span>{deviceHours(minutes, kind)}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">
                {ahead === 0
                    ? "starts now"
                    : `${ahead} training ${ahead === 1 ? "job" : "jobs"} ahead in the queue`}
            </span>
        </p>
    );
}

export function HeldOutWarning({ heldOut }: { heldOut: number }) {
    return (
        <div
            role="alert"
            className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5"
        >
            <p className="tabular-nums">
                <span className="font-medium text-warning">{`Only ${count(heldOut)} held-out rows. `}</span>
                {`One row moves the score by ${Math.round(100 / Math.max(heldOut, 1))} points, so versions are hard to tell apart. Add rows to the dataset so its held-out split grows.`}
            </p>
        </div>
    );
}
