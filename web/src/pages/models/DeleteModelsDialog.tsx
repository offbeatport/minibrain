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
    Link,
} from "obp-ui";
import { useEffect, useState } from "react";
import type { JobInfo, ModelRow } from "~/api/client";
import { useActiveJobs } from "~/api/queries";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine } from "~/components/Section";
import { JobStatus } from "~/components/StatusBadge";
import { StatusText } from "~/components/models/StatusText";
import { kindName } from "~/lib/jobs";
import { jobHref } from "~/lib/modelLinks";
import { builtOn, isLiveRow, rowId } from "~/lib/teardown";
import { bytes } from "~/lib/time";
import type { Entry } from "./entries";

export type DeleteItem = {
    id: string;
    name: string;
    publisher: string | null;
    detail: string;
    live: boolean;
};

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function uniqueRows(rows: ModelRow[]): ModelRow[] {
    return [...new Map(rows.map((row) => [rowId(row), row])).values()];
}

function baseName(rows: ModelRow[], key: string | null | undefined): string {
    return rows.find((row) => row.kind === "base" && row.key === key)?.name ?? key ?? "its base";
}

export function rowItem(row: ModelRow, rows: ModelRow[], detail?: string): DeleteItem {
    const versions = row.versions?.length ?? 0;
    return {
        id: rowId(row),
        name: row.name,
        publisher: row.kind === "base" ? (row.publisher ?? null) : null,
        detail:
            detail ??
            (row.kind === "base"
                ? `Base model${row.size_bytes ? ` · ${bytes(row.size_bytes)}` : ""}`
                : `${versions ? `${plural(versions, "version")} · ` : ""}On ${baseName(rows, row.base_model)}`),
        live: isLiveRow(row),
    };
}

function entryItem(entry: Entry, rows: ModelRow[]): DeleteItem {
    const { model, version } = entry;
    if (!version) {
        return rowItem(model, rows);
    }
    return {
        id: entry.key,
        name: `${model.name} v${version.number}`,
        publisher: null,
        detail: "This version only; the model stays",
        live: version.live,
    };
}

function rowOwns(row: ModelRow, job: JobInfo): boolean {
    return row.kind === "base" ? job.base_model === row.key : job.model === row.key;
}

function entryOwns(entry: Entry, job: JobInfo): boolean {
    const { model, version } = entry;
    return version
        ? job.model === model.key && job.version === version.number
        : rowOwns(model, job);
}

function targetJobs(jobs: JobInfo[], picked: Entry[], dependents: ModelRow[]): JobInfo[] {
    return jobs.filter(
        (job) =>
            !job.cancel_requested &&
            (picked.some((entry) => entryOwns(entry, job)) ||
                dependents.some((row) => rowOwns(row, job))),
    );
}

export function jobName(job: JobInfo): string {
    const owner = job.model_name ?? job.model ?? job.base_model ?? `Job #${job.id}`;
    const version = job.version === null || job.version === undefined ? "" : ` v${job.version}`;
    return `${owner}${version}`;
}

