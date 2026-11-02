import { Check, ChevronRight, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, cn } from "obp-ui";
import { Fragment } from "react";
import type { ModelStage, ModelUsage } from "~/api/client";
import { count } from "~/lib/format";
import { relativeTime } from "~/lib/time";

const STAGE_NAMES: Record<ModelStage["key"], string> = {
    data: "Data",
    train: "Train",
    evaluate: "Evaluate",
    deploy: "Deploy",
};

function StageMark({ state }: { state: ModelStage["state"] }) {
    if (state === "done") {
        return <Check aria-hidden="true" className="size-3.5 shrink-0 text-success" />;
    }
    if (state === "failed") {
        return <X aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />;
    }
    return (
        <span
            aria-hidden="true"
            className={cn(
                "size-2 shrink-0 rounded-full",
                state === "active" ? "bg-info" : "border border-faint",
            )}
        />
    );
}

export function Stages({ stages }: { stages: ModelStage[] }) {
    return (
        <ol className="flex items-center gap-1 text-sm whitespace-nowrap">
            {stages.map((stage, index) => (
                <Fragment key={stage.key}>
                    {index > 0 && (
                        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-faint" />
                    )}
                    <li
                        className={cn(
                            "flex items-center gap-1.5",
                            stage.state === "todo" && "text-muted-foreground",
                            stage.state === "failed" && "text-destructive",
                        )}
                    >
                        <StageMark state={stage.state} />
                        <span className="sr-only">{`${STAGE_NAMES[stage.key]}: `}</span>
                        <span className="tabular-nums">
                            {stage.label}
                            {stage.state === "active" && stage.progress
                                ? ` · ${Math.round(stage.progress * 100)}%`
                                : ""}
                        </span>
                    </li>
                </Fragment>
            ))}
        </ol>
    );
}

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

export function Requests({ usage }: { usage: ModelUsage | null | undefined }) {
    if (!usage) {
        return <span className="text-muted-foreground">Never used</span>;
    }
    const days =
        usage.days?.length === usage.daily.length ? usage.days : recentDays(usage.daily.length);
    return (
        <span className="flex">
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="inline-flex w-fit items-baseline gap-2 rounded-sm tabular-nums">
                        <span className="font-semibold">
                            {count(
                                usage.total ?? usage.daily.reduce((sum, value) => sum + value, 0),
                            )}
                        </span>
                        <Trend usage={usage} />
                    </span>
                </TooltipTrigger>
                <TooltipContent>
                    <span className="flex flex-col gap-0.5 tabular-nums">
                        <span className="font-semibold">Requests per day</span>
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
