import {
    Select,
    SelectContent,
    SelectItem,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
    cn,
} from "obp-ui";
import { Fragment, type ReactNode } from "react";
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

export function timeText(time: number | null | undefined): string {
    return time === undefined
        ? "Estimating…"
        : time === null
          ? "Does not fit"
          : `≈ ${duration(time)}`;
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

export type PickOption = {
    value: string;
    label: ReactNode;
    meta?: ReactNode;
    disabled?: boolean;
    separated?: boolean;
};

export function PickSelect({
    id,
    value,
    options,
    onChange,
    disabled,
}: {
    id: string;
    value: string;
    options: PickOption[];
    onChange: (value: string) => void;
    disabled?: boolean;
}) {
    return (
        <Select
            value={value}
            disabled={disabled}
            onValueChange={(next) => next !== null && onChange(String(next))}
        >
            <SelectTrigger
                id={id}
                aria-labelledby={id.replace("-select", "")}
                className="w-full max-sm:[&_[data-pick-meta]]:hidden"
            >
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {options.map((option) => (
                    <Fragment key={option.value}>
                        {option.separated && <SelectSeparator />}
                        <SelectItem value={option.value} disabled={option.disabled}>
                            <span className="truncate">{option.label}</span>
                            {option.meta && (
                                <span
                                    data-pick-meta
                                    className="ml-auto truncate pl-4 text-sm text-muted-foreground tabular-nums"
                                >
                                    {option.meta}
                                </span>
                            )}
                        </SelectItem>
                    </Fragment>
                ))}
            </SelectContent>
        </Select>
    );
}

export function MemoryGaugeFooter({
    option,
    memoryLabel,
}: {
    option: OptionInfo;
    memoryLabel: string;
}) {
    const ok = fits(option);
    const parts = partsOf(option);
    const available = option.available_bytes ?? option.peak_bytes;
    return (
        <div className="flex flex-col gap-1.5">
            <ResourceBar
                label={`${memoryLabel} for training`}
                total={Math.max(available, option.peak_bytes)}
                segments={SEGMENTS.map((segment) => ({
                    id: segment.key,
                    value: parts[segment.key],
                    fill: ok ? segment.fill : segment.danger,
                }))}
            />
            <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-muted-foreground tabular-nums">
                <span className={cn("text-foreground", !ok && "text-destructive")}>
                    {`${gigabytes(option.peak_bytes)} of ${gigabytes(available)} ${memoryLabel}`}
                </span>
                {SEGMENTS.map((segment) => (
                    <span key={segment.key} className="inline-flex items-center gap-1.5">
                        <span
                            aria-hidden
                            className={cn("size-2 rounded-xs", ok ? segment.fill : segment.danger)}
                        />
                        {`${segment.label} ${gigabytes(parts[segment.key])}`}
                    </span>
                ))}
            </p>
        </div>
    );
}

export function MemorySummary({
    option,
    memoryLabel,
}: {
    option: OptionInfo;
    memoryLabel: string;
}) {
    const ok = fits(option);
    const parts = partsOf(option);
    const available = option.available_bytes ?? option.peak_bytes;
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">Memory</span>
                <span className={cn("tabular-nums", !ok && "text-destructive")}>
                    {`${gigabytes(option.peak_bytes)} of ${gigabytes(available)}`}
                </span>
            </div>
            <ResourceBar
                label={`${memoryLabel} for training`}
                total={Math.max(available, option.peak_bytes)}
                segments={SEGMENTS.map((segment) => ({
                    id: segment.key,
                    value: parts[segment.key],
                    fill: ok ? segment.fill : segment.danger,
                }))}
            />
            <ul className="flex flex-col gap-0.5 text-sm text-muted-foreground tabular-nums">
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
        </div>
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
