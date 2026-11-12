import { useParams, useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { History } from "lucide-react";
import {
    Button,
    CheckboxSelect,
    DataGrid,
    Dialog,
    DialogContent,
    DialogDescription,
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
} from "obp-ui";
import { useEffect, useState } from "react";
import type { JobInfo, ModelSummary } from "~/api/client";
import { type JobOrder, useJobFacets, useJobList } from "~/api/jobQueries";
import { isActiveJob, useModels } from "~/api/queries";
import { JobToolbar, useJobSelection } from "~/components/JobSelection";
import { ModelName } from "~/components/ModelName";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo, modelOption } from "~/components/PublisherLogo";
import { Redirect } from "~/components/Redirect";
import { ErrorLine, Page, PanelSection, PanelSections } from "~/components/Section";
import { JOB_STATUSES, jobStatusLabel } from "~/components/StatusBadge";
import { useCan } from "~/lib/access";
import { TRAIN_KIND, jobPageHref } from "~/lib/jobs";
import { splitList, useListSearch } from "~/lib/listSearch";
import { TRAINING_PATH, jobHref, modelPageHref, trainHref, trainingHref } from "~/lib/modelLinks";
import { JobPage } from "../jobs/JobPage";
import {
    ATTEMPT_COLUMN,
    DURATION_COLUMN,
    ID_COLUMN,
    SCORE_COLUMN,
    STARTED_COLUMN,
    STATUS_COLUMN,
    jobRowLabel,
    methodText,
    orderFrom,
    ownerName,
    sortedById,
    sortingFor,
} from "../jobs/jobCells";

const KEYS = ["model", "status", "method", "q", "job"] as const;
const ANY = "any";
const SFT = "sft";

const METHODS = [
    { value: SFT, label: "Supervised fine-tuning (SFT)", ready: true },
    { value: "dpo", label: "DPO", ready: false },
    { value: "pretraining", label: "Continued pretraining", ready: false },
    { value: "rl", label: "Reinforcement learning", ready: false },
];

function TrainedModel({ job }: { job: JobInfo }) {
    const name = ownerName(job);
    const label = (
        <span className="flex min-w-0 items-center gap-2">
            <PublisherLogo name={name} modelKey={job.model ?? undefined} size="sm" />
            <ModelName name={name} deleted={job.deleted} className="truncate font-medium" />
        </span>
    );
    if (job.deleted || !job.model) {
        return label;
    }
    return (
        <Link href={modelPageHref(job.model)} className="block min-w-0 hover:underline">
            {label}
        </Link>
    );
}

const COLUMNS: ColumnDef<JobInfo, unknown>[] = sortedById([
    ID_COLUMN,
    {
        id: "model",
        header: "Model",
        accessorFn: (job) => ownerName(job).toLowerCase(),
        cell: ({ row }) => <TrainedModel job={row.original} />,
    },
    {
        id: "version",
        header: "Version",
        accessorFn: (job) => job.version ?? -1,
        cell: ({ row }) =>
            row.original.version === null || row.original.version === undefined ? (
                <span className="text-muted-foreground">–</span>
            ) : (
                <span className="tabular-nums">{`v${row.original.version}`}</span>
            ),
    },
    STATUS_COLUMN,
    SCORE_COLUMN,
    {
        id: "method",
        header: "Method",
        accessorFn: methodText,
        cell: ({ row }) => <span className="tabular-nums">{methodText(row.original)}</span>,
    },
    DURATION_COLUMN,
    STARTED_COLUMN,
    ATTEMPT_COLUMN,
]);

function ModelChoice({ item }: { item: ModelSummary }) {
    return (
        <>
            <PublisherLogo name={item.name} custom avatar={item.avatar} />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{item.name}</span>
                <span className="truncate text-sm text-muted-foreground">{`On ${item.base_model}`}</span>
            </span>
            <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                {item.versions === 1 ? "1 version" : `${item.versions} versions`}
            </span>
        </>
    );
}

