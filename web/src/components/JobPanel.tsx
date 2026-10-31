import { useMutation } from "@tanstack/react-query";
import { Button } from "obp-ui";
import { LogView } from "obp-ui/console";
import { type JobInfo, api, unwrap } from "~/api/client";
import { isActiveJob } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { JobStatus } from "~/components/StatusBadge";
import { percent } from "~/lib/format";
import { describeLine, useInvalidate, useJobLog } from "~/lib/jobs";

const KIND_TITLES: Record<string, string> = {
    prepare: "Building dataset",
    train: "Training",
    eval: "Scoring",
};

function jobTitle(job: JobInfo): string {
    const title = KIND_TITLES[job.kind] ?? job.kind;
    return job.version === null ? title : `${title} v${job.version}`;
}

export function JobPanel({ job, slug }: { job: JobInfo; slug: string }) {
    const lines = useJobLog(job);
    const invalidate = useInvalidate(slug);
    const target = { params: { path: { job_id: job.id } } };
    const cancel = useMutation({
        mutationFn: () => unwrap(api.POST("/api/jobs/{job_id}/cancel", target)),
        onSuccess: invalidate,
    });
    const retry = useMutation({
        mutationFn: () => unwrap(api.POST("/api/jobs/{job_id}/retry", target)),
        onSuccess: invalidate,
    });
    const retriable = job.status === "failed" || job.status === "cancelled";
    return (
        <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm">
                    <span className="font-semibold">{jobTitle(job)}</span>
                    <JobStatus job={job} />
                    <span className="tabular-nums text-muted-foreground">
                        {percent(job.progress)}
                        {job.attempt > 1 && ` · attempt ${job.attempt} of ${job.max_attempts}`}
                    </span>
                </div>
                {isActiveJob(job) && !job.cancel_requested && (
                    <Button variant="outline" size="sm" onClick={() => cancel.mutate()}>
                        Cancel
                    </Button>
                )}
                {retriable && (
                    <Button variant="outline" size="sm" onClick={() => retry.mutate()}>
                        Retry
                    </Button>
                )}
            </div>
            <div className="h-1 overflow-hidden bg-secondary">
                <div
                    className="h-full bg-primary"
                    style={{ width: `${Math.round(job.progress * 100)}%` }}
                />
            </div>
            {job.error && <p className="text-sm text-destructive">{job.error}</p>}
            <LogView
                lines={lines.map(describeLine)}
                className="max-h-64"
                empty={isActiveJob(job) ? "Waiting for output…" : "No output recorded."}
            />
            <ErrorLine error={cancel.error ?? retry.error} />
        </div>
    );
}
