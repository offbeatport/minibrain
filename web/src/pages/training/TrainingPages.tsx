import { useParams, useRouter } from "@tanstack/react-router";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronLeft } from "lucide-react";
import {
    Button,
    CheckboxSelect,
    DataGrid,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Link,
    SearchInput,
    SearchList,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { useMemo, useState } from "react";
import type { JobInfo, MinibrainSummary } from "~/api/client";
import { type JobOrder, SINCE_CHOICES, useJobFacets, useJobList } from "~/api/jobQueries";
import { isActiveJob, useJob, useMinibrains } from "~/api/queries";
import { JobPanel } from "~/components/JobPanel";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page } from "~/components/Section";
import { JOB_STATUSES, JobStatus, jobStatusLabel } from "~/components/StatusBadge";
import { ProgressBar } from "~/components/models/StatusText";
import { jobDuration, jobSeconds } from "~/lib/jobs";
import { listHref, splitList, useListSearch } from "~/lib/listSearch";
import { evaluationsHref, trainingHref } from "~/lib/modelLinks";
import { relativeTime } from "~/lib/time";
import { Training } from "../TrainingPage";
import { Updated } from "../models/MyModels";

const PATH = "/training";
const KEYS = ["model", "status", "job", "q", "since"] as const;
const TRAINING_KINDS = ["train", "eval"];
const ANY_TIME = "any";

const KIND_NAMES: Record<string, string> = {
    train: "Training",
    eval: "Scoring",
    prepare: "Data build",
};

function kindName(job: JobInfo): string {
    return KIND_NAMES[job.kind] ?? job.kind;
}

function jobName(job: JobInfo): string {
    return job.version === null ? kindName(job) : `${kindName(job)} v${job.version}`;
}

function Status({ job }: { job: JobInfo }) {
    if (job.status !== "failed" || !job.error) {
        return <JobStatus job={job} />;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="rounded-sm">
                    <JobStatus job={job} />
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-normal">{job.error}</TooltipContent>
        </Tooltip>
    );
}

function Progress({ job }: { job: JobInfo }) {
    const share = `${Math.round(job.progress * 100)}%`;
    if (job.status === "queued") {
        return <span className="text-muted-foreground">Waiting</span>;
    }
    if (job.status !== "running") {
        return <span className="tabular-nums text-muted-foreground">{share}</span>;
    }
    return (
        <span className="flex items-center gap-2">
            <ProgressBar
                value={job.progress > 0 ? job.progress : null}
                label={`${jobName(job)} progress`}
                className="w-20"
            />
            <span className="tabular-nums">{share}</span>
        </span>
    );
}

function jobColumns(href: (job: JobInfo) => string): ColumnDef<JobInfo, unknown>[] {
    const columns: ColumnDef<JobInfo, unknown>[] = [
        {
            id: "model",
            header: "Model",
            enableHiding: false,
            accessorFn: (job) => (job.minibrain_name ?? "").toLowerCase(),
            cell: ({ row }) => (
                <Link
                    href={href(row.original)}
                    className="block truncate font-semibold text-foreground"
                >
                    {row.original.minibrain_name ?? "Deleted model"}
                </Link>
            ),
        },
        {
            id: "version",
            header: "Version",
            accessorFn: (job) => job.version ?? -1,
            cell: ({ row }) => (
                <span className="tabular-nums">
                    {row.original.version === null ? "–" : `v${row.original.version}`}
                </span>
            ),
        },
        { id: "kind", header: "Job", accessorFn: kindName },
        {
            id: "status",
            header: "Status",
            accessorFn: (job) => job.status,
            cell: ({ row }) => <Status job={row.original} />,
        },
        {
            id: "progress",
            header: "Progress",
            accessorFn: (job) => job.progress,
            cell: ({ row }) => <Progress job={row.original} />,
        },
        {
            id: "started",
            header: "Started",
            accessorFn: (job) => job.started_at ?? "",
            cell: ({ row }) =>
                row.original.started_at ? (
                    <Updated value={row.original.started_at} />
                ) : (
                    <span className="text-muted-foreground">Not yet</span>
                ),
        },
        {
            id: "duration",
            header: "Duration",
            accessorFn: jobSeconds,
            cell: ({ row }) => <span className="tabular-nums">{jobDuration(row.original)}</span>,
        },
        {
            id: "id",
            header: "Job ID",
            accessorFn: (job) => job.id,
            cell: ({ row }) => (
                <span className="font-mono text-muted-foreground">{`#${row.original.id}`}</span>
            ),
        },
        {
            id: "attempt",
            header: "Attempt",
            accessorFn: (job) => job.attempt,
            cell: ({ row }) => (
                <span className="tabular-nums">{`${Math.max(1, row.original.attempt)} of ${row.original.max_attempts}`}</span>
            ),
        },
    ];
    return columns.map((column) => ({ ...column, enableSorting: column.id === "id" }));
}

