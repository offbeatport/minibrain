import {
    Cpu,
    GraduationCap,
    ListOrdered,
    MemoryStick,
    Play,
    Rows3,
    ScrollText,
    Server,
    Timer,
} from "lucide-react";
import { Link, Popover, PopoverContent, PopoverTrigger } from "obp-ui";
import {
    BlockedReasons,
    SummaryCard,
    SummaryFact,
    SummaryFacts,
    SummaryLine,
    SummarySection,
} from "~/components/CreateLayout";
import { count } from "~/lib/format";
import { durationText } from "~/lib/jobs";
import { MemorySummary } from "./parts";
import type { PoolPlan } from "./pools";
import { duration, gigabytes, hoursText } from "./recipe";
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

export function problemsOf(run: TrainRun, blocked: string | null): string[] {
    if (blocked) {
        return [blocked];
    }
    if (!run.training) {
        return run.failure ? [run.failure] : [];
    }
    if (!run.chosen) {
        return ["Add training data first: training needs examples."];
    }
    const own = run.issues.filter((issue) => issue.field !== "compute");
    const shown = own.length > 0 ? own : run.issues;
    return [...(run.failure ? [run.failure] : []), ...shown.map((issue) => issue.text)];
}

function poolHref(name: string): string {
    return `/infrastructure#pool-${encodeURIComponent(name)}`;
}

function PoolCard({ pool }: { pool: PoolPlan }) {
    return (
        <div className="flex w-72 flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{pool.label}</span>
                <span className="text-sm text-muted-foreground tabular-nums">
                    {`${count(pool.machines.length)} ${pool.machines.length === 1 ? "machine" : "machines"}`}
                </span>
            </div>
            <ul className="flex flex-col gap-1.5">
                {pool.machines.map((item) => (
                    <li key={item.name} className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate">{item.name}</span>
                        <span
                            className={
                                item.chosen
                                    ? "shrink-0 text-sm text-muted-foreground tabular-nums"
                                    : "shrink-0 text-sm text-destructive"
                            }
                        >
                            {item.chosen
                                ? `${gigabytes(item.available_bytes)} ${item.memory_label} · ≈ ${duration(item.minutes)}`
                                : (item.reason ?? "does not fit")}
                        </span>
                    </li>
                ))}
            </ul>
            <Link href={poolHref(pool.name)} className="text-sm text-primary hover:underline">
                Open in Infrastructure →
            </Link>
        </div>
    );
}

function PoolFact({ run }: { run: TrainRun }) {
    const machine = run.pickedMachine;
    const chosen =
        run.pools.find((item) => item.name === run.compute) ??
        run.pools.find((item) => item.name === machine?.pool);
    const name = chosen?.name ?? machine?.pool;
    if (!name) {
        return "–";
    }
    const pinned = run.recipe.machine !== "auto";
    return (
        <>
            {chosen ? (
                <Popover>
                    <PopoverTrigger
                        openOnHover
                        delay={150}
                        render={
                            <Link
                                href={poolHref(name)}
                                className="text-primary underline-offset-2 hover:underline"
                            />
                        }
                    >
                        {name}
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-auto">
                        <PoolCard pool={chosen} />
                    </PopoverContent>
                </Popover>
            ) : (
                <Link href={poolHref(name)} className="text-primary hover:underline">
                    {name}
                </Link>
            )}
            {machine && pinned && (
                <span className="block truncate text-sm text-muted-foreground">
                    {machine.name}
                </span>
            )}
        </>
    );
}

function scoreTime(run: TrainRun): string {
    return run.scoreSeconds === null ? "–" : `≈ ${durationText(run.scoreSeconds)}`;
}

function heldOutText(run: TrainRun): string {
    return run.chosen ? `scored on ${count(run.heldOut)} held-out rows` : "not scored: no data";
}

