import { Check, ChevronRight, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, cn } from "obp-ui";
import { Fragment } from "react";
import type { ModelStage, ModelUsage } from "~/api/client";
import { count } from "~/lib/format";

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

const BAR_WIDTH = 9;
const BAR_GAP = 3;
const CHART_HEIGHT = 20;

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

export function Requests({ usage }: { usage: ModelUsage | null | undefined }) {
    if (!usage) {
        return <span className="text-muted-foreground">No requests</span>;
    }
    const total = usage.daily.reduce((sum, value) => sum + value, 0);
    const peak = Math.max(...usage.daily, 1);
    const width = usage.daily.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP;
    const days =
        usage.days?.length === usage.daily.length ? usage.days : recentDays(usage.daily.length);
    const bars = usage.daily.map((value, position) => ({
        value,
        day: days[position],
        x: position * (BAR_WIDTH + BAR_GAP),
        height: value > 0 ? Math.max(2, (value / peak) * CHART_HEIGHT) : 1,
    }));
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex flex-col gap-1 rounded-sm">
                    <span className="font-semibold tabular-nums">{count(total)}</span>
                    <svg
                        width={width}
                        height={CHART_HEIGHT}
                        viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
                        aria-hidden="true"
                        className="text-primary"
                    >
                        {bars.map((bar) => (
                            <rect
                                key={bar.day}
                                x={bar.x}
                                y={CHART_HEIGHT - bar.height}
                                width={BAR_WIDTH}
                                height={bar.height}
                                rx={1}
                                fill="currentColor"
                                opacity={bar.value > 0 ? 1 : 0.3}
                            />
                        ))}
                    </svg>
                </span>
            </TooltipTrigger>
            <TooltipContent>
                <span className="flex flex-col gap-0.5 tabular-nums">
                    <span className="font-semibold">Requests per day</span>
                    {bars.map((bar) => (
                        <span key={bar.day} className="flex justify-between gap-4">
                            <span>{dayName(bar.day)}</span>
                            <span>{count(bar.value)}</span>
                        </span>
                    ))}
                </span>
            </TooltipContent>
        </Tooltip>
    );
}

export function Latency({ usage }: { usage: ModelUsage | null | undefined }) {
    if (!usage || usage.p50_ms === null || usage.p50_ms === undefined) {
        return <span className="text-muted-foreground">—</span>;
    }
    return <span className="tabular-nums">{`${Math.round(usage.p50_ms)} ms`}</span>;
}
