import { useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Brain, Layers, MoreHorizontal, Search, X } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    Label,
    Link,
    SegmentedTabs,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { useMemo, useState } from "react";
import { type ModelRow, api, unwrap } from "~/api/client";
import { useModels } from "~/api/queries";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine, PanelSection, PanelSections } from "~/components/Section";
import { Requests, Stages } from "~/components/models/ModelMetrics";
import { SortableTable } from "~/components/models/SortableTable";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import type { ModelsSearch } from "~/lib/modelsSearch";
import { bytes, exactTime, relativeTime } from "~/lib/time";
import { GetStarted } from "./GetStarted";
import {
    ConfirmAction,
    type Confirmation,
    CreateModelDialog,
    EditModelDialog,
    TestBaseDialog,
    cancelJob,
    useModelsRefresh,
} from "./dialogs";

const ANY = "all";
const AVAILABILITY_LABELS: Record<string, string> = {
    available: "Available",
    downloading: "Downloading",
    importing: "Importing",
    missing: "Missing files",
    not_downloaded: "Not downloaded",
};
const AVAILABILITY_TONES: Record<string, Tone> = {
    available: "success",
    downloading: "info",
    importing: "info",
    missing: "destructive",
    not_downloaded: "neutral",
};
const ACTIVITY_TONES: Record<string, Tone> = {
    running: "info",
    queued: "neutral",
    failed: "destructive",
    ready: "success",
    needs_examples: "warning",
};
const DEPLOYMENT_TONES: Record<string, Tone> = {
    running: "success",
    starting: "info",
    unhealthy: "destructive",
};
const STATE_ORDER = ["downloading", "importing", "missing", "available", "not_downloaded", "none"];

export function detailHref(row: ModelRow): string {
    return `/models/${row.kind}/${encodeURIComponent(row.key)}`;
}

function scoped(path: string, row: ModelRow): string {
    return `${path}?minibrain=${encodeURIComponent(row.key)}`;
}

function jobHref(row: ModelRow): string {
    return row.kind === "custom" ? scoped("/training", row) : detailHref(row);
}

function percent(value: number | null | undefined): string | null {
    return value === null || value === undefined ? null : `${Math.round(value * 100)}%`;
}

export function Availability({ row }: { row: ModelRow }) {
    const { state, progress } = row.availability;
    if (state === "none") {
        return <span className="text-muted-foreground">—</span>;
    }
    const label = AVAILABILITY_LABELS[state];
    const moving = state === "downloading" || state === "importing";
    return (
        <div className="flex flex-col gap-1">
            <StatusText tone={AVAILABILITY_TONES[state]}>
                {label}
                {moving && percent(progress) && (
                    <span className="tabular-nums"> · {percent(progress)}</span>
                )}
            </StatusText>
            {moving && (
                <ProgressBar value={progress} label={`${row.name} ${label.toLowerCase()}`} />
            )}
        </div>
    );
}

export function Activity({ row }: { row: ModelRow }) {
    const { state, label, progress, job_id: jobId } = row.activity;
    if (state === "idle") {
        return <span className="text-muted-foreground">{label}</span>;
    }
    const text = (
        <StatusText tone={ACTIVITY_TONES[state] ?? "neutral"}>
            {label}
            {state === "running" && percent(progress) && (
                <span className="tabular-nums"> · {percent(progress)}</span>
            )}
        </StatusText>
    );
    const href =
        state === "ready"
            ? scoped("/evaluations", row)
            : state === "needs_examples"
              ? scoped("/data", row)
              : jobId
                ? jobHref(row)
                : null;
    return (
        <div className="flex flex-col gap-1">
            {href ? (
                <Link href={href} className="hover:underline">
                    {text}
                </Link>
            ) : (
                text
            )}
            {state === "running" && <ProgressBar value={progress} label={label} />}
        </div>
    );
}

export function Deployment({ row }: { row: ModelRow }) {
    const { state, label } = row.deployment;
    if (state === "not_deployed") {
        return <span className="text-muted-foreground">{label}</span>;
    }
    const href = row.kind === "custom" ? scoped("/deployments", row) : `${detailHref(row)}#api`;
    return (
        <Link href={href} className="hover:underline">
            <StatusText tone={DEPLOYMENT_TONES[state] ?? "neutral"}>{label}</StatusText>
        </Link>
    );
}

