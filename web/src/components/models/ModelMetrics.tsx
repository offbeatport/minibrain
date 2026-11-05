import { Tooltip, TooltipContent, TooltipTrigger, cn } from "obp-ui";
import type { ModelUsage } from "~/api/client";
import { count } from "~/lib/format";
import { relativeTime } from "~/lib/time";

function recentDays(total: number): string[] {
    const today = new Date();
    return Array.from({ length: total }, (_, offset) => {
        const day = new Date(today);
        day.setDate(today.getDate() - (total - 1 - offset));
        return day.toISOString().slice(0, 10);
    });
}

function dayName(iso: string): string {
    return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
    });
}

export function failingShare(usage: ModelUsage | null | undefined): number {
    if (!usage || typeof usage.failed !== "number" || !usage.total) {
        return 0;
    }
    return usage.failed / usage.total;
}

function Trend({ usage }: { usage: ModelUsage }) {
    if (typeof usage.previous !== "number" || typeof usage.total !== "number") {
        return null;
    }
    if (usage.previous === 0) {
        return usage.total > 0 ? <span className="text-muted-foreground">New</span> : null;
    }
    const ratio = usage.total / usage.previous;
    if (ratio >= 2) {
        return <span className="text-success">{`↑ ${Math.round(ratio)}×`}</span>;
    }
    const change = Math.round((ratio - 1) * 100);
    if (change === 0) {
        return <span className="text-muted-foreground">No change</span>;
    }
    return (
        <span className={change > 0 ? "text-success" : "text-muted-foreground"}>
            {`${change > 0 ? "↑" : "↓"} ${Math.abs(change)}%`}
        </span>
    );
}

const IDLE_WEEK = [0, 0, 0, 0, 0, 0, 0];

function DailyBars({ values, days }: { values: number[]; days: string[] }) {
    const peak = Math.max(...values, 1);
    const summary = values.map((value, index) => `${dayName(days[index])}: ${count(value)}`);
    return (
        <span
            role="img"
            aria-label={`Requests per day. ${summary.join(", ")}`}
            className="flex h-7 shrink-0 items-end gap-0.5"
        >
            {values.map((value, index) => {
                const today = index === values.length - 1;
                return (
                    <Tooltip key={days[index]}>
                        <TooltipTrigger asChild>
                            <span className="group flex h-full w-2 items-end">
                                <span
                                    className={cn(
                                        "w-full rounded-t-sm transition-opacity duration-150 motion-reduce:transition-none",
                                        value === 0
                                            ? "h-0.5 bg-border"
                                            : today
                                              ? "bg-primary"
                                              : "bg-primary/40 group-hover:bg-primary/70",
                                    )}
                                    style={
                                        value === 0
                                            ? undefined
                                            : { height: `${Math.max(12, (value / peak) * 100)}%` }
                                    }
                                />
                            </span>
                        </TooltipTrigger>
                        <TooltipContent>
                            <span className="tabular-nums">
                                {`${today ? "Today" : dayName(days[index])}: ${count(value)} ${value === 1 ? "request" : "requests"}`}
                            </span>
                        </TooltipContent>
                    </Tooltip>
                );
            })}
        </span>
    );
}

export function Requests({
    usage,
    live = false,
}: {
    usage: ModelUsage | null | undefined;
    live?: boolean;
}) {
    if (!usage) {
        if (!live) {
            return <span className="text-muted-foreground">Never used</span>;
        }
        return (
            <span className="flex items-center gap-3">
                <span className="text-muted-foreground">Never used</span>
                <DailyBars values={IDLE_WEEK} days={recentDays(IDLE_WEEK.length)} />
            </span>
        );
    }
    const days =
        usage.days?.length === usage.daily.length ? usage.days : recentDays(usage.daily.length);
    const total = usage.total ?? usage.daily.reduce((sum, value) => sum + value, 0);
    return (
        <span className="flex w-full max-w-44 items-center justify-between gap-3">
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="flex min-w-0 flex-col rounded-sm tabular-nums">
                        <span className="font-semibold">{count(total)}</span>
                        <span className="text-sm">
                            <Trend usage={usage} />
                        </span>
                    </span>
                </TooltipTrigger>
                <TooltipContent>
                    <span className="flex flex-col gap-0.5 tabular-nums">
                        <span className="font-semibold">Requests, last 7 days</span>
                        {usage.daily.map((value, position) => (
                            <span key={days[position]} className="flex justify-between gap-4">
                                <span>{dayName(days[position])}</span>
                                <span>{count(value)}</span>
                            </span>
                        ))}
                        <span className="text-muted-foreground">{`Previous 7 days: ${count(usage.previous)}`}</span>
                    </span>
                </TooltipContent>
            </Tooltip>
            {(total > 0 || live) && <DailyBars values={usage.daily} days={days} />}
        </span>
    );
}

export function LastUsed({ usage }: { usage: ModelUsage | null | undefined }) {
    if (!usage?.last_at) {
        return <span className="text-muted-foreground">Never</span>;
    }
    return (
        <span title={new Date(usage.last_at).toLocaleString()}>{relativeTime(usage.last_at)}</span>
    );
}

export function Latency({ usage }: { usage: ModelUsage | null | undefined }) {
    if (!usage || usage.p50_ms === null || usage.p50_ms === undefined) {
        return <span className="text-muted-foreground">—</span>;
    }
    return <span className="tabular-nums">{`${Math.round(usage.p50_ms)} ms`}</span>;
}