function sortingFor(order: JobOrder): SortingState {
    return [{ id: "id", desc: order === "newest" }];
}

function orderFrom(sorting: SortingState): JobOrder {
    return sorting[0]?.desc === false ? "oldest" : "newest";
}

function jobCaption(job: JobInfo): string {
    const started = job.started_at ? `started ${relativeTime(job.started_at)}` : "not started";
    const took = job.finished_at ? ` · took ${jobDuration(job)}` : "";
    return `Job #${job.id} · ${started}${took}`;
}

function JobDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
    const job = useJob(id);
    const data = job.data;
    return (
        <Dialog open={id !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>
                        {data ? `${data.minibrain_name ?? "Job"} · ${jobName(data)}` : `Job #${id}`}
                    </DialogTitle>
                    <DialogDescription>{data ? jobCaption(data) : "Loading…"}</DialogDescription>
                </DialogHeader>
                <ErrorLine error={job.error} />
                {data && (
                    <div className="min-w-0">
                        <JobPanel job={data} slug={data.minibrain ?? ""} />
                    </div>
                )}
                {data?.minibrain && (
                    <DialogFooter>
                        <Button variant="outline" asChild>
                            <Link href={trainingHref(data.minibrain)}>
                                {`Open ${data.minibrain_name ?? data.minibrain}`}
                            </Link>
                        </Button>
                    </DialogFooter>
                )}
            </DialogContent>
        </Dialog>
    );
}

function ModelChoice({ item }: { item: MinibrainSummary }) {
    return (
        <>
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-semibold">{item.name}</span>
                <span className="truncate text-muted-foreground">{item.base_model}</span>
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
                {item.versions === 0
                    ? "No versions"
                    : `${item.versions} ${item.versions === 1 ? "version" : "versions"}`}
            </span>
        </>
    );
}