export function JobList({ jobs }: { jobs: JobInfo[] }) {
    return (
        <ul className="flex max-h-48 flex-col divide-y overflow-y-auto rounded-lg border">
            {jobs.map((job) => (
                <li key={job.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="flex min-w-0 flex-1 flex-col">
                        <Link
                            href={jobHref(job)}
                            className="truncate font-medium text-primary hover:underline"
                        >
                            {jobName(job)}
                        </Link>
                        <span className="truncate text-sm text-muted-foreground tabular-nums">
                            {`${kindName(job.kind)} · Job #${job.id}`}
                        </span>
                    </span>
                    <JobStatus job={job} />
                </li>
            ))}
        </ul>
    );
}

function cancelLabel(count: number): string {
    return count === 1 ? "Cancel this job first" : `Cancel these ${count} jobs first`;
}

export function DeleteList({ items }: { items: DeleteItem[] }) {
    return (
        <ul className="flex max-h-64 flex-col divide-y overflow-y-auto rounded-lg border">
            {items.map((item) => (
                <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                    <PublisherLogo publisher={item.publisher} name={item.name} />
                    <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{item.name}</span>
                        <span className="truncate text-sm text-muted-foreground">
                            {item.detail}
                        </span>
                    </span>
                    {item.live && <StatusText tone="warning">Live</StatusText>}
                </li>
            ))}
        </ul>
    );
}

export function DeleteModelsDialog({
    chosen,
    rows,
    onOpenChange,
    onDelete,
}: {
    chosen: Entry[] | null;
    rows: ModelRow[];
    onOpenChange: (open: boolean) => void;
    onDelete: (cascade: boolean, cancelJobs: boolean) => Promise<unknown>;
}) {
    const [cascade, setCascade] = useState(false);
    const [undeploy, setUndeploy] = useState(false);
    const [cancelJobs, setCancelJobs] = useState(true);
    const active = useActiveJobs(chosen !== null);
    useEffect(() => {
        if (chosen) {
            setCascade(false);
            setUndeploy(false);
            setCancelJobs(true);
        }
    }, [chosen]);
    const picked = chosen ?? [];
    const whole = new Set(
        picked.filter((entry) => !entry.version).map((entry) => rowId(entry.model)),
    );
    const bases = uniqueRows(
        picked
            .filter((entry) => !entry.version && entry.model.kind === "base")
            .map((entry) => entry.model),
    );
    const orphans = uniqueRows(bases.flatMap((base) => builtOn(rows, base))).filter(
        (row) => !whole.has(rowId(row)),
    );
    const owners = bases.filter((base) => orphans.some((row) => row.base_model === base.key));
    const items = picked.map((entry) => entryItem(entry, rows));
    const dependents = orphans.map((row) =>
        rowItem(row, rows, `Built on ${baseName(rows, row.base_model)}`),
    );
    const live = [...items, ...(cascade ? dependents : [])].filter((item) => item.live).length;
    const versions = picked.filter((entry) => entry.version).length;
    const models = picked.length - versions + (cascade ? orphans.length : 0);
    const freed = bases
        .filter((base) => base.availability.state === "available")
        .reduce((sum, base) => sum + (base.size_bytes ?? 0), 0);
    const parts = [
        models ? plural(models, "model") : "",
        versions ? plural(versions, "version") : "",
    ]
        .filter(Boolean)
        .join(" and ");
    const jobs = targetJobs(active.data ?? [], picked, cascade ? orphans : []);
    const needsCascade = orphans.length > 0 && !cascade;
    const needsUndeploy = live > 0 && !undeploy;
    const needsCancel = jobs.length > 0 && !cancelJobs;
    const cancelling = jobs.length > 0 && cancelJobs;
    const start = useMutation({
        mutationFn: () => onDelete(cascade, cancelling),
        onSuccess: () => onOpenChange(false),
    });
    return (
        <Dialog open={chosen !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{`Delete ${parts}?`}</DialogTitle>
                    <DialogDescription>
                        {models
                            ? "Models go with all their versions, data links, scores and API keys. "
                            : ""}
                        {versions ? "Versions go with their adapters, scores and results. " : ""}
                        Their jobs and request logs stay as history. This cannot be undone.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-2">
                    <DeleteList items={items} />
                    {freed > 0 && (
                        <span className="text-sm text-muted-foreground tabular-nums">
                            {`Frees ${bytes(freed)} on disk.`}
                        </span>
                    )}
                </div>
                {orphans.length > 0 && (
                    <div className="flex flex-col gap-3 rounded-lg border p-3">
                        <Label className="flex items-start gap-2 font-normal">
                            <Checkbox
                                checked={cascade}
                                onCheckedChange={(value) => setCascade(value === true)}
                                className="mt-0.5"
                            />
                            <span className="flex flex-col gap-0.5">
                                <span className="font-medium">
                                    {`Also delete the ${plural(orphans.length, "model")} built on ${owners.map((base) => base.name).join(", ")}`}
                                </span>
                                <span className="text-sm text-muted-foreground">
                                    A base model can't go while models are built on it. Deselect it
                                    to keep them.
                                </span>
                            </span>
                        </Label>
                        <DeleteList items={dependents} />
                    </div>
                )}
                {live > 0 && (
                    <Label className="flex items-start gap-2 font-normal">
                        <Checkbox
                            checked={undeploy}
                            onCheckedChange={(value) => setUndeploy(value === true)}
                            className="mt-0.5"
                        />
                        <span className="flex flex-col gap-0.5">
                            <span className="font-medium">
                                {`Undeploy ${plural(live, "live model")} first`}
                            </span>
                            <span className="text-sm text-muted-foreground">
                                Apps calling {live === 1 ? "it" : "them"} get errors from then on.
                            </span>
                        </span>
                    </Label>
                )}
                {jobs.length > 0 && (
                    <div className="flex flex-col gap-3 rounded-lg border p-3">
                        <Label className="flex items-start gap-2 font-normal">
                            <Checkbox
                                checked={cancelJobs}
                                onCheckedChange={(value) => setCancelJobs(value === true)}
                                className="mt-0.5"
                            />
                            <span className="flex flex-col gap-0.5">
                                <span className="font-medium">{cancelLabel(jobs.length)}</span>
                                <span className="text-sm text-muted-foreground">
                                    {cancelJobs
                                        ? "Their work so far is lost. Deleting starts once they have stopped."
                                        : "Cancel the running jobs to delete."}
                                </span>
                            </span>
                        </Label>
                        <JobList jobs={jobs} />
                    </div>
                )}
                <ErrorLine error={start.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        disabled={
                            needsCascade ||
                            needsUndeploy ||
                            needsCancel ||
                            active.isPending ||
                            start.isPending
                        }
                        onClick={() => start.mutate()}
                    >
                        {start.isPending
                            ? cancelling
                                ? `Cancelling ${plural(jobs.length, "job")}…`
                                : "Deleting…"
                            : `${live > 0 ? "Undeploy and delete" : "Delete"} ${parts}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
