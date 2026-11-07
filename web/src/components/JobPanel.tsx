import { useMutation } from "@tanstack/react-query";
import { Button, Link } from "obp-ui";
import { type JobInfo, api, unwrap } from "~/api/client";
import { isActiveJob } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { JobStatus } from "~/components/StatusBadge";
import { useCan } from "~/lib/access";
import { percent } from "~/lib/format";
import { jobDuration, jobPageHref, jobTitle, useInvalidate } from "~/lib/jobs";

export function JobPanel({ job, slug }: { job: JobInfo; slug: string }) {
    const invalidate = useInvalidate(slug);
    const can = useCan();
    const target = { params: { path: { job_id: job.id } } };
    const cancel = useMutation({
        mutationFn: () => unwrap(api.POST("/api/jobs/{job_id}/cancel", target)),
        onSuccess: invalidate,
    });
    const retry = useMutation({
        mutationFn: () => unwrap(api.POST("/api/jobs/{job_id}/retry", target)),
        onSuccess: invalidate,
    });
    const active = isActiveJob(job);
    const retriable = job.status === "failed" || job.status === "cancelled";
    return (
        <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Link href={jobPageHref(job.id)} className="font-semibold hover:underline">
                        {jobTitle(job)}
                    </Link>
                    <JobStatus job={job} />
                    <span className="tabular-nums text-muted-foreground">
                        {active ? percent(job.progress) : jobDuration(job)}
                        {job.attempt > 1 && ` · attempt ${job.attempt} of ${job.max_attempts}`}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    {can.build && active && !job.cancel_requested && (
                        <Button variant="outline" size="sm" onClick={() => cancel.mutate()}>
                            Cancel
                        </Button>
                    )}
                    {can.build && retriable && (
                        <Button variant="outline" size="sm" onClick={() => retry.mutate()}>
                            Retry
                        </Button>
                    )}
                    <Button variant="outline" size="sm" asChild>
                        <Link href={jobPageHref(job.id)}>Open job</Link>
                    </Button>
                </div>
            </div>
            {active && (
                <div className="h-1 overflow-hidden bg-secondary">
                    <div
                        className="h-full bg-primary"
                        style={{ width: `${Math.round(job.progress * 100)}%` }}
                    />
                </div>
            )}
            {job.error && <p className="text-destructive">{job.error}</p>}
            <ErrorLine error={cancel.error ?? retry.error} />
        </div>
    );
}
