import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import {
    Button,
    Card,
    CardContent,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
    Link,
    LogViewer,
} from "obp-ui";
import type { ReactNode } from "react";
import { type JobDetail, type JobMetrics, api, unwrap } from "~/api/client";
import { useJobMetrics } from "~/api/jobPageQueries";
import { isActiveJob, useJob } from "~/api/queries";
import { canRetry } from "~/components/JobSelection";
import { ModelName } from "~/components/ModelName";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, Stat } from "~/components/Section";
import { JobStatus } from "~/components/StatusBadge";
import { StatusText } from "~/components/models/StatusText";
import { useCan } from "~/lib/access";
import { MODEL_JOB_KINDS, jobDuration, jobPageHref, jobTitle, useJobEvents } from "~/lib/jobs";
import { deploymentPageHref } from "~/lib/modelLinks";
import { JOBS_PATH } from "~/lib/requests";
import { exactTime, relativeTime } from "~/lib/time";
import { JudgePanel, PlainPanel, ScorePanel, TransferPanel } from "./ProgressPanels";
import { TrainingPanel } from "./TrainingPanel";

const TRANSFERS = ["download", "import", "repair"];
const QUIET_KINDS = ["verify", "catalog_sync"];

function idOf(value: string | undefined): number | null {
    const id = Number(value);
    return value && Number.isInteger(id) && id > 0 ? id : null;
}

function BackLink({ job }: { job: JobDetail | undefined }) {
    const training = !job || MODEL_JOB_KINDS.includes(job.kind);
    return (
        <Link
            href={training ? "/training" : JOBS_PATH}
            className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
            <ChevronLeft className="size-4" />
            {training ? "Training" : "Jobs"}
        </Link>
    );
}

function Subject({ job }: { job: JobDetail }) {
    if (job.deleted) {
        const name = job.model_name ?? job.model ?? job.base_model ?? "Model";
        const version = job.version === null || job.version === undefined ? "" : ` v${job.version}`;
        return <ModelName name={`${name}${version}`} deleted />;
    }
    if (job.model) {
        const version = job.version === null || job.version === undefined ? "" : `@${job.version}`;
        return (
            <span className="inline-flex flex-wrap items-baseline gap-2">
                <span>{job.model_name ?? job.model}</span>
                <Link
                    href={`/models/custom/${encodeURIComponent(job.model)}`}
                    className="font-mono text-primary hover:underline"
                >
                    {`${job.model}${version}`}
                </Link>
            </span>
        );
    }
    if (job.base_model) {
        return (
            <Link
                href={`/models/base/${encodeURIComponent(job.base_model)}`}
                className="font-mono text-primary hover:underline"
            >
                {job.base_model}
            </Link>
        );
    }
    return <span>Install</span>;
}

function Actions({ job }: { job: JobDetail }) {
    const can = useCan();
    const router = useRouter();
    const client = useQueryClient();
    const target = { params: { path: { job_id: job.id } } };
    const cancel = useMutation({
        mutationFn: () => unwrap(api.POST("/api/jobs/{job_id}/cancel", target)),
        onSuccess: () => client.invalidateQueries({ queryKey: ["jobs"] }),
    });
    const retry = useMutation({
        mutationFn: () => unwrap(api.POST("/api/jobs/{job_id}/retry", target)),
        onSuccess: (again) => {
            client.invalidateQueries({ queryKey: ["jobs"] });
            router.history.push(jobPageHref(again.id));
        },
    });
    if (!can.build) {
        return null;
    }
    const retriable = canRetry(job);
    return (
        <>
            <ErrorLine error={cancel.error ?? retry.error} />
            {isActiveJob(job) && !job.cancel_requested && (
                <Button
                    variant="outline"
                    disabled={cancel.isPending}
                    onClick={() => cancel.mutate()}
                >
                    Cancel
                </Button>
            )}
            {retriable && (
                <Button disabled={retry.isPending} onClick={() => retry.mutate()}>
                    Retry
                </Button>
            )}
        </>
    );
}

function When({ value }: { value: string | null | undefined }) {
    if (!value) {
        return <span className="text-muted-foreground">Not yet</span>;
    }
    return <span title={exactTime(value)}>{relativeTime(value)}</span>;
}