export function Updated({ value }: { value: string }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className="whitespace-nowrap rounded-sm tabular-nums text-muted-foreground"
                >
                    <time dateTime={value}>{relativeTime(value)}</time>
                </button>
            </TooltipTrigger>
            <TooltipContent>{exactTime(value)}</TooltipContent>
        </Tooltip>
    );
}

type Handlers = {
    open: (path: string) => void;
    test: (row: ModelRow) => void;
    edit: (row: ModelRow) => void;
    confirm: (confirmation: Confirmation) => void;
    createFrom: (base: string) => void;
    refresh: () => Promise<unknown>;
};

function retry(row: ModelRow) {
    return unwrap(api.POST("/api/models/base/{key}/retry", { params: { path: { key: row.key } } }));
}

function setDeployed(row: ModelRow, deployed: boolean) {
    return unwrap(
        api.POST("/api/models/base/{key}/deploy", {
            params: { path: { key: row.key } },
            body: { deployed },
        }),
    );
}

function setArchived(row: ModelRow, archived: boolean) {
    const body = { archived };
    return row.kind === "base"
        ? unwrap(api.PATCH("/api/models/base/{key}", { params: { path: { key: row.key } }, body }))
        : unwrap(
              api.PATCH("/api/minibrains/{slug}", { params: { path: { slug: row.key } }, body }),
          );
}

function primaryAction(row: ModelRow, on: Handlers): { label: string; run: () => void } | null {
    const deployed = row.deployment.state === "running";
    if (row.kind === "base") {
        if (row.activity.state === "failed" && row.availability.state === "not_downloaded") {
            return { label: "Retry", run: () => retry(row).then(on.refresh) };
        }
        if (row.availability.state === "available" && deployed) {
            return { label: "Use API", run: () => on.open(`${detailHref(row)}#api`) };
        }
        if (row.availability.state === "available") {
            return { label: "Test", run: () => on.test(row) };
        }
        return null;
    }
    if (row.activity.state === "needs_examples") {
        return { label: "Add examples", run: () => on.open(scoped("/data", row)) };
    }
    if (row.activity.state === "ready") {
        return { label: "Review results", run: () => on.open(scoped("/evaluations", row)) };
    }
    if (deployed) {
        return { label: "Use API", run: () => on.open(scoped("/deployments", row)) };
    }
    if (row.can_test) {
        return { label: "Test", run: () => on.test(row) };
    }
    return null;
}

function archiveConfirmation(row: ModelRow, on: Handlers): Confirmation {
    const deployed = row.deployment.state !== "not_deployed";
    return {
        title: row.archived ? `Restore ${row.name}?` : `Archive ${row.name}?`,
        description: row.archived ? (
            <p>It shows in Models again.</p>
        ) : (
            <>
                <p>It is hidden from Models; use Show archived to find it again.</p>
                <p>
                    {deployed
                        ? "Its deployment keeps running and its files stay in storage. Undeploy it separately if needed."
                        : "Its files stay in storage."}
                </p>
            </>
        ),
        confirmLabel: row.archived ? "Restore" : "Archive",
        run: () => setArchived(row, !row.archived).then(on.refresh),
    };
}

function deleteModel(row: ModelRow) {
    return row.kind === "base"
        ? unwrap(api.DELETE("/api/models/base/{key}", { params: { path: { key: row.key } } }))
        : unwrap(api.DELETE("/api/minibrains/{slug}", { params: { path: { slug: row.key } } }));
}

function deleteConfirmation(row: ModelRow, on: Handlers): Confirmation {
    const deployed = row.deployment.state !== "not_deployed";
    return {
        title: `Delete ${row.name}?`,
        description:
            row.kind === "base" ? (
                <>
                    <p>
                        {row.size_bytes
                            ? `Its weights (${bytes(row.size_bytes)}) are removed from storage, with its API keys.`
                            : "Its record and API keys are removed."}{" "}
                        You can download or import it again later.
                    </p>
                    {deployed && <p>It is deployed: undeploy it first.</p>}
                </>
            ) : (
                <>
                    <p>
                        Its data, versions, evaluation results and API keys are removed. This cannot
                        be undone.
                    </p>
                    {deployed && (
                        <p>
                            It is deployed: apps calling{" "}
                            <span className="font-mono">{row.key}</span> start getting errors.
                        </p>
                    )}
                </>
            ),
        confirmLabel: "Delete",
        destructive: true,
        run: () => deleteModel(row).then(on.refresh),
    };
}