function TrainPicker({
    open,
    onOpenChange,
}: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const router = useRouter();
    const minibrains = useMinibrains();
    const items = minibrains.data ?? [];
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Train a model</DialogTitle>
                    <DialogDescription>
                        Pick a custom model to add training data, score a prompt or train a version.
                    </DialogDescription>
                </DialogHeader>
                {minibrains.data && items.length === 0 ? (
                    <p className="text-base text-muted-foreground">
                        No custom models yet.{" "}
                        <Link href="/models/new" className="text-primary hover:underline">
                            Create one
                        </Link>
                    </p>
                ) : (
                    <SearchList
                        items={items}
                        itemKey={(item) => item.slug}
                        itemText={(item) => `${item.name} ${item.slug} ${item.base_model}`}
                        renderItem={(item) => <ModelChoice item={item} />}
                        onPick={(item) => {
                            onOpenChange(false);
                            router.history.push(trainingHref(item.slug));
                        }}
                        label="Search models"
                        placeholder="Search by name or base model"
                        empty="No model matches."
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function jobId(value: string | undefined): number | null {
    const id = Number(value);
    return value && Number.isInteger(id) ? id : null;
}

export function TrainingListPage() {
    const { search, update } = useListSearch(PATH, KEYS);
    const minibrains = useMinibrains();
    const [picking, setPicking] = useState(false);
    const [order, setOrder] = useState<JobOrder>("newest");
    const models = splitList(search.model);
    const statuses = splitList(search.status);
    const filter = {
        kind: TRAINING_KINDS,
        minibrain: models,
        status: statuses,
        q: search.q,
        since: search.since,
        order,
    };
    const jobs = useJobList(filter);
    const facets = useJobFacets(filter, jobs.rows.some(isActiveJob));
    const filtering = models.length + statuses.length > 0 || Boolean(search.q || search.since);
    const columns = useMemo(
        () => jobColumns((job) => listHref(PATH, { ...search, job: String(job.id) })),
        [search],
    );
    const modelOptions = (minibrains.data ?? []).map((item) => ({
        value: item.slug,
        label: item.name,
        count: facets.data?.minibrains[item.slug] ?? 0,
    }));
    const statusOptions = JOB_STATUSES.map((status) => ({
        value: status,
        label: jobStatusLabel(status),
        count: facets.data?.statuses[status] ?? 0,
    }));
    const clear = () => update({ model: "", status: "", q: "", since: "" });
    return (
        <Page wide>
            <PageHeader
                title="Training"
                caption="Training and scoring runs across every model. One job runs at a time; the rest wait in the queue."
                actions={<Button onClick={() => setPicking(true)}>Train a model</Button>}
            />
            <div className="flex flex-wrap items-center gap-2">
                <SearchInput
                    aria-label="Search jobs"
                    placeholder="Search by model or job ID"
                    value={search.q ?? ""}
                    onValueChange={(q) => update({ q })}
                    className="w-full min-w-48 max-w-xs flex-1"
                />
                <CheckboxSelect
                    label="Model"
                    allLabel="All models"
                    noun="models"
                    options={modelOptions}
                    value={models}
                    onValueChange={(next) => update({ model: next.join(",") })}
                />
                <CheckboxSelect
                    label="Status"
                    allLabel="All statuses"
                    noun="statuses"
                    options={statusOptions}
                    value={statuses}
                    onValueChange={(next) => update({ status: next.join(",") })}
                />
                <Select
                    value={search.since ?? ANY_TIME}
                    onValueChange={(next) =>
                        update({ since: next === ANY_TIME ? "" : String(next) })
                    }
                >
                    <SelectTrigger aria-label="Created" className="w-auto min-w-36">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={ANY_TIME}>Any time</SelectItem>
                        {SINCE_CHOICES.map((choice) => (
                            <SelectItem key={choice.value} value={choice.value}>
                                {choice.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {filtering && (
                    <Button variant="ghost" onClick={clear}>
                        Clear filters
                    </Button>
                )}
            </div>
            <ErrorLine error={jobs.error} />
            <DataGrid
                columns={columns}
                rows={jobs.rows}
                getRowId={(job) => String(job.id)}
                loading={jobs.isLoading}
                storageKey="minibrain.training.columns"
                columnPicker
                hiddenColumns={["id", "attempt"]}
                sorting={sortingFor(order)}
                onSortingChange={(next) => setOrder(orderFrom(next))}
                hasMore={jobs.hasMore}
                loadingMore={jobs.loadingMore}
                onLoadMore={jobs.loadMore}
                total={jobs.total}
                onOpen={(job) => update({ job: String(job.id) })}
                rowLabel={(job) =>
                    `${job.minibrain_name ?? "Deleted model"}, ${jobName(job)}, ${jobStatusLabel(job.status)}`
                }
                empty={
                    filtering ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-muted-foreground">No jobs match these filters.</p>
                            <Button variant="outline" onClick={clear}>
                                Clear filters
                            </Button>
                        </div>
                    ) : (
                        <p className="text-muted-foreground">
                            No training yet. Train a model to score or train its first version.
                        </p>
                    )
                }
                minWidth="min-w-[760px]"
            />
            <JobDialog id={jobId(search.job)} onClose={() => update({ job: "" })} />
            <TrainPicker open={picking} onOpenChange={setPicking} />
        </Page>
    );
}

export function ModelTrainingPage() {
    const { slug = "" } = useParams({ strict: false }) as { slug?: string };
    const minibrains = useMinibrains();
    const model = minibrains.data?.find((item) => item.slug === slug);
    return (
        <Page>
            <Link
                href={PATH}
                className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ChevronLeft className="size-4" />
                Training
            </Link>
            <ErrorLine error={minibrains.error} />
            {minibrains.data && !model && (
                <p className="text-sm text-muted-foreground">No custom model called {slug}.</p>
            )}
            {model && (
                <>
                    <PageHeader
                        title={model.name}
                        caption="Score prompt-only versions and train new ones."
                        actions={
                            <Button variant="outline" asChild>
                                <Link href={evaluationsHref(model.slug)}>Review results</Link>
                            </Button>
                        }
                    />
                    <Training key={model.slug} slug={model.slug} />
                </>
            )}
        </Page>
    );
}
