import { Button, Link } from "obp-ui";
import type { JobDetail, JobMetrics, ModelVersionRow, VersionInfo } from "~/api/client";
import { isActiveJob, useAllModels, useVersions } from "~/api/queries";
import { ErrorLine, Section, Stat } from "~/components/Section";
import { ProgressBar } from "~/components/models/StatusText";
import { PromotionDecision } from "~/components/models/VersionResults";
import { useCan } from "~/lib/access";
import { count, percent } from "~/lib/format";
import { metricName, metricOf } from "~/lib/metrics";
import { bytes } from "~/lib/time";
import { DeployButton, usePromote } from "../EvaluationsPage";

function Progress({ job, label }: { job: JobDetail; label: string }) {
    if (!isActiveJob(job)) {
        return null;
    }
    return (
        <div className="flex items-center gap-3">
            <ProgressBar
                value={job.status === "running" && job.progress > 0 ? job.progress : null}
                label={label}
                className="w-full max-w-md"
            />
            <span className="text-sm tabular-nums">{percent(job.progress)}</span>
        </div>
    );
}

function Counted({
    job,
    metrics,
    noun,
}: { job: JobDetail; metrics: JobMetrics | undefined; noun: string }) {
    const counted = metrics?.counted;
    if (!counted || job.status === "succeeded") {
        return null;
    }
    return (
        <Stat label={`${noun} done`} value={`${count(counted.done)} of ${count(counted.total)}`} />
    );
}

function points(value: number): string {
    const shown = Math.abs(value * 100).toFixed(1);
    if (shown === "0.0") {
        return "Same";
    }
    return value > 0 ? `+${shown} pts` : `−${shown} pts`;
}

function Versus({ version, live }: { version: VersionInfo; live: ModelVersionRow | undefined }) {
    if (!live || live.number === version.number || version.score === null || live.score === null) {
        return <span className="text-muted-foreground">–</span>;
    }
    if (live.metric !== version.main_metric) {
        return <span className="text-muted-foreground">Different metric</span>;
    }
    const delta = version.score - live.score;
    const tone =
        delta > 0 ? "text-success" : delta < 0 ? "text-destructive" : "text-muted-foreground";
    return <span className={`tabular-nums ${tone}`}>{points(delta)}</span>;
}

function evaluationsHref(slug: string, number: number): string {
    return `/evaluations?version=${encodeURIComponent(`${slug}@${number}`)}`;
}

function Scores({ slug, number }: { slug: string; number: number }) {
    const versions = useVersions(slug);
    const models = useAllModels();
    const promote = usePromote();
    const can = useCan();
    const info = versions.data?.find((item) => item.number === number);
    const row = models.data?.find((item) => item.key === slug);
    const line = row?.versions?.find((item) => item.number === number);
    const live = row?.versions?.find((item) => item.live);
    if (!info) {
        return <ErrorLine error={versions.error} />;
    }
    const metric = metricName(info.main_metric).toLowerCase();
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat label={`Held-out ${metric}`} value={percent(info.score)} />
                <Stat
                    label={live && live.number !== number ? `Live v${live.number}` : "Live version"}
                    value={live && live.number !== number ? percent(live.score) : "–"}
                />
                <Stat label="vs live" value={<Versus version={info} live={live} />} />
                <Stat label="Test set" value={percent(metricOf(info.golden, info.main_metric))} />
                <Stat label="Breaks the contract" value={percent(info.held_out?.invalid_rate)} />
            </div>
            {info.promotion && <PromotionDecision decision={info.promotion} />}
            <ErrorLine error={promote.error} />
            <div className="flex flex-wrap items-center gap-2">
                {can.build && line && (
                    <DeployButton
                        version={line}
                        pending={promote.isPending}
                        onDeploy={() => promote.mutate({ slug, number })}
                    />
                )}
                <Button variant="outline" asChild>
                    <Link href={evaluationsHref(slug, number)}>Scores and mistakes</Link>
                </Button>
            </div>
        </div>
    );
}

export function ScorePanel({ job, metrics }: { job: JobDetail; metrics: JobMetrics | undefined }) {
    const done =
        job.status === "succeeded" &&
        job.model &&
        !job.deleted &&
        !job.version_deleted &&
        job.version !== null &&
        job.version !== undefined;
    return (
        <Section
            title="Scores"
            caption={
                done
                    ? "This version against the live one, and whether the promotion rule lets it go live."
                    : "Answers the held-out and test rows; the scores follow when it finishes."
            }
        >
            <div className="flex flex-col gap-4">
                <Counted job={job} metrics={metrics} noun="Rows" />
                <Progress job={job} label="Scoring progress" />
                {done && job.model && <Scores slug={job.model} number={job.version ?? 0} />}
            </div>
        </Section>
    );
}

export function JudgePanel({ job, metrics }: { job: JobDetail; metrics: JobMetrics | undefined }) {
    return (
        <Section
            title="Judging"
            caption="A judge model scores each answer from 1 to 5 with a reason."
        >
            <div className="flex flex-col gap-4">
                <Counted job={job} metrics={metrics} noun="Answers" />
                <Progress job={job} label="Judging progress" />
            </div>
        </Section>
    );
}

function speed(value: number | null | undefined): string {
    return value === null || value === undefined ? "–" : `${bytes(value)}/s`;
}

export function TransferPanel({
    job,
    metrics,
}: { job: JobDetail; metrics: JobMetrics | undefined }) {
    const transfer = metrics?.transfer;
    const running = job.status === "running";
    return (
        <Section title="Transfer" caption="Files are checked against their SHA-256 as they arrive.">
            <div className="flex flex-col gap-4">
                {transfer && (
                    <div className="flex flex-wrap gap-x-8 gap-y-3">
                        <Stat
                            label="Done"
                            value={`${bytes(transfer.bytes)} of ${bytes(transfer.total)}`}
                        />
                        {running && <Stat label="Speed" value={speed(transfer.bytes_per_second)} />}
                        {running && transfer.file && (
                            <Stat
                                label="File"
                                value={
                                    <span className="font-mono font-normal">{transfer.file}</span>
                                }
                            />
                        )}
                    </div>
                )}
                <Progress job={job} label="Transfer progress" />
                {!transfer && !isActiveJob(job) && (
                    <p className="text-sm text-muted-foreground">No files moved in this run.</p>
                )}
            </div>
        </Section>
    );
}

export function PlainPanel({ job }: { job: JobDetail }) {
    if (!isActiveJob(job)) {
        return null;
    }
    return (
        <Section title="Progress">
            <Progress job={job} label="Progress" />
        </Section>
    );
}
