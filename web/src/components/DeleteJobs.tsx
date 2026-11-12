import { useMutation } from "@tanstack/react-query";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Label,
    type ToastOptions,
} from "obp-ui";
import { useEffect, useState } from "react";
import { type JobInfo, api, unwrap } from "~/api/client";
import { isActiveJob } from "~/api/queries";
import type { components } from "~/api/schema";
import { plural } from "~/pages/data/catalogue";
import { JobList, jobName } from "~/pages/models/DeleteModelsDialog";
import { ErrorLine } from "./Section";

type JobActionResult = components["schemas"]["JobActionResult"];

export function deleteRefusal(job: JobInfo): string | null {
    if (job.delete_requested) {
        return "Already being deleted; it goes once it stops.";
    }
    return job.delete_refusal ?? null;
}

export function canDelete(job: JobInfo): boolean {
    return deleteRefusal(job) === null;
}

function needsCancel(job: JobInfo): boolean {
    return isActiveJob(job) && !job.cancel_requested;
}

export function refusalSummary(jobs: JobInfo[]): string {
    const reasons = [...new Set(jobs.map(deleteRefusal).filter((reason) => reason !== null))];
    const head = `${plural(jobs.length, "selected job")} can't be deleted`;
    return reasons.length === 1 ? `${head}: ${reasons[0]}` : `${head}. ${reasons.join(" ")}`;
}

export function deleteSummary(results: JobActionResult[]): ToastOptions {
    const stopping = results.filter((result) => result.done && result.status === "running").length;
    const deleted = results.filter((result) => result.done).length - stopping;
    const refused = results.filter((result) => !result.done && result.reason !== "not_found");
    const missing = results.filter((result) => result.reason === "not_found").length;
    const parts = [
        deleted > 0 ? `Deleted ${plural(deleted, "job")}` : "",
        stopping > 0
            ? `${plural(stopping, "running job")} ${stopping === 1 ? "goes" : "go"} once stopped`
            : "",
        refused.length > 0 ? `${refused.length.toLocaleString()} kept` : "",
        missing > 0
            ? `${missing.toLocaleString()} no longer ${missing === 1 ? "exists" : "exist"}`
            : "",
    ].filter(Boolean);
    return {
        title: parts.length > 0 ? parts.join("; ") : "No job deleted",
        description: refused[0]?.error ?? undefined,
        tone: refused.length + missing === 0 ? "success" : "warning",
    };
}

function sendDelete(jobs: JobInfo[], cancelJobs: boolean): Promise<JobActionResult[]> {
    return unwrap(
        api.POST("/api/jobs/delete", {
            body: { ids: jobs.map((job) => job.id), cancel_jobs: cancelJobs },
        }),
    );
}

function SkippedList({ jobs }: { jobs: JobInfo[] }) {
    return (
        <ul className="flex max-h-40 flex-col divide-y overflow-y-auto rounded-lg border">
            {jobs.map((job) => (
                <li key={job.id} className="flex flex-col px-3 py-2">
                    <span className="truncate font-medium tabular-nums">{`${jobName(job)} · Job #${job.id}`}</span>
                    <span className="text-sm text-muted-foreground">{deleteRefusal(job)}</span>
                </li>
            ))}
        </ul>
    );
}

export function DeleteJobsDialog({
    chosen,
    onOpenChange,
    onDeleted,
}: {
    chosen: JobInfo[] | null;
    onOpenChange: (open: boolean) => void;
    onDeleted: (results: JobActionResult[]) => Promise<unknown> | undefined;
}) {
    const [cancelJobs, setCancelJobs] = useState(true);
    useEffect(() => {
        if (chosen) {
            setCancelJobs(true);
        }
    }, [chosen]);
    const picked = chosen ?? [];
    const deletable = picked.filter(canDelete);
    const skipped = picked.filter((job) => !canDelete(job));
    const running = deletable.filter(needsCancel);
    const sent = cancelJobs ? deletable : deletable.filter((job) => !needsCancel(job));
    const start = useMutation({
        mutationFn: async () => onDeleted(await sendDelete(sent, cancelJobs && running.length > 0)),
        onSuccess: () => onOpenChange(false),
    });
    const title =
        picked.length === 1
            ? `Delete job #${picked[0]?.id}?`
            : `Delete ${plural(deletable.length, "job")}?`;
    return (
        <Dialog open={chosen !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        Their events, logs and metrics go with them. The audit log keeps a record.
                        This cannot be undone.
                    </DialogDescription>
                </DialogHeader>
                {deletable.length > 0 && <JobList jobs={deletable} />}
                {skipped.length > 0 && (
                    <div className="flex flex-col gap-2">
                        <span className="text-sm text-muted-foreground tabular-nums">
                            {`${plural(skipped.length, "job")} ${skipped.length === 1 ? "stays" : "stay"}`}
                        </span>
                        <SkippedList jobs={skipped} />
                    </div>
                )}
                {running.length > 0 && (
                    <Label className="flex items-start gap-2 font-normal">
                        <Checkbox
                            checked={cancelJobs}
                            onCheckedChange={(value) => setCancelJobs(value === true)}
                            className="mt-0.5"
                        />
                        <span className="flex flex-col gap-0.5">
                            <span className="font-medium">Cancel running jobs first</span>
                            <span className="text-sm text-muted-foreground">
                                {cancelJobs
                                    ? `${plural(running.length, "job")} ${running.length === 1 ? "stops" : "stop"} and ${running.length === 1 ? "goes" : "go"} once stopped. Work so far is lost.`
                                    : `${plural(running.length, "queued or running job")} ${running.length === 1 ? "stays" : "stay"}.`}
                            </span>
                        </span>
                    </Label>
                )}
                <ErrorLine error={start.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        disabled={sent.length === 0 || start.isPending}
                        onClick={() => start.mutate()}
                    >
                        {start.isPending ? "Deleting…" : `Delete ${plural(sent.length, "job")}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
