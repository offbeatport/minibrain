import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
    Button,
    DataGrid,
    SegmentedTabs,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    TabNav,
    type TabNavItem,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { useState } from "react";
import { type JobInfo, api, unwrap } from "~/api/client";
import { type JobOrder, useJobFacets, useJobList } from "~/api/jobQueries";
import { isActiveJob } from "~/api/queries";
import { JobToolbar, canCancel, canRetry, useJobSelection } from "~/components/JobSelection";
import { ModelName } from "~/components/ModelName";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page } from "~/components/Section";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import { useCan } from "~/lib/access";
import { jobDuration, jobSeconds } from "~/lib/jobs";
import { jobHref } from "~/lib/modelLinks";
import { JOBS_PATH, OVERVIEW_PATH, REQUESTS_PATH } from "~/lib/requests";
import { exactTime, relativeTime } from "~/lib/time";
import { OverviewTab } from "./monitor/OverviewTab";
import { LiveControl, RequestsTab } from "./monitor/RequestsTab";

const ALL = "all";

const TABS: TabNavItem[] = [
    { label: "Overview", href: OVERVIEW_PATH },
    { label: "Jobs", href: JOBS_PATH },
    { label: "Requests", href: REQUESTS_PATH },
];

const CAPTIONS: Record<string, string> = {
    [OVERVIEW_PATH]: "Traffic on the /v1 API by model: request rate, errors, latency and tokens.",
    [JOBS_PATH]:
        "Background jobs across every model: data builds, training, scoring and downloads.",
    [REQUESTS_PATH]: "Calls to the /v1 API as they arrive: model, key, status, latency and tokens.",
};

const STATES: { key: string; label: string }[] = [
    { key: ALL, label: "All" },
    { key: "running", label: "Running" },
    { key: "queued", label: "Queued" },
    { key: "failed", label: "Failed" },
    { key: "succeeded", label: "Succeeded" },
    { key: "cancelled", label: "Cancelled" },
];

const KINDS: Record<string, string> = {
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

function subject(job: JobInfo): string {
    const name = job.model_name ?? job.base_model ?? "Install";
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
    const can = useCan();
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
            {can.build && canCancel(job) && (
                <Button
                    variant="outline"
                    disabled={act.isPending}
                    onClick={() => act.mutate("cancel")}
                >
                    Cancel
                </Button>
            )}
            {can.build && canRetry(job) && (
                <Button
                    variant="outline"
                    disabled={act.isPending}
                    onClick={() => act.mutate("retry")}
                >
                    Retry
                </Button>
            )}
        </div>
    );
}

const ALL_COLUMNS: ColumnDef<JobInfo, unknown>[] = [
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
    {
        id: "subject",
        header: "For",
        accessorFn: subject,
        cell: ({ row }) => (
            <ModelName name={subject(row.original)} deleted={row.original.deleted} />
        ),
    },
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
        accessorFn: jobSeconds,
        cell: ({ row }) => <span className="tabular-nums">{jobDuration(row.original)}</span>,
    },
    {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        enableHiding: false,
        cell: ({ row }) => <JobActions job={row.original} />,
    },
];

const COLUMNS = ALL_COLUMNS.map((column) => ({ ...column, enableSorting: column.id === "id" }));

function sortingFor(order: JobOrder): SortingState {
    return [{ id: "id", desc: order === "newest" }];
}

function JobsTab() {
    const router = useRouter();
    const [state, setState] = useState(ALL);
    const [kind, setKind] = useState(ALL);
    const [order, setOrder] = useState<JobOrder>("newest");
    const filter = {
        kind: kind === ALL ? [] : [kind],
        status: state === ALL ? [] : [state],
        order,
    };
    const jobs = useJobList(filter);
    const facets = useJobFacets(filter, jobs.rows.some(isActiveJob));
    const selection = useJobSelection(jobs.rows, `${state}\n${kind}`);
    const counts = facets.data?.statuses ?? {};
    const tabs = STATES.map((item) => ({
        ...item,
        badge:
            item.key === ALL
                ? Object.values(counts).reduce((sum, value) => sum + value, 0)
                : (counts[item.key] ?? 0),
    }));
    return (
        <>
            <JobToolbar selection={selection}>
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
            </JobToolbar>
            <ErrorLine error={jobs.error} />
            <DataGrid
                columns={COLUMNS}
                rows={jobs.rows}
                getRowId={(job) => String(job.id)}
                loading={jobs.isLoading}
                storageKey="minibrain.jobs.columns"
                columnPicker
                hiddenColumns={["id", "attempt"]}
                sorting={sortingFor(order)}
                onSortingChange={(next) => setOrder(next[0]?.desc === false ? "oldest" : "newest")}
                hasMore={jobs.hasMore}
                loadingMore={jobs.loadingMore}
                onLoadMore={jobs.loadMore}
                total={jobs.total}
                onOpen={(job) => {
                    const href = jobHref(job);
                    if (href) {
                        router.history.push(href);
                    }
                }}
                rowLabel={(job) => `${KINDS[job.kind] ?? job.kind} job ${job.id}, ${job.status}`}
                {...selection.grid}
                empty={<p className="text-muted-foreground">No jobs match.</p>}
                minWidth="min-w-[760px]"
            />
        </>
    );
}

function tabOf(pathname: string): string {
    const trimmed = pathname.replace(/\/+$/, "") || OVERVIEW_PATH;
    return trimmed in CAPTIONS ? trimmed : OVERVIEW_PATH;
}

export function MonitorPage() {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const tab = tabOf(pathname);
    const [paused, setPaused] = useState(false);
    return (
        <Page wide>
            <PageHeader
                title="Monitor"
                caption={CAPTIONS[tab]}
                actions={
                    tab === JOBS_PATH ? undefined : (
                        <LiveControl
                            paused={paused}
                            onToggle={() => setPaused((value) => !value)}
                        />
                    )
                }
            />
            <TabNav label="Monitor pages" tabs={TABS} />
            {tab === OVERVIEW_PATH && <OverviewTab paused={paused} />}
            {tab === JOBS_PATH && <JobsTab />}
            {tab === REQUESTS_PATH && <RequestsTab paused={paused} />}
        </Page>
    );
}
