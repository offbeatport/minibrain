import { Gauge, Hourglass } from "lucide-react";
import { Button, Link } from "obp-ui";
import type { ReactNode } from "react";
import type { JobDetail, JobMetrics, ModelVersionRow, VersionInfo } from "~/api/client";
import { isActiveJob, useAllModels, useVersions } from "~/api/queries";
import { Facts } from "~/components/Facts";
import { ErrorLine, PanelSection, Stat } from "~/components/Section";
import { ProgressBar } from "~/components/models/StatusText";
import { PromotionDecision } from "~/components/models/VersionResults";
import { useCan } from "~/lib/access";
import { count, percent } from "~/lib/format";
import { metricName, metricOf } from "~/lib/metrics";
import { bytes, exactTime, relativeTime } from "~/lib/time";
import { DeployButton, usePromote } from "../EvaluationsPage";
import { trainingFacts } from "./TrainingPanel";

type Fact = [string, ReactNode];

const TRANSFERS = ["download", "import", "repair"];
const COUNTED_NOUNS: Record<string, string> = { eval: "Rows", judge: "Answers" };

function Figure({ children }: { children: ReactNode }) {
    return <span className="tabular-nums">{children}</span>;
}

function reached(job: JobDetail): number | null {
    if (job.status === "succeeded") {
        return 1;
    }
    if (job.status === "queued") {
        return 0;
    }
    return job.progress > 0 ? job.progress : job.status === "running" ? null : 0;
}

function speed(value: number | null | undefined): string {
    return value === null || value === undefined ? "–" : `${bytes(value)}/s`;
}

function transferFacts(job: JobDetail, metrics: JobMetrics | undefined): Fact[] {
    const transfer = metrics?.transfer;
    if (!transfer) {
        return [];
    }
    const facts: Fact[] = [
        [
            "Moved",
            <Figure key="moved">{`${bytes(transfer.bytes)} of ${bytes(transfer.total)}`}</Figure>,
        ],
    ];
    if (job.status === "running") {
        facts.push(["Speed", <Figure key="speed">{speed(transfer.bytes_per_second)}</Figure>]);
        if (transfer.file) {
            facts.push([
                "File",
                <span key="file" className="font-mono text-sm">
                    {transfer.file}
                </span>,
            ]);
        }
    }
    return facts;
}

function countedFacts(job: JobDetail, metrics: JobMetrics | undefined): Fact[] {
    const counted = metrics?.counted;
    const noun = COUNTED_NOUNS[job.kind];
    if (!counted || !noun) {
        return [];
    }
    return [
        [
            `${noun} done`,
            <Figure key="done">{`${count(counted.done)} of ${count(counted.total)}`}</Figure>,
        ],
    ];
}

function kindFacts(job: JobDetail, metrics: JobMetrics | undefined): Fact[] {
    if (job.kind === "train") {
        return trainingFacts(job, metrics?.training);
    }
    if (TRANSFERS.includes(job.kind)) {
        return transferFacts(job, metrics);
    }
    return countedFacts(job, metrics);
}

function When({ value }: { value: string | null | undefined }) {
    if (!value) {
        return <span className="text-muted-foreground">Not yet</span>;
    }
    return (
        <time dateTime={value} title={exactTime(value)} className="tabular-nums">
            {relativeTime(value)}
        </time>
    );
}

function quietNote(job: JobDetail, facts: Fact[]): string | null {
    if (facts.length > 0) {
        return null;
    }
    if (job.status === "queued") {
        return "Waiting for a worker.";
    }
    return TRANSFERS.includes(job.kind) && !isActiveJob(job) ? "No files moved in this run." : null;
}

export function ProgressSection({
    job,
    metrics,
}: { job: JobDetail; metrics: JobMetrics | undefined }) {
    const facts = kindFacts(job, metrics);
    const share = reached(job);
    const note = quietNote(job, facts);
    return (
        <PanelSection
            icon={Hourglass}
            title="Progress"
            description="Where the job is and how fast it moves."
        >
            <div className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                    <ProgressBar
                        value={share}
                        label={`Job ${job.id} progress`}
                        tone={job.status === "failed" ? "destructive" : "primary"}
                        className="w-full"
                    />
                    <span className="w-12 shrink-0 text-right tabular-nums">
                        {share === null ? "–" : `${Math.round(share * 100)}%`}
                    </span>
                </div>
                {note && <p className="text-muted-foreground">{note}</p>}
                <Facts
                    items={[
                        ...facts,
                        ["Queued", <When key="queued" value={job.created_at} />],
                        ["Started", <When key="started" value={job.started_at} />],
                    ]}
                />
            </div>
        </PanelSection>
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

function reviewHref(slug: string, number: number): string {
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
        return <ErrorLine error={versions.error} onRetry={versions.refetch} />;
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
                    <Link href={reviewHref(slug, number)}>Scores and mistakes</Link>
                </Button>
            </div>
        </div>
    );
}

export function ScoresSection({ job }: { job: JobDetail }) {
    const done =
        job.status === "succeeded" &&
        job.model &&
        !job.deleted &&
        !job.version_deleted &&
        job.version !== null &&
        job.version !== undefined;
    return (
        <PanelSection
            icon={Gauge}
            title="Scores"
            description={
                done
                    ? "This version against the live one, and whether the promotion rule lets it go live."
                    : "The held-out and test rows are answered first; the scores follow when it finishes."
            }
        >
            {done && job.model ? (
                <Scores slug={job.model} number={job.version ?? 0} />
            ) : (
                <p className="text-muted-foreground">
                    {isActiveJob(job) ? "Scores appear when scoring finishes." : "No scores."}
                </p>
            )}
        </PanelSection>
    );
}
