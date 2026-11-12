import { TriangleAlert } from "lucide-react";
import {
    Badge,
    Button,
    DialogClose,
    InfoTip,
    Kbd,
    Label,
    Link,
    RadioGroup,
    RadioGroupItem,
    cn,
} from "obp-ui";
import type { ReactNode } from "react";
import { count } from "~/lib/format";
import { closeTrain } from "./flowOverlays";
import {
    type ComputeChoice,
    HEADROOM,
    type Issue,
    type Machine,
    type MachinePlan,
    type Option,
    POOLS,
    type Plan,
    QUALITIES,
    type Quality,
    approx,
    candidates,
    gigabytes,
    memoryLabel,
} from "./flowTrainPlan";
import type { Trainer } from "./flowTrainState";
import { FLOW, shortAgo } from "./modelsFlowData";

export const FOCUS_RING =
    "has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-1 has-focus-visible:ring-offset-background";

export type Segment<T extends string> = {
    value: T;
    label: ReactNode;
    sub?: ReactNode;
    disabled?: boolean;
};

export function Segments<T extends string>({
    label,
    value,
    options,
    onChange,
    compact,
    className,
}: {
    label: string;
    value: T | null;
    options: Segment<T>[];
    onChange: (value: T) => void;
    compact?: boolean;
    className?: string;
}) {
    return (
        <RadioGroup
            aria-label={label}
            value={value ?? ""}
            onValueChange={(next) => onChange(next as T)}
            className={cn(
                "grid auto-cols-fr grid-flow-col gap-0.5 rounded-md border bg-tabs-background p-0.5",
                compact && "inline-grid",
                className,
            )}
        >
            {options.map((item) => (
                <Label
                    key={item.value}
                    className={cn(
                        "flex cursor-pointer flex-col items-center justify-center gap-0 rounded-sm border border-transparent font-normal text-muted-foreground hover:bg-secondary hover:text-foreground has-data-checked:border-input has-data-checked:bg-tabs-active has-data-checked:font-medium has-data-checked:text-accent-foreground has-data-checked:hover:bg-tabs-active",
                        compact ? "h-7 min-w-7 px-2" : "min-h-8 px-3 py-1.5",
                        item.disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                        FOCUS_RING,
                    )}
                >
                    <RadioGroupItem
                        value={item.value}
                        disabled={item.disabled}
                        className="sr-only"
                    />
                    <span>{item.label}</span>
                    {item.sub && (
                        <span className="text-sm font-normal tabular-nums">{item.sub}</span>
                    )}
                </Label>
            ))}
        </RadioGroup>
    );
}

export function qualityTime(minutes: number | null): ReactNode {
    return minutes === null ? <span className="text-destructive">no fit</span> : approx(minutes);
}

export function QualitySegments({ t }: { t: Trainer }) {
    return (
        <Segments<Quality>
            label="Quality"
            value={t.quality}
            onChange={t.choose}
            options={QUALITIES.map((item) => ({
                value: item.id,
                label: item.label,
                sub: qualityTime(t.minutes[item.id]),
            }))}
        />
    );
}

export function CustomNote({ t }: { t: Trainer }) {
    if (t.quality) {
        return null;
    }
    return (
        <span className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
            {`Custom · ${t.changed} changed`}
            <button
                type="button"
                className="rounded-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={t.reset}
            >
                Reset
            </button>
        </span>
    );
}

const LIST = "flex flex-col divide-y rounded-md border";
const ITEM =
    "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-none px-3 py-2 font-normal hover:bg-secondary has-focus-visible:bg-secondary has-data-checked:bg-accent";
const ITEM_OFF = "cursor-not-allowed hover:bg-transparent";
const QUIET_RADIO = "focus-visible:ring-0 focus-visible:ring-offset-0";

function signed(value: number): string {
    return `${value >= 0 ? "+" : "−"}${count(Math.abs(value))}`;
}