function ScoreSummary({
    run,
    blocked,
    changed,
}: {
    run: TrainRun;
    blocked: string | null;
    changed: boolean;
}) {
    return (
        <SummaryCard>
            <SummarySection title="Estimate">
                <SummaryFacts>
                    <SummaryFact icon={Timer} label="Scores in">
                        {blocked || !run.chosen ? "–" : scoreTime(run)}
                    </SummaryFact>
                    <SummaryFact icon={Rows3} label="Held out">
                        {count(run.heldOut)}
                    </SummaryFact>
                    <SummaryFact icon={ScrollText} label="Instructions">
                        {changed ? "Changed" : "Unchanged"}
                    </SummaryFact>
                </SummaryFacts>
            </SummarySection>
            <SummarySection title="Result">
                <SummaryLine icon={Play} className="tabular-nums">
                    {`v${run.number} · instructions only, ${heldOutText(run)}`}
                </SummaryLine>
            </SummarySection>
            <BlockedReasons reasons={problemsOf(run, blocked)} />
        </SummaryCard>
    );
}

export function RunSummary({
    run,
    blocked,
    changed,
}: {
    run: TrainRun;
    blocked: string | null;
    changed: boolean;
}) {
    if (!run.training) {
        return <ScoreSummary run={run} blocked={blocked} changed={changed} />;
    }
    const info = run.info;
    const fits = Boolean(info?.chosen);
    const machine = fits ? run.pickedMachine : null;
    const minutes = fits ? (info?.minutes ?? null) : null;
    const unknown = info && !info.chosen && info.level === "unknown" ? info.basis : null;
    const memoryLabel = info?.memory_label ?? "memory";
    return (
        <SummaryCard>
            <SummarySection title="Estimate">
                <SummaryFacts>
                    <SummaryFact icon={Timer} label="Time">
                        {estimateOf(run, blocked)}
                    </SummaryFact>
                    <SummaryFact icon={Server} label="Pool">
                        <PoolFact run={run} />
                    </SummaryFact>
                    <SummaryFact
                        icon={Cpu}
                        label={machine?.kind === "cpu" ? "CPU-hours" : "GPU-hours"}
                    >
                        {minutes === null ? "–" : hoursText(minutes)}
                    </SummaryFact>
                    <SummaryFact icon={ListOrdered} label="Queue">
                        {info
                            ? info.queue.ahead > 0
                                ? `${info.queue.ahead} ahead`
                                : "Starts now"
                            : "–"}
                    </SummaryFact>
                </SummaryFacts>
            </SummarySection>
            <SummarySection title="Memory on your compute">
                {run.option && !blocked ? (
                    <MemorySummary option={run.option} memoryLabel={memoryLabel} />
                ) : (
                    <SummaryLine icon={MemoryStick} className="text-muted-foreground">
                        {run.planning ? "Planning…" : "Not planned yet"}
                    </SummaryLine>
                )}
                {unknown && <p className="text-sm text-muted-foreground">{unknown}</p>}
            </SummarySection>
            <SummarySection title="Result">
                <SummaryLine icon={GraduationCap} className="tabular-nums">
                    {`v${run.number} · trained on ${count(info?.rows ?? run.available)} rows, ${heldOutText(run)}`}
                </SummaryLine>
            </SummarySection>
            <BlockedReasons reasons={problemsOf(run, blocked)} />
        </SummaryCard>
    );
}

export function statusOf(run: TrainRun, blocked: string | null): string {
    const problem = problemsOf(run, blocked)[0];
    if (problem) {
        return problem;
    }
    if (!run.training) {
        return `Scores in ${scoreTime(run)} on ${count(run.heldOut)} held-out rows`;
    }
    const minutes = run.info?.chosen ? run.info.minutes : null;
    if (run.ready && minutes !== null && minutes !== undefined) {
        return `≈ ${duration(minutes)} · ${count(run.info?.rows ?? run.available)} rows`;
    }
    return run.planning ? "Planning…" : "Waiting for the planner.";
}
