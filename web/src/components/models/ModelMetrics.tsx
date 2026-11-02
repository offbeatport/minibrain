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

const BAR_WIDTH = 4;
const BAR_GAP = 2;
const CHART_HEIGHT = 16;

export function Requests({ usage }: { usage: ModelUsage | null | undefined }) {
    if (!usage) {
        return <span className="text-muted-foreground">—</span>;
    }
    const total = usage.daily.reduce((sum, value) => sum + value, 0);
    const peak = Math.max(...usage.daily, 1);
    const width = usage.daily.length * (BAR_WIDTH + BAR_GAP) - BAR_GAP;
    const bars = usage.daily.map((value, position) => ({
        value,
        daysAgo: usage.daily.length - 1 - position,
        x: position * (BAR_WIDTH + BAR_GAP),
        height: value > 0 ? Math.max(2, (value / peak) * CHART_HEIGHT) : 1,
    }));
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex flex-col gap-0.5 rounded-sm">
                    <span className="inline-flex items-end gap-2">
                        <svg
                            width={width}
                            height={CHART_HEIGHT}
                            viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
                            aria-hidden="true"
                            className="text-primary"
                        >
                            {bars.map((bar) => (
                                <rect
                                    key={bar.daysAgo}
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
                        <span className="tabular-nums">{count(total)}</span>
                    </span>
                    {usage.p50_ms !== null && usage.p50_ms !== undefined && (
                        <span className="text-sm text-muted-foreground tabular-nums">
                            {`p50 ${Math.round(usage.p50_ms)} ms`}
                        </span>
                    )}
                </span>
            </TooltipTrigger>
            <TooltipContent>
                {`${count(total)} requests in the last 7 days (${usage.daily.join(", ")}); median latency p50`}
            </TooltipContent>
        </Tooltip>
    );
}
