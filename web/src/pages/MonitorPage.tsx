import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import {
    Button,
    DataGrid,
    SegmentedTabs,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { useState } from "react";
import { type JobInfo, api, unwrap } from "~/api/client";
import { isActiveJob } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page } from "~/components/Section";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import { exactTime, relativeTime } from "~/lib/time";

const JOBS = ["jobs", "all"] as const;
const ALL = "all";

const STATES: { key: string; label: string }[] = [
    { key: ALL, label: "All" },
    { key: "running", label: "Running" },
    { key: "queued", label: "Queued" },
    { key: "failed", label: "Failed" },
    { key: "succeeded", label: "Succeeded" },
    { key: "cancelled", label: "Cancelled" },
];

const KINDS: Record<string, string> = {
    prepare: "Data build",
    train: "Training",
    eval: "Scoring",
    download: "Download",
    import: "Import",
    catalog_sync: "Catalogue sync",
};

const TONES: Record<string, Tone> = {
    running: "info",
    queued: "neutral",
    failed: "destructive",
    succeeded: "success",
    cancelled: "neutral",
};

function duration(job: JobInfo): string {
    if (!job.started_at) {
        return "—";
    }
    const end = job.finished_at ? new Date(job.finished_at) : new Date();
    const seconds = Math.max(
        0,
        Math.round((end.getTime() - new Date(job.started_at).getTime()) / 1000),
    );
    if (seconds < 60) {
        return `${seconds} s`;
    }
    const minutes = Math.round(seconds / 60);
    return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

function subject(job: JobInfo): string {
    const name = job.minibrain_name ?? job.model ?? "Install";
    return job.version === null || job.version === undefined ? name : `${name} · v${job.version}`;
}

function JobStatus({ job }: { job: JobInfo }) {
    const label = job.status[0].toUpperCase() + job.status.slice(1);
    if (job.status === "failed" && job.error) {
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <button type="button" className="rounded-sm text-left">
                        <StatusText tone="destructive">{label}</StatusText>
                    </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm whitespace-normal">{job.error}</TooltipContent>
            </Tooltip>
        );
    }
    if (job.status === "running") {
        return (
            <div className="flex items-center gap-2">
                <StatusText tone="info">
                    {label}
                    {job.progress > 0 && (
                        <span className="tabular-nums">{` · ${Math.round(job.progress * 100)}%`}</span>
                    )}
                </StatusText>
                <ProgressBar
                    value={job.progress > 0 ? job.progress : null}
                    label={`Job ${job.id}`}
                />
            </div>
        );
    }
    return <StatusText tone={TONES[job.status] ?? "neutral"}>{label}</StatusText>;
}

function JobActions({ job }: { job: JobInfo }) {
    const client = useQueryClient();
    const act = useMutation({
        mutationFn: (action: "cancel" | "retry") =>
            action === "cancel"
                ? unwrap(
                      api.POST("/api/jobs/{job_id}/cancel", {
                          params: { path: { job_id: job.id } },
                      }),
                  )
                : unwrap(
                      api.POST("/api/jobs/{job_id}/retry", {
                          params: { path: { job_id: job.id } },
                      }),
                  ),
        onSuccess: () => client.invalidateQueries(),
    });
    return (
        <div className="flex items-center justify-end gap-1">
            {isActiveJob(job) && !job.cancel_requested && (
                <Button
                    variant="outline"
                    size="xs"
                    disabled={act.isPending}
                    onClick={() => act.mutate("cancel")}
                >
                    Cancel
                </Button>
            )}
            {job.status === "failed" && (
                <Button
                    variant="outline"
                    size="xs"
                    disabled={act.isPending}
                    onClick={() => act.mutate("retry")}
                >
                    Retry
                </Button>
            )}
        </div>
    );
}

