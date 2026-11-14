import { MemoryStick } from "lucide-react";
import { cn } from "obp-ui";
import type { ReactNode } from "react";
import { SummaryLine } from "~/components/CreateLayout";
import { PoolLink } from "~/components/PoolLink";
import { count } from "~/lib/format";
import { ResourceBar } from "../../ResourceGauges";
import { type OptionInfo, duration, gigabytes } from "./recipe";

export function Row({
    id,
    label,
    children,
}: { id: string; label: ReactNode; children: ReactNode }) {
    return (
        <section
            aria-labelledby={id}
            className="grid gap-label py-4 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-x-6"
        >
            <h3 id={id} className="text-base font-medium sm:leading-8">
                {label}
            </h3>
            <div className="flex min-w-0 flex-col gap-2">{children}</div>
        </section>
    );
}

export function Meta({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <p className={cn("text-sm text-muted-foreground tabular-nums", className)}>{children}</p>
    );
}

export type PresetTime = number | null | undefined | "unplanned";

export function timeText(time: PresetTime): string {
    if (time === undefined) {
        return "Estimating…";
    }
    if (time === "unplanned") {
        return "planned by the worker";
    }
    return time === null ? "Does not fit" : `≈ ${duration(time)}`;
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

export function fitText(option: OptionInfo | null | undefined): string {
    if (!option) {
        return "does not fit";
    }
    return `fits ${gigabytes(option.peak_bytes).replace(" GB", "")} of ${gigabytes(option.available_bytes)}`;
}

export const AUTO = "auto";

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

export function MemorySummary({
    option,
    memoryLabel,
    pool,
}: {
    option: OptionInfo;
    memoryLabel: string;
    pool: string | null;
}) {
    const ok = fits(option);
    const parts = partsOf(option);
    const available = option.available_bytes ?? option.peak_bytes;
    return (
        <>
            <ResourceBar
                label={`${memoryLabel} for training`}
                total={Math.max(available, option.peak_bytes)}
                segments={SEGMENTS.map((segment) => ({
                    id: segment.key,
                    value: parts[segment.key],
                    fill: ok ? segment.fill : segment.danger,
                }))}
            />
            <SummaryLine
                icon={MemoryStick}
                className={cn("tabular-nums", !ok && "text-destructive")}
            >
                {ok
                    ? `${gigabytes(option.peak_bytes)} of ${gigabytes(available)} ${memoryLabel}`
                    : `${gigabytes(option.peak_bytes)} needed · only ${gigabytes(available)} ${memoryLabel}`}
                {pool && (
                    <>
                        {" in "}
                        <PoolLink name={pool} align="end" />
                    </>
                )}
            </SummaryLine>
            <ul className="flex flex-col gap-0.5 text-muted-foreground tabular-nums">
                {SEGMENTS.map((segment) => (
                    <li key={segment.key} className="flex items-center gap-2">
                        <span
                            aria-hidden
                            className={cn("size-2 rounded-xs", ok ? segment.fill : segment.danger)}
                        />
                        <span className="flex-1">{segment.label}</span>
                        <span>{gigabytes(parts[segment.key])}</span>
                    </li>
                ))}
            </ul>
        </>
    );
}

export function PaneHeader({
    id,
    title,
    action,
}: {
    id: string;
    title: string;
    action?: ReactNode;
}) {
    return (
        <div className="flex min-h-12 items-center justify-between gap-3 border-b">
            <h3 id={id} className="font-medium">
                {title}
            </h3>
            {action}
        </div>
    );
}