export function versusLive(t: Trainer, rows: number, number: number): string | null {
    if (!t.live) {
        return null;
    }
    if (t.live.number === number) {
        return "live";
    }
    return `${signed(rows - t.live.rows)} vs live`;
}

export function DataList({ t, id }: { t: Trainer; id?: string }) {
    if (!t.dataset || !t.pick) {
        return null;
    }
    return (
        <div id={id} className="flex flex-col gap-2">
            <RadioGroup
                aria-label="Data version"
                value={String(t.pick.number)}
                onValueChange={(next) => t.setPicked(Number(next))}
                className={LIST}
            >
                {t.picks.map((pick, index) => (
                    <Label key={pick.number} className={ITEM}>
                        <RadioGroupItem value={String(pick.number)} className={QUIET_RADIO} />
                        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 tabular-nums">
                            <span className="font-medium">{`v${pick.number}`}</span>
                            <span>{`${count(pick.rows)} rows`}</span>
                            <span className="text-sm text-muted-foreground">
                                {shortAgo({ hoursAgo: pick.hoursAgo })}
                            </span>
                        </span>
                        <span className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
                            {versusLive(t, pick.rows, pick.number)}
                            {index === 0 && <Badge variant="info">Latest</Badge>}
                        </span>
                    </Label>
                ))}
            </RadioGroup>
            <p className="flex flex-wrap gap-x-4 text-sm">
                <Link
                    href={`${FLOW}/data/${t.dataset.slug}`}
                    onClick={() => closeTrain()}
                    className="text-primary hover:underline"
                >
                    {`Open ${t.dataset.slug}`}
                </Link>
                {t.pending > 0 && (
                    <Link
                        href={`${FLOW}/feedback`}
                        onClick={() => closeTrain()}
                        className="text-primary tabular-nums hover:underline"
                    >
                        {`${t.pending} feedback to review`}
                    </Link>
                )}
            </p>
        </div>
    );
}

export function bestOf(plan: Plan, choice: ComputeChoice): MachinePlan | null {
    const allowed = candidates(choice);
    return plan.machines
        .filter((item) => item.chosen && allowed.includes(item.machine))
        .reduce<MachinePlan | null>(
            (best, item) =>
                best === null || item.wait + item.minutes < best.wait + best.minutes ? item : best,
            null,
        );
}

function ComputeItem({
    value,
    title,
    side,
    disabled,
    indent,
}: {
    value: ComputeChoice;
    title: ReactNode;
    side: ReactNode;
    disabled?: boolean;
    indent?: boolean;
}) {
    return (
        <Label className={cn(ITEM, disabled && ITEM_OFF, indent && "pl-8")}>
            <RadioGroupItem value={value} disabled={disabled} className={QUIET_RADIO} />
            <span className={cn("min-w-0 truncate", disabled && "text-muted-foreground")}>
                {title}
            </span>
            <span className="text-right text-sm text-muted-foreground tabular-nums">{side}</span>
        </Label>
    );
}

function machineSide(item: MachinePlan): ReactNode {
    if (!item.chosen) {
        return <span className="text-destructive">{item.reason}</span>;
    }
    return [approx(item.minutes), fitText(item), queueText(item)].filter(Boolean).join(" · ");
}

export function ComputeList({ t, id }: { t: Trainer; id?: string }) {
    const auto = bestOf(t.plan, "auto");
    return (
        <RadioGroup
            id={id}
            aria-label="Compute"
            value={t.compute}
            onValueChange={(next) => t.setCompute(next as ComputeChoice)}
            className={LIST}
        >
            <ComputeItem
                value="auto"
                title="Automatic"
                side={
                    auto ? (
                        auto.machine.name
                    ) : (
                        <span className="text-destructive">nothing fits</span>
                    )
                }
            />
            {POOLS.map((pool) => {
                const machines = t.plan.machines.filter((item) => item.machine.pool === pool);
                const best = bestOf(t.plan, `pool:${pool}`);
                return [
                    <ComputeItem
                        key={`pool:${pool}`}
                        value={`pool:${pool}`}
                        title={`${pool} pool`}
                        side={
                            best ? (
                                best.machine.name
                            ) : (
                                <span className="text-destructive">nothing fits</span>
                            )
                        }
                        disabled={!best}
                    />,
                    ...machines.map((item) => (
                        <ComputeItem
                            key={item.machine.name}
                            value={`machine:${item.machine.name}`}
                            title={
                                <>
                                    {item.machine.name}
                                    <span className="text-sm text-muted-foreground">{` · ${item.machine.memoryGb} GB`}</span>
                                </>
                            }
                            side={machineSide(item)}
                            disabled={!item.chosen}
                            indent
                        />
                    )),
                ];
            })}
        </RadioGroup>
    );
}