const COLUMNS: ColumnDef<JobInfo, unknown>[] = [
    {
        id: "job",
        header: "Job",
        enableHiding: false,
        accessorFn: (job) => KINDS[job.kind] ?? job.kind,
    },
    {
        id: "id",
        header: "ID",
        accessorFn: (job) => job.id,
        cell: ({ row }) => (
            <span className="font-mono text-muted-foreground">{`#${row.original.id}`}</span>
        ),
    },
    { id: "subject", header: "For", accessorFn: subject },
    {
        id: "status",
        header: "Status",
        accessorFn: (job) => job.status,
        cell: ({ row }) => <JobStatus job={row.original} />,
    },
    {
        id: "attempt",
        header: "Attempt",
        accessorFn: (job) => job.attempt,
        cell: ({ row }) => (
            <span className="tabular-nums">{`${Math.max(1, row.original.attempt)} of ${row.original.max_attempts}`}</span>
        ),
    },
    {
        id: "created",
        header: "Started",
        accessorFn: (job) => job.started_at ?? job.created_at,
        cell: ({ row }) => {
            const moment = row.original.started_at ?? row.original.created_at;
            return (
                <span className="tabular-nums" title={exactTime(moment)}>
                    {relativeTime(moment)}
                </span>
            );
        },
    },
    {
        id: "duration",
        header: "Took",
        accessorFn: duration,
        cell: ({ row }) => <span className="tabular-nums">{duration(row.original)}</span>,
    },
    {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        enableHiding: false,
        cell: ({ row }) => <JobActions job={row.original} />,
    },
];

function jobHref(job: JobInfo): string | null {
    if (job.minibrain) {
        const page =
            job.kind === "prepare" ? "/data" : job.kind === "eval" ? "/evaluations" : "/training";
        return `${page}?minibrain=${encodeURIComponent(job.minibrain)}`;
    }
    return job.model ? `/models/base/${encodeURIComponent(job.model)}` : null;
}

export function MonitorPage() {
    const router = useRouter();
    const [state, setState] = useState(ALL);
    const [kind, setKind] = useState(ALL);
    const jobs = useQuery({
        queryKey: JOBS,
        queryFn: () => unwrap(api.GET("/api/jobs", { params: { query: { limit: 500 } } })),
        refetchInterval: (query) => (query.state.data?.some(isActiveJob) ? 3000 : 15000),
    });
    const all = jobs.data ?? [];
    const ofKind = all.filter((job) => kind === ALL || job.kind === kind);
    const visible = ofKind.filter((job) => state === ALL || job.status === state);
    const tabs = STATES.map((item) => ({
        ...item,
        badge:
            item.key === ALL
                ? ofKind.length
                : ofKind.filter((job) => job.status === item.key).length,
    }));
    return (
        <Page wide>
            <PageHeader
                title="Monitor"
                caption="Background jobs across every model: data builds, training, scoring and downloads."
            />
            <div className="flex flex-wrap items-center gap-2">
                <SegmentedTabs tabs={tabs} active={state} onSelect={setState} />
                <Select value={kind} onValueChange={(next) => setKind(String(next))}>
                    <SelectTrigger aria-label="Job kind" className="w-auto min-w-44">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ALL}>Kind: All</SelectItem>
                        {Object.entries(KINDS).map(([key, label]) => (
                            <SelectItem key={key} value={key}>
                                {`Kind: ${label}`}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <ErrorLine error={jobs.error} />
            {jobs.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading jobs…</p>
            ) : (
                <DataGrid
                    columns={COLUMNS}
                    rows={visible}
                    storageKey="minibrain.jobs.columns"
                    columnPicker
                    onOpen={(job) => {
                        const href = jobHref(job);
                        if (href) {
                            router.history.push(href);
                        }
                    }}
                    rowLabel={(job) =>
                        `${KINDS[job.kind] ?? job.kind} job ${job.id}, ${job.status}`
                    }
                    empty={<p className="text-muted-foreground">No jobs match.</p>}
                    minWidth="min-w-[760px]"
                />
            )}
        </Page>
    );
}
