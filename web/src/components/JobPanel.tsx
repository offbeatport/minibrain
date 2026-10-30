import { useMutation } from "@tanstack/react-query";
import { Button } from "obp-ui";
import { LogView } from "obp-ui/console";
import { type JobInfo, api, unwrap } from "~/api/client";
import { isActiveJob } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { JobStatus } from "~/components/StatusBadge";
import { percent } from "~/lib/format";
import { describeLine, useInvalidate, useJobLog } from "~/lib/jobs";

export function JobPanel({ job, slug }: { job: JobInfo; slug: string }) {
    const lines = useJobLog(job);
    const invalidate = useInvalidate(slug);
    const cancel = useMutation({
        mutationFn: () =>
            unwrap(api.POST("/api/jobs/{job_id}/cancel", { params: { path: { job_id: job.id } } })),
        onSuccess: invalidate,
    });
    const label = job.kind === "train" ? "Training" : "Scoring";
    return (
        <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm">
                    <span className="font-semibold">
                        {label} v{job.version}
                    </span>
                    <JobStatus job={job} />
                    <span className="tabular-nums text-muted-foreground">
                        {percent(job.progress)}
                    </span>
                </div>
                {isActiveJob(job) && (
                    <Button variant="outline" size="sm" onClick={() => cancel.mutate()}>
                        Cancel
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
                empty="Waiting for output…"
            />
            <ErrorLine error={cancel.error} />
        </div>
    );
}
