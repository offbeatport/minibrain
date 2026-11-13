import { Card, cn } from "obp-ui";
import type { ReactNode } from "react";
import { count } from "~/lib/format";
import { MemorySummary } from "./parts";
import { duration, hoursText } from "./recipe";
import type { TrainRun } from "./useTrainRun";

function estimateOf(run: TrainRun, blocked: string | null): string {
    const info = run.info;
    if (blocked || !run.chosen) {
        return "–";
    }
    if (info?.chosen && info.minutes !== null && info.minutes !== undefined) {
        return `≈ ${duration(info.minutes)}`;
    }
    return run.planning ? "Planning…" : "–";
}

function problemsOf(run: TrainRun, blocked: string | null): string[] {
    if (blocked) {
        return [blocked];
    }
    if (!run.chosen) {
        return ["Add training data first: training needs examples."];
    }
    const own = run.issues.filter((issue) => issue.field !== "compute");
    const shown = own.length > 0 ? own : run.issues;
    return [...(run.failure ? [run.failure] : []), ...shown.map((issue) => issue.text)];
}

function Item({ label, children }: { label: string; children: ReactNode }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate text-right tabular-nums">{children}</dd>
        </>
    );
}

export function RunSummary({
    run,
    blocked,
    actions,
}: {
    run: TrainRun;
    blocked: string | null;
    actions: ReactNode;
}) {
    const info = run.info;
    const fits = Boolean(info?.chosen);
    const machine = fits ? run.pickedMachine : null;
    const minutes = fits ? (info?.minutes ?? null) : null;
    const problems = problemsOf(run, blocked);
    const unknown = info && !info.chosen && info.level === "unknown" ? info.basis : null;
    return (
        <Card className="gap-0 divide-y py-0">
            <div className="flex flex-col gap-1 p-panel">
                <span className="text-muted-foreground">Estimated time</span>
                <output className="text-3xl tabular-nums" aria-live="polite">
                    {estimateOf(run, blocked)}
                </output>
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 p-panel">
                <Item label="Machine">
                    {machine ? `${machine.name} · ${machine.pool}` : (info?.machine ?? "–")}
                </Item>
                <Item label={machine?.kind === "cpu" ? "CPU-hours" : "GPU-hours"}>
                    {minutes === null ? "–" : hoursText(minutes)}
                </Item>
                <Item label="Queue">
                    {info
                        ? info.queue.ahead > 0
                            ? `${info.queue.ahead} ahead`
                            : "Starts now"
                        : "–"}
                </Item>
                <Item label="Rows">{count(info?.rows ?? run.available)}</Item>
                <Item label="Held out">{count(run.heldOut)}</Item>
                <Item label="Creates">{`v${run.number}`}</Item>
            </dl>
            {run.option && !blocked && (
                <div className="p-panel">
                    <MemorySummary
                        option={run.option}
                        memoryLabel={info?.memory_label ?? "memory"}
                    />
                </div>
            )}
            <div
                className={cn(
                    "flex-col gap-3 p-panel",
                    problems.length > 0 || unknown ? "flex" : "hidden @4xl:flex",
                )}
            >
                {problems.length > 0 && (
                    <ul role="alert" className="flex flex-col gap-1.5 text-destructive">
                        {problems.map((text) => (
                            <li key={text}>{text}</li>
                        ))}
                    </ul>
                )}
                {unknown && <p className="text-sm text-muted-foreground">{unknown}</p>}
                {actions}
            </div>
        </Card>
    );
}

export function StatusLine({
    run,
    blocked,
    className,
}: {
    run: TrainRun;
    blocked: string | null;
    className?: string;
}) {
    const problem = problemsOf(run, blocked)[0];
    const minutes = run.info?.chosen ? run.info.minutes : null;
    const text =
        problem ??
        (run.ready && minutes !== null && minutes !== undefined
            ? `≈ ${duration(minutes)} · ${count(run.info?.rows ?? run.available)} rows`
            : run.planning
              ? "Planning…"
              : "Waiting for the planner.");
    return (
        <p
            aria-live="polite"
            className={cn(
                "tabular-nums",
                problem ? "text-destructive" : "text-muted-foreground",
                className,
            )}
        >
            {text}
        </p>
    );
}