const SEGMENTS = [
    { key: "weights", fill: "bg-(--flow-memory-1)", danger: "bg-(--flow-memory-over-1)" },
    { key: "adapter", fill: "bg-(--flow-memory-2)", danger: "bg-(--flow-memory-over-2)" },
    { key: "activations", fill: "bg-(--flow-memory-3)", danger: "bg-(--flow-memory-over-3)" },
] as const;

export function fitsIn(option: Option): boolean {
    return option.supported && option.peak <= option.usable;
}

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

export function memoryText(option: Option, machine: Machine): string {
    return `${gigabytes(option.peak).replace(" GB", "")} of ${machine.memoryGb} GB`;
}

export function fitText(item: MachinePlan): string {
    const option = item.chosen ?? item.smallest;
    return option ? memoryText(option, item.machine) : (item.reason ?? "");
}

export function queueText(item: MachinePlan): string | null {
    if (item.ahead === 0) {
        return null;
    }
    return `#${item.ahead + 1} in queue`;
}

export function Reason({ issue, className }: { issue: Issue; className?: string }) {
    return (
        <span
            className={cn(
                "inline-flex min-w-0 items-center gap-1.5 text-destructive tabular-nums",
                className,
            )}
        >
            <span className="truncate">{issue.text}</span>
            {issue.detail && <InfoTip label={issue.text}>{issue.detail}</InfoTip>}
        </span>
    );
}

export function HeldOutNote({ t }: { t: Trainer }) {
    if (!t.lowHeldOut) {
        return null;
    }
    return (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm tabular-nums">
            <span className="inline-flex items-center gap-1.5 text-warning">
                <TriangleAlert aria-hidden className="size-3.5" />
                {`${count(t.heldOut)} held out`}
            </span>
            <InfoTip label="Held-out rows">
                {`1 row = ${Math.round(100 / Math.max(t.heldOut, 1))} points of score · aim for 50+`}
            </InfoTip>
            <Button type="button" variant="outline" size="xs" onClick={t.fixHeldOut}>
                {`Hold out ${count(t.suggested)}`}
            </Button>
        </span>
    );
}

export function TrainButton({ t, className }: { t: Trainer; className?: string }) {
    return (
        <Button type="submit" disabled={!t.ready} className={className}>
            {`Train v${t.number}`}
            <Kbd className="hidden sm:inline-flex">↵</Kbd>
        </Button>
    );
}

export function Footer({ t, children }: { t: Trainer; children?: ReactNode }) {
    return (
        <footer className="flex flex-wrap items-center gap-3 border-t px-5 py-4 sm:px-7">
            <div aria-live="polite" className="flex min-w-0 flex-1 items-baseline gap-2">
                {t.blocker ? <Reason issue={t.blocker} /> : children}
            </div>
            <div className="flex gap-2">
                <DialogClose asChild>
                    <Button type="button" variant="outline">
                        Cancel
                    </Button>
                </DialogClose>
                <TrainButton t={t} />
            </div>
        </footer>
    );
}

export function dataText(t: Trainer): string {
    if (!t.dataset || !t.pick) {
        return "No dataset";
    }
    return `${t.dataset.slug} v${t.pick.number} · ${count(t.plan.rows)} rows`;
}