function RowActions({ row, on }: { row: ModelRow; on: Handlers }) {
    const primary = primaryAction(row, on);
    const transferring = row.kind === "base" && ["running", "queued"].includes(row.activity.state);
    const deployed = row.deployment.state !== "not_deployed";
    return (
        <div className="flex items-center justify-end gap-1">
            {primary && (
                <Button variant="outline" size="xs" onClick={primary.run}>
                    {primary.label}
                </Button>
            )}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`More actions for ${row.name}`}
                    >
                        <MoreHorizontal />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuItem onSelect={() => on.open(detailHref(row))}>
                        View details
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => on.edit(row)}>
                        Edit name, description and tags
                    </DropdownMenuItem>
                    {row.kind === "custom" && (
                        <DropdownMenuItem onSelect={() => on.open(scoped("/training", row))}>
                            Train
                        </DropdownMenuItem>
                    )}
                    {row.kind === "base" && row.trainable && (
                        <DropdownMenuItem onSelect={() => on.createFrom(row.key)}>
                            Train a model on it
                        </DropdownMenuItem>
                    )}
                    {row.kind === "custom" && (
                        <DropdownMenuItem onSelect={() => on.open(scoped("/evaluations", row))}>
                            {deployed ? "Change deployed version" : "Deploy a version"}
                        </DropdownMenuItem>
                    )}
                    {row.kind === "base" && row.availability.state === "available" && (
                        <DropdownMenuItem
                            onSelect={() =>
                                on.confirm({
                                    title: deployed
                                        ? `Undeploy ${row.name}?`
                                        : `Deploy ${row.name}?`,
                                    description: deployed ? (
                                        <p>Its API stops answering; keys and files stay.</p>
                                    ) : (
                                        <p>
                                            It becomes callable as{" "}
                                            <span className="font-mono">{row.key}</span> on the
                                            OpenAI-compatible API with its own keys
                                            {row.needed_bytes
                                                ? `, using about ${bytes(row.needed_bytes)} of memory`
                                                : ""}
                                            .
                                        </p>
                                    ),
                                    confirmLabel: deployed ? "Undeploy" : "Deploy",
                                    destructive: deployed,
                                    run: () => setDeployed(row, !deployed).then(on.refresh),
                                })
                            }
                        >
                            {deployed ? "Undeploy" : "Deploy"}
                        </DropdownMenuItem>
                    )}
                    {transferring && row.activity.job_id !== null && (
                        <DropdownMenuItem
                            onSelect={() =>
                                on.confirm({
                                    title: `Cancel ${row.activity.label.toLowerCase()}?`,
                                    description: (
                                        <p>Files already validated are kept, so a retry resumes.</p>
                                    ),
                                    confirmLabel: "Cancel transfer",
                                    destructive: true,
                                    run: () => cancelJob(row.activity.job_id ?? 0).then(on.refresh),
                                })
                            }
                        >
                            Cancel {row.activity.kind === "import" ? "import" : "download"}
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => on.confirm(archiveConfirmation(row, on))}>
                        {row.archived ? "Restore" : "Archive"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => on.confirm(deleteConfirmation(row, on))}
                    >
                        Delete
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

function ModelName({ row }: { row: ModelRow }) {
    return (
        <div className="flex min-w-52 max-w-72 items-start gap-3">
            <PublisherLogo publisher={row.publisher} name={row.name} />
            <div className="flex min-w-0 flex-col">
                <Link
                    href={detailHref(row)}
                    className="font-semibold text-foreground hover:underline"
                >
                    {row.name}
                </Link>
                <span className="truncate text-sm text-muted-foreground">
                    {row.description ||
                        (row.kind === "custom" ? `Classify model on ${row.base_model}` : row.key)}
                </span>
            </div>
        </div>
    );
}

function requestTotal(row: ModelRow): number {
    return (row.usage?.daily ?? []).reduce((sum, value) => sum + value, 0);
}

function usageColumn(): ColumnDef<ModelRow, unknown> {
    return {
        id: "usage",
        header: "Usage, 7 days",
        accessorFn: requestTotal,
        cell: ({ row }) => <Requests usage={row.original.usage} />,
    };
}

function actionsColumn(on: Handlers): ColumnDef<ModelRow, unknown> {
    return {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => <RowActions row={row.original} on={on} />,
    };
}

function customColumns(on: Handlers): ColumnDef<ModelRow, unknown>[] {
    return [
        {
            id: "model",
            header: "Model",
            accessorFn: (row) => row.name.toLowerCase(),
            cell: ({ row }) => <ModelName row={row.original} />,
        },
        {
            id: "progress",
            header: "Progress",
            accessorFn: (row) => row.accuracy ?? -1,
            cell: ({ row }) => <Stages stages={row.original.stages ?? []} />,
        },
        usageColumn(),
        actionsColumn(on),
    ];
}

function baseColumns(on: Handlers): ColumnDef<ModelRow, unknown>[] {
    return [
        {
            id: "model",
            header: "Model",
            accessorFn: (row) => row.name.toLowerCase(),
            cell: ({ row }) => <ModelName row={row.original} />,
        },
        {
            id: "availability",
            header: "Availability",
            accessorFn: (row) => STATE_ORDER.indexOf(row.availability.state),
            cell: ({ row }) =>
                row.original.activity.state === "failed" ? (
                    <Activity row={row.original} />
                ) : (
                    <Availability row={row.original} />
                ),
        },
        {
            id: "size",
            header: "Size",
            accessorFn: (row) => row.size_bytes ?? 0,
            cell: ({ row }) =>
                row.original.size_bytes ? (
                    <span className="tabular-nums">{bytes(row.original.size_bytes)}</span>
                ) : (
                    <span className="text-muted-foreground">—</span>
                ),
        },
        usageColumn(),
        {
            id: "deployment",
            header: "Deployment",
            accessorFn: (row) => row.deployment.state,
            cell: ({ row }) => <Deployment row={row.original} />,
        },
        actionsColumn(on),
    ];
}

const ATTENTION_STATES = ["failed", "needs_examples", "ready"];

function needsAttention(row: ModelRow): boolean {
    return (
        ATTENTION_STATES.includes(row.activity.state) ||
        row.availability.state === "missing" ||
        row.deployment.state === "unhealthy"
    );
}

type Facet = "type" | "availability" | "deployment" | "tag" | "attention";

function matches(row: ModelRow, search: ModelsSearch, skip?: Facet): boolean {
    const text = (search.q ?? "").trim().toLowerCase();
    if (text && !`${row.name} ${row.description} ${row.key}`.toLowerCase().includes(text)) {
        return false;
    }
    if (skip !== "type" && search.type && row.kind !== search.type) {
        return false;
    }
    if (
        skip !== "availability" &&
        search.availability &&
        row.availability.state !== search.availability
    ) {
        return false;
    }
    const deployed = row.deployment.state !== "not_deployed";
    if (skip !== "deployment" && search.deployment === "deployed" && !deployed) {
        return false;
    }
    if (skip !== "deployment" && search.deployment === "not-deployed" && deployed) {
        return false;
    }
    if (skip !== "attention" && search.attention === "true" && !needsAttention(row)) {
        return false;
    }
    return skip === "tag" || !search.tag || row.tags.includes(search.tag);
}

function FilterSelect({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: string | undefined;
    options: [string, string, number][];
    onChange: (value: string) => void;
}) {
    return (
        <Select
            value={value ?? ANY}
            onValueChange={(next) => onChange(next === ANY ? "" : String(next))}
        >
            <SelectTrigger aria-label={label} className="w-auto min-w-36">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value={ANY}>{`${label}: All`}</SelectItem>
                {options.map(([key, text, total]) => (
                    <SelectItem key={key} value={key}>
                        {`${label}: ${text} (${total})`}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

const DEPLOYMENT_OPTIONS: [string, string][] = [
    ["deployed", "Deployed"],
    ["not-deployed", "Not deployed"],
];

function chips(search: ModelsSearch): { label: string; clear: ModelsSearch }[] {
    return [
        search.q ? { label: `“${search.q}”`, clear: { q: "" } } : null,
        search.type
            ? { label: search.type === "base" ? "Base" : "Custom", clear: { type: "" } }
            : null,
        search.attention === "true" ? { label: "Needs attention", clear: { attention: "" } } : null,
        search.availability
            ? { label: AVAILABILITY_LABELS[search.availability], clear: { availability: "" } }
            : null,
        search.deployment
            ? {
                  label: search.deployment === "deployed" ? "Deployed" : "Not deployed",
                  clear: { deployment: "" },
              }
            : null,
        search.tag ? { label: `Tag ${search.tag}`, clear: { tag: "" } } : null,
    ].filter((chip) => chip !== null);
}

const CLEARED: ModelsSearch = {
    q: "",
    type: "",
    availability: "",
    deployment: "",
    tag: "",
    attention: "",
};

function plural(total: number, noun: string): string {
    return `${total} ${noun}${total === 1 ? "" : "s"}`;
}

export function MyModels({
    search,
    update,
    onDiscover,
    onCreate,
}: {
    search: ModelsSearch;
    update: (patch: ModelsSearch) => void;
    onDiscover: () => void;
    onCreate: () => void;
}) {
    const router = useRouter();
    const refresh = useModelsRefresh();
    const archived = search.archived === "true";
    const models = useModels(archived);
    const [testing, setTesting] = useState<ModelRow | null>(null);
    const [editing, setEditing] = useState<ModelRow | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [createBase, setCreateBase] = useState<string | null>(null);
    const on: Handlers = useMemo(
        () => ({
            open: (path) => router.history.push(path),
            test: (row) => {
                if (row.kind === "base") {
                    setTesting(row);
                    return;
                }
                if (row.deployment.state === "running") {
                    router.history.push(scoped("/playground", row));
                    return;
                }
                setConfirmation({
                    title: `Test ${row.name}?`,
                    description: (
                        <p>
                            The playground loads {row.base_model}
                            {row.needed_bytes
                                ? ` (about ${bytes(row.needed_bytes)} of memory)`
                                : ""}{" "}
                            on this machine if it is not running yet. It unloads after 15 minutes
                            without requests; nothing is deployed.
                        </p>
                    ),
                    confirmLabel: "Open playground",
                    run: async () => router.history.push(scoped("/playground", row)),
                });
            },
            edit: setEditing,
            confirm: setConfirmation,
            createFrom: setCreateBase,
            refresh,
        }),
        [router, refresh],
    );
    const customTable = useMemo(() => customColumns(on), [on]);
    const baseTable = useMemo(() => baseColumns(on), [on]);
    const rows = models.data ?? [];
    const visible = rows.filter((row) => matches(row, search));
    const custom = visible.filter((row) => row.kind === "custom");
    const base = visible.filter((row) => row.kind === "base");
    const facetCount = (facet: Facet, test: (row: ModelRow) => boolean) =>
        rows.filter((row) => matches(row, search, facet) && test(row)).length;
    const tags = [...new Set(rows.flatMap((row) => row.tags))].sort();
    const active = chips(search);
    const attention = search.attention === "true";
    const attentionCount = facetCount("attention", needsAttention);
    const filtering = active.length > 0;
    const clear = () => update(CLEARED);
    const showCustom = search.type !== "base";
    const showBase = search.type !== "custom";
    const firstRun = !rows.some((row) => row.kind === "custom") && !filtering && !archived;
    const baseBytes = base.reduce((sum, row) => sum + (row.size_bytes ?? 0), 0);
    const noMatch = (
        <div className="flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground">No models match these filters.</p>
            {filtering && (
                <Button variant="outline" size="sm" onClick={clear}>
                    Clear filters
                </Button>
            )}
        </div>
    );
    const noBase = filtering ? (
        noMatch
    ) : (
        <div className="flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground">
                No base models downloaded yet; Qwen3 0.6B is still ready for training.
            </p>
            <Button variant="outline" size="sm" onClick={onDiscover}>
                Discover base models
            </Button>
        </div>
    );
    const typeTabs = [
        { key: "all", label: "All", badge: facetCount("type", () => true) },
        {
            key: "custom",
            label: "Custom",
            badge: facetCount("type", (row) => row.kind === "custom"),
        },
        { key: "base", label: "Base", badge: facetCount("type", (row) => row.kind === "base") },
    ];
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        aria-label="Search models"
                        placeholder="Search models"
                        value={search.q ?? ""}
                        onChange={(event) => update({ q: event.target.value })}
                        className="h-8 w-64 pl-8"
                    />
                </div>
                <SegmentedTabs
                    tabs={typeTabs}
                    active={search.type || "all"}
                    onSelect={(key) => update({ type: key === "all" ? "" : key })}
                />
                <Button
                    variant={attention ? "secondary" : "outline"}
                    aria-pressed={attention}
                    disabled={!attention && attentionCount === 0}
                    onClick={() => update({ attention: attention ? "" : "true" })}
                >
                    Needs attention
                    <span className="tabular-nums text-muted-foreground">{attentionCount}</span>
                </Button>
                <FilterSelect
                    label="Availability"
                    value={search.availability}
                    options={Object.entries(AVAILABILITY_LABELS).map(([key, text]) => [
                        key,
                        text,
                        facetCount("availability", (row) => row.availability.state === key),
                    ])}
                    onChange={(availability) => update({ availability })}
                />
                <FilterSelect
                    label="Deployment"
                    value={search.deployment}
                    options={DEPLOYMENT_OPTIONS.map(([key, text]) => [
                        key,
                        text,
                        facetCount(
                            "deployment",
                            (row) =>
                                (row.deployment.state !== "not_deployed") === (key === "deployed"),
                        ),
                    ])}
                    onChange={(deployment) => update({ deployment })}
                />
                {tags.length > 0 && (
                    <FilterSelect
                        label="Tag"
                        value={search.tag}
                        options={tags.map((tag) => [
                            tag,
                            tag,
                            facetCount("tag", (row) => row.tags.includes(tag)),
                        ])}
                        onChange={(tag) => update({ tag })}
                    />
                )}
                <div className="ml-auto flex items-center gap-2">
                    <Switch
                        id="show-archived"
                        checked={archived}
                        onCheckedChange={(checked) => update({ archived: checked ? "true" : "" })}
                    />
                    <Label htmlFor="show-archived" className="text-sm text-muted-foreground">
                        Show archived
                    </Label>
                </div>
            </div>
            {filtering && (
                <div className="flex flex-wrap items-center gap-2">
                    {active.map((chip) => (
                        <Button
                            key={chip.label}
                            variant="outline"
                            size="xs"
                            aria-label={`Remove filter ${chip.label}`}
                            onClick={() => update(chip.clear)}
                        >
                            {chip.label}
                            <X />
                        </Button>
                    ))}
                    <Button variant="ghost" size="xs" onClick={clear}>
                        Clear all
                    </Button>
                </div>
            )}
            {models.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading models…</p>
            ) : models.error ? (
                <div className="flex items-center gap-2">
                    <ErrorLine error={models.error} />
                    <Button variant="outline" size="sm" onClick={() => models.refetch()}>
                        Try again
                    </Button>
                </div>
            ) : (
                <PanelSections>
                    {showCustom && (
                        <PanelSection
                            icon={Brain}
                            title="Custom models"
                            bare
                            actions={
                                <span className="text-sm text-muted-foreground tabular-nums">
                                    {plural(custom.length, "model")}
                                </span>
                            }
                        >
                            {firstRun ? (
                                <GetStarted onDiscover={onDiscover} onCreate={onCreate} />
                            ) : (
                                <SortableTable
                                    columns={customTable}
                                    rows={custom}
                                    onOpen={(row) => on.open(detailHref(row))}
                                    rowLabel={(row) => `${row.name}, custom model`}
                                    empty={noMatch}
                                    minWidth="min-w-[880px]"
                                />
                            )}
                        </PanelSection>
                    )}
                    {showBase && (
                        <PanelSection
                            icon={Layers}
                            title="Base models"
                            bare
                            actions={
                                <span className="text-sm text-muted-foreground tabular-nums">
                                    {plural(base.length, "model")}
                                    {baseBytes > 0 ? ` · ${bytes(baseBytes)}` : ""}
                                </span>
                            }
                        >
                            <SortableTable
                                columns={baseTable}
                                rows={base}
                                onOpen={(row) => on.open(detailHref(row))}
                                rowLabel={(row) => `${row.name}, base model`}
                                empty={noBase}
                                minWidth="min-w-[880px]"
                            />
                        </PanelSection>
                    )}
                </PanelSections>
            )}
            <TestBaseDialog row={testing} onOpenChange={(open) => !open && setTesting(null)} />
            <EditModelDialog row={editing} onOpenChange={(open) => !open && setEditing(null)} />
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
            <CreateModelDialog
                open={createBase !== null}
                onOpenChange={(open) => !open && setCreateBase(null)}
                base={createBase ?? undefined}
            />
        </div>
    );
}
