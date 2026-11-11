import { useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { History } from "lucide-react";
import { Button, CheckboxSelect, DataGrid, SearchInput, Tabs, TabsList, TabsTrigger } from "obp-ui";
import { useState } from "react";
import type { JobInfo } from "~/api/client";
import { type JobOrder, useJobFacets, useJobList } from "~/api/jobQueries";
import { isActiveJob } from "~/api/queries";
import { JobToolbar, useJobSelection } from "~/components/JobSelection";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, PanelSection, PanelSections } from "~/components/Section";
import { JOB_STATUSES, jobStatusLabel } from "~/components/StatusBadge";
import { JOB_KINDS, kindGroup } from "~/lib/jobs";
import { splitList, useListSearch } from "~/lib/listSearch";
import { JOBS_PATH, jobHref } from "~/lib/modelLinks";
import {
    ATTEMPT_COLUMN,
    DURATION_COLUMN,
    ID_COLUMN,
    OWNER_COLUMN,
    STARTED_COLUMN,
    STATUS_COLUMN,
    jobName,
    jobRowLabel,
    orderFrom,
    sortedById,
    sortingFor,
} from "./jobCells";

const KEYS = ["kind", "status", "q"] as const;
const ALL = "all";

const COLUMNS: ColumnDef<JobInfo, unknown>[] = sortedById([
    ID_COLUMN,
    {
        id: "kind",
        header: "Kind",
        accessorFn: jobName,
        cell: ({ row }) => <span className="tabular-nums">{jobName(row.original)}</span>,
    },
    OWNER_COLUMN,
    STATUS_COLUMN,
    STARTED_COLUMN,
    { ...DURATION_COLUMN, header: "Took" },
    ATTEMPT_COLUMN,
]);

function KindTabs({
    value,
    counts,
    onChange,
}: {
    value: string;
    counts: Record<string, number>;
    onChange: (kind: string) => void;
}) {
    const shown = JOB_KINDS.filter((kind) => (counts[kind] ?? 0) > 0 || kind === value);
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    const tabs = [
        { key: ALL, label: "All", count: total },
        ...shown.map((kind) => ({ key: kind, label: kindGroup(kind), count: counts[kind] ?? 0 })),
    ];
    return (
        <Tabs value={value} onValueChange={(next) => onChange(String(next))}>
            <TabsList aria-label="Job kind">
                {tabs.map((tab) => (
                    <TabsTrigger key={tab.key} value={tab.key}>
                        {tab.label}
                        <span className="text-sm tabular-nums text-muted-foreground">
                            {tab.count.toLocaleString()}
                        </span>
                    </TabsTrigger>
                ))}
            </TabsList>
        </Tabs>
    );
}

function Queue() {
    const { search, update } = useListSearch(JOBS_PATH, KEYS);
    const router = useRouter();
    const [order, setOrder] = useState<JobOrder>("newest");
    const kind = search.kind && JOB_KINDS.includes(search.kind) ? search.kind : ALL;
    const statuses = splitList(search.status);
    const filter = {
        kind: kind === ALL ? [] : [kind],
        status: statuses,
        q: search.q,
        order,
    };
    const jobs = useJobList(filter);
    const facets = useJobFacets(filter, jobs.rows.some(isActiveJob));
    const filtering = statuses.length > 0 || Boolean(search.q);
    const selection = useJobSelection(jobs.rows, [kind, search.status, search.q].join("\n"));
    const statusOptions = JOB_STATUSES.map((status) => ({
        value: status,
        label: jobStatusLabel(status),
        count: facets.data?.statuses[status] ?? 0,
    }));
    const clear = () => update({ status: "", q: "" });
    return (
        <div className="flex flex-col gap-3">
            <KindTabs
                value={kind}
                counts={facets.data?.kinds ?? {}}
                onChange={(next) => update({ kind: next === ALL ? "" : next })}
            />
            <JobToolbar selection={selection}>
                <SearchInput
                    aria-label="Search jobs"
                    placeholder="Search by model or job ID"
                    value={search.q ?? ""}
                    onValueChange={(q) => update({ q })}
                    className="w-full min-w-48 max-w-xs flex-1"
                />
                <CheckboxSelect
                    label="Status"
                    allLabel="Any status"
                    noun="statuses"
                    options={statusOptions}
                    value={statuses}
                    onValueChange={(next) => update({ status: next.join(",") })}
                />
                {filtering && (
                    <Button variant="ghost" onClick={clear}>
                        Clear filters
                    </Button>
                )}
            </JobToolbar>
            <ErrorLine error={jobs.error} />
            <DataGrid
                columns={COLUMNS}
                rows={jobs.rows}
                getRowId={(job) => String(job.id)}
                loading={jobs.isLoading}
                storageKey="minibrain.jobs.queue"
                columnPicker
                hiddenColumns={["attempt"]}
                sorting={sortingFor(order)}
                onSortingChange={(next) => setOrder(orderFrom(next))}
                hasMore={jobs.hasMore}
                loadingMore={jobs.loadingMore}
                onLoadMore={jobs.loadMore}
                total={jobs.total}
                onOpen={(job) => router.history.push(jobHref(job))}
                {...selection.grid}
                rowLabel={jobRowLabel}
                empty={
                    filtering ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-muted-foreground">No jobs match these filters.</p>
                            <Button variant="outline" onClick={clear}>
                                Clear filters
                            </Button>
                        </div>
                    ) : (
                        <p className="text-muted-foreground">No jobs yet.</p>
                    )
                }
                minWidth="min-w-[760px]"
            />
        </div>
    );
}

export function JobsPage() {
    return (
        <Page wide>
            <PageHeader
                title="Jobs"
                caption="Every job on this install: training, scoring, judging, downloads and imports."
            />
            <PanelSections>
                <PanelSection
                    icon={History}
                    title="Queue and history"
                    description="Open a job for its progress, settings and logs."
                    bare
                >
                    <Queue />
                </PanelSection>
            </PanelSections>
        </Page>
    );
}