function TrainPicker({
    open,
    onOpenChange,
}: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const router = useRouter();
    const models = useModels();
    const items = models.data ?? [];
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Train which model?</DialogTitle>
                    <DialogDescription>
                        Its next version trains from its base on its training data.
                    </DialogDescription>
                </DialogHeader>
                {models.data && items.length === 0 ? (
                    <p className="text-muted-foreground">
                        No custom models yet.{" "}
                        <Link href="/models/new" className="text-primary hover:underline">
                            Add a model
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
                            router.history.push(trainHref(item.slug));
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

function MethodFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    return (
        <Select value={value} onValueChange={(next) => onChange(String(next))}>
            <SelectTrigger aria-label="Method" className="w-auto min-w-40">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value={ANY} label="Any method">
                    Any method
                </SelectItem>
                {METHODS.map((method) => (
                    <SelectItem
                        key={method.value}
                        value={method.value}
                        label={method.label}
                        disabled={!method.ready}
                        description={method.ready ? undefined : "Coming soon"}
                    >
                        {method.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function useOldJobLinks(job: string | undefined) {
    const router = useRouter();
    useEffect(() => {
        const id = Number(job);
        if (job && Number.isInteger(id) && id > 0) {
            router.history.replace(jobPageHref(id));
        }
    }, [job, router]);
}

function plural(count: number, noun: string): string {
    return `${count.toLocaleString()} ${count === 1 ? noun : `${noun}s`}`;
}

function shownCount(shown: number | undefined, all: number | undefined): string {
    if (shown === undefined) {
        return "";
    }
    return all === undefined || shown === all
        ? plural(shown, "run")
        : `${shown.toLocaleString()} of ${plural(all, "run")}`;
}

function Runs() {
    const { search, update } = useListSearch(TRAINING_PATH, KEYS);
    const router = useRouter();
    useOldJobLinks(search.job);
    const owned = useModels();
    const [order, setOrder] = useState<JobOrder>("newest");
    const models = splitList(search.model);
    const statuses = splitList(search.status);
    const method = search.method === SFT ? SFT : ANY;
    const filter = {
        kind: [TRAIN_KIND],
        model: models,
        status: statuses,
        method: method === ANY ? [] : [method],
        q: search.q,
        order,
    };
    const jobs = useJobList(filter);
    const facets = useJobFacets(filter, jobs.rows.some(isActiveJob));
    const everything = useJobFacets({ kind: [TRAIN_KIND] }, false);
    const filtering = models.length + statuses.length > 0 || method !== ANY || Boolean(search.q);
    const selection = useJobSelection(
        jobs.rows,
        [search.model, search.status, search.method, search.q].join("\n"),
    );
    const deleted = Object.entries(facets.data?.deleted_models ?? {}).map(([slug, name]) => ({
        value: slug,
        label: name,
        deleted: true,
    }));
    const modelOptions = [
        ...(owned.data ?? []).map((item) => ({ value: item.slug, label: item.name })),
        ...deleted,
    ].map((item) => modelOption({ ...item, count: facets.data?.models[item.value] ?? 0 }));
    const statusOptions = JOB_STATUSES.map((status) => ({
        value: status,
        label: jobStatusLabel(status),
        count: facets.data?.statuses[status] ?? 0,
    }));
    const clear = () => update({ model: "", status: "", method: "", q: "" });
    return (
        <div className="flex flex-col gap-3">
            <JobToolbar selection={selection}>
                <SearchInput
                    aria-label="Search runs"
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
                    allLabel="Any status"
                    noun="statuses"
                    options={statusOptions}
                    value={statuses}
                    onValueChange={(next) => update({ status: next.join(",") })}
                />
                <MethodFilter
                    value={method}
                    onChange={(next) => update({ method: next === ANY ? "" : next })}
                />
                {filtering && (
                    <Button variant="ghost" onClick={clear}>
                        Clear filters
                    </Button>
                )}
                <span className="text-sm tabular-nums text-muted-foreground">
                    {shownCount(jobs.total, everything.data?.total)}
                </span>
            </JobToolbar>
            <ErrorLine error={jobs.error} />
            <DataGrid
                columns={COLUMNS}
                rows={jobs.rows}
                getRowId={(job) => String(job.id)}
                loading={jobs.isLoading}
                storageKey="minibrain.training.runs"
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
                            <p className="text-muted-foreground">No runs match these filters.</p>
                            <Button variant="outline" onClick={clear}>
                                Clear filters
                            </Button>
                        </div>
                    ) : (
                        <p className="text-muted-foreground">
                            No training runs yet. Train a model to make its first trained version.
                        </p>
                    )
                }
                minWidth="min-w-[860px]"
            />
        </div>
    );
}

export function TrainingListPage() {
    const can = useCan();
    const [picking, setPicking] = useState(false);
    return (
        <Page wide>
            <PageHeader
                title="Training"
                caption="Every training run across your models."
                actions={
                    can.build && <Button onClick={() => setPicking(true)}>Train a model</Button>
                }
            />
            <PanelSections>
                <PanelSection
                    icon={History}
                    title="Runs"
                    description="Each run trained one version; open one for its data, settings, loss and logs."
                    bare
                >
                    <Runs />
                </PanelSection>
            </PanelSections>
            <TrainPicker open={picking} onOpenChange={setPicking} />
        </Page>
    );
}

export function TrainingItemPage() {
    const { id = "" } = useParams({ strict: false }) as { id?: string };
    if (/^\d+$/.test(id)) {
        return <JobPage />;
    }
    return <Redirect to={trainingHref(id)} />;
}
