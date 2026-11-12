import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { Link, Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import type { JobInfo } from "~/api/client";
import type { JobOrder } from "~/api/jobQueries";
import { ModelName, withDeleted } from "~/components/ModelName";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import { percent } from "~/lib/format";
import { jobDuration, jobSeconds, kindNoun } from "~/lib/jobs";
import { jobHref } from "~/lib/modelLinks";
import { exactTime, relativeTime } from "~/lib/time";

type JobColumn = ColumnDef<JobInfo, unknown>;

const STATES: Record<string, { tone: Tone; label: string }> = {
    queued: { tone: "neutral", label: "Queued" },
    running: { tone: "info", label: "Running" },
    succeeded: { tone: "success", label: "Done" },
    failed: { tone: "destructive", label: "Failed" },
    cancelled: { tone: "neutral", label: "Cancelled" },
};

const METHODS: Record<string, string> = { sft: "SFT" };
const STRATEGIES: Record<string, string> = { lora: "LoRA", qlora: "QLoRA" };

export function jobState(job: JobInfo): { tone: Tone; label: string } {
    if (job.delete_requested) {
        return { tone: "warning", label: "Deleting" };
    }
    if (job.status === "running" && job.cancel_requested) {
        return { tone: "warning", label: "Cancelling" };
    }
    if (job.status === "queued" && job.attempt > 0) {
        return { tone: "warning", label: "Retrying" };
    }
    return STATES[job.status] ?? { tone: "neutral", label: job.status };
}

export function ownerName(job: JobInfo): string {
    return job.model_name ?? job.base_model_name ?? job.model ?? job.base_model ?? "This install";
}

export function jobName(job: JobInfo): string {
    const name = kindNoun(job.kind);
    return job.version === null || job.version === undefined ? name : `${name} v${job.version}`;
}

export function jobRowLabel(job: JobInfo): string {
    return `Job ${job.id}, ${jobName(job)}, ${withDeleted(ownerName(job), job.deleted)}, ${jobState(job).label}`;
}

export function methodText(job: JobInfo): string {
    const method = job.method ? (METHODS[job.method] ?? job.method) : "–";
    const adapter = job.strategy ? (STRATEGIES[job.strategy] ?? job.strategy) : null;
    if (!adapter) {
        return method;
    }
    return job.rank ? `${method} · ${adapter} r${job.rank}` : `${method} · ${adapter}`;
}

export function JobState({ job }: { job: JobInfo }) {
    const state = jobState(job);
    const running = job.status === "running";
    const text = (
        <StatusText tone={state.tone}>
            {state.label}
            {running && job.progress > 0 && (
                <span className="tabular-nums">{` · ${Math.round(job.progress * 100)}%`}</span>
            )}
        </StatusText>
    );
    if (job.status === "failed" && job.error) {
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <button type="button" className="flex items-center rounded-sm text-left">
                        {text}
                    </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm whitespace-normal">{job.error}</TooltipContent>
            </Tooltip>
        );
    }
    if (!running) {
        return <span className="flex items-center">{text}</span>;
    }
    return (
        <span className="flex items-center gap-2">
            {text}
            <ProgressBar
                value={job.progress > 0 ? job.progress : null}
                label={`Job ${job.id} progress`}
                className="w-16"
            />
        </span>
    );
}

export function JobOwner({ job }: { job: JobInfo }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <PublisherLogo publisher={job.publisher} name={ownerName(job)} size="sm" />
            <ModelName name={ownerName(job)} deleted={job.deleted} className="truncate" />
        </span>
    );
}

function When({ value }: { value: string }) {
    return (
        <time dateTime={value} title={exactTime(value)} className="tabular-nums">
            {relativeTime(value)}
        </time>
    );
}

export const ID_COLUMN: JobColumn = {
    id: "id",
    header: "Job",
    enableHiding: false,
    accessorFn: (job) => job.id,
    cell: ({ row }) => (
        <Link
            href={jobHref(row.original)}
            className="font-mono text-sm text-foreground hover:underline"
        >
            {`#${row.original.id}`}
        </Link>
    ),
};

export const OWNER_COLUMN: JobColumn = {
    id: "model",
    header: "Model",
    accessorFn: (job) => ownerName(job).toLowerCase(),
    cell: ({ row }) => <JobOwner job={row.original} />,
};

export const STATUS_COLUMN: JobColumn = {
    id: "status",
    header: "Status",
    accessorFn: (job) => job.status,
    cell: ({ row }) => <JobState job={row.original} />,
};

export const STARTED_COLUMN: JobColumn = {
    id: "started",
    header: "Started",
    accessorFn: (job) => job.started_at ?? job.created_at,
    cell: ({ row }) =>
        row.original.started_at ? (
            <When value={row.original.started_at} />
        ) : (
            <span className="text-muted-foreground">Not yet</span>
        ),
};

export const DURATION_COLUMN: JobColumn = {
    id: "duration",
    header: "Duration",
    accessorFn: jobSeconds,
    cell: ({ row }) => <span className="tabular-nums">{jobDuration(row.original)}</span>,
};

export const ATTEMPT_COLUMN: JobColumn = {
    id: "attempt",
    header: "Attempt",
    accessorFn: (job) => job.attempt,
    cell: ({ row }) => (
        <span className="tabular-nums">{`${Math.max(1, row.original.attempt)} of ${row.original.max_attempts}`}</span>
    ),
};

export const SCORE_COLUMN: JobColumn = {
    id: "score",
    header: "Score",
    accessorFn: (job) => job.score ?? -1,
    cell: ({ row }) => <span className="tabular-nums">{percent(row.original.score)}</span>,
};

export function sortedById(columns: JobColumn[]): JobColumn[] {
    return columns.map((column) => ({ ...column, enableSorting: column.id === "id" }));
}

export function sortingFor(order: JobOrder): SortingState {
    return [{ id: "id", desc: order === "newest" }];
}

export function orderFrom(sorting: SortingState): JobOrder {
    return sorting[0]?.desc === false ? "oldest" : "newest";
}