function Summary({ job }: { job: JobDetail }) {
    return (
        <div className="flex flex-wrap gap-x-8 gap-y-3">
            <Stat label="Status" value={<JobStatus job={job} />} />
            <Stat label="Attempt" value={`${Math.max(1, job.attempt)} of ${job.max_attempts}`} />
            {job.device && <Stat label="Device" value={job.device} />}
            <Stat label="Worker" value={job.host ?? "–"} />
            <Stat label="Started" value={<When value={job.started_at} />} />
            <Stat label={job.finished_at ? "Took" : "Running for"} value={jobDuration(job)} />
            <Stat
                label="Job"
                value={<span className="font-mono font-normal">{`#${job.id}`}</span>}
            />
        </div>
    );
}

function Failure({ job }: { job: JobDetail }) {
    if (!job.error || job.status === "succeeded") {
        return null;
    }
    const retrying = job.status === "queued";
    return (
        <div
            className={
                retrying
                    ? "rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm"
                    : "rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-sm"
            }
        >
            <span className="font-semibold">{retrying ? "Retrying after: " : "Failed: "}</span>
            {job.error}
        </div>
    );
}

function Serving({ job }: { job: JobDetail }) {
    if (!job.live || !job.model) {
        return null;
    }
    return (
        <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
            <StatusText tone="success">Serving</StatusText>
            <span>{`v${job.version} is the live version of ${job.model_name ?? job.model}.`}</span>
            <Link href={deploymentPageHref(job.model)} className="text-primary hover:underline">
                Open its deployment
            </Link>
        </div>
    );
}

function KindPanel({ job, metrics }: { job: JobDetail; metrics: JobMetrics | undefined }) {
    if (job.kind === "train") {
        return <TrainingPanel job={job} metrics={metrics} />;
    }
    if (job.kind === "eval") {
        return <ScorePanel job={job} metrics={metrics} />;
    }
    if (job.kind === "judge") {
        return <JudgePanel job={job} metrics={metrics} />;
    }
    if (TRANSFERS.includes(job.kind)) {
        return <TransferPanel job={job} metrics={metrics} />;
    }
    return <PlainPanel job={job} />;
}

function JobLog({ job }: { job: JobDetail }) {
    const entries = useJobEvents(job.id);
    return (
        <LogViewer
            entries={entries}
            live={isActiveJob(job)}
            quietSource="library"
            quietLabel="Show library output"
            fileName={`job-${job.id}.log`}
            label={`Log of job ${job.id}`}
            empty={isActiveJob(job) ? "Waiting for output." : "No output recorded."}
            maxHeight="32rem"
        />
    );
}

function Logs({ job }: { job: JobDetail }) {
    const open = job.status === "failed" || QUIET_KINDS.includes(job.kind);
    return (
        <Card>
            <CardContent>
                <Collapsible defaultOpen={open}>
                    <CollapsibleTrigger className="text-base font-semibold">
                        Logs
                    </CollapsibleTrigger>
                    <CollapsibleContent className="pt-3">
                        <JobLog job={job} />
                    </CollapsibleContent>
                </Collapsible>
            </CardContent>
        </Card>
    );
}

function JobView({ job }: { job: JobDetail }) {
    const metrics = useJobMetrics(job.id, isActiveJob(job));
    return (
        <>
            <PageHeader
                title={jobTitle(job)}
                caption={<Subject job={job} />}
                actions={<Actions job={job} />}
            />
            <Summary job={job} />
            <Failure job={job} />
            <Serving job={job} />
            <ErrorLine error={metrics.error} />
            <KindPanel job={job} metrics={metrics.data} />
            <Logs key={job.id} job={job} />
        </>
    );
}

export function JobPage(): ReactNode {
    const { id } = useParams({ strict: false }) as { id?: string };
    const jobId = idOf(id);
    const job = useJob(jobId);
    return (
        <Page>
            <BackLink job={job.data} />
            {jobId === null && <p className="text-sm text-muted-foreground">No job called {id}.</p>}
            <ErrorLine error={job.error} />
            {job.data && <JobView job={job.data} />}
        </Page>
    );
}
