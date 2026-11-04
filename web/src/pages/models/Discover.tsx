import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowUpDown, ExternalLink, KeyRound, Plus, X } from "lucide-react";
import {
    Badge,
    Button,
    DataGrid,
    DataGridDetail,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    InfoTip,
    Link,
    SearchInput,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Skeleton,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import { type ReactNode, useId, useMemo, useState } from "react";
import { type CatalogEntry, type CatalogResponse, type FitInfo, api, unwrap } from "~/api/client";
import { useCatalog } from "~/api/queries";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine } from "~/components/Section";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import { useCan } from "~/lib/access";
import type { ModelsSearch } from "~/lib/modelsSearch";
import { bytes } from "~/lib/time";
import {
    CLEARED,
    FIT_ORDER,
    FilterPanel,
    Option,
    activeFilters,
    bestFit,
    fitsPatch,
    latestOnly,
    latestPatch,
    licenceUseLabel,
    matches,
    readFilters,
} from "./DiscoverFilters";
import { cancelJob, useModelsRefresh } from "./dialogs";

const FIT_LABELS: Record<FitInfo["level"], string> = {
    fits: "Fits",
    limited: "Tight",
    insufficient: "Too big",
    unknown: "Not checked",
};
export const FIT_TONES: Record<FitInfo["level"], Tone> = {
    fits: "success",
    limited: "warning",
    insufficient: "destructive",
    unknown: "neutral",
};
export function fitLabel(fit: FitInfo): string {
    const enoughMemory = fit.available_bytes !== null && fit.needed_bytes <= fit.available_bytes;
    return fit.level === "insufficient" && enoughMemory
        ? "Not supported here"
        : FIT_LABELS[fit.level];
}

export function Fit({ fit }: { fit: FitInfo }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="rounded-sm text-left">
                    <StatusText tone={FIT_TONES[fit.level]}>{fitLabel(fit)}</StatusText>
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-80">
                <span className="flex flex-col gap-0.5">
                    {fit.available_bytes !== null && (
                        <span className="tabular-nums">
                            {`Needs ${bytes(fit.needed_bytes)} of ${bytes(fit.available_bytes)}`}
                        </span>
                    )}
                    <span>{fit.basis}</span>
                </span>
            </TooltipContent>
        </Tooltip>
    );
}

export function AccessSteps({
    entry,
    catalog,
}: { entry?: CatalogEntry; catalog: CatalogResponse }) {
    const page = entry ? `${catalog.endpoint}/${entry.repo}` : catalog.endpoint;
    return (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>Create or sign in to an account on {catalog.endpoint.replace("https://", "")}.</li>
            <li>
                Open{" "}
                <a
                    href={page}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                >
                    the model page
                    <ExternalLink className="ml-0.5 inline size-3.5" />
                </a>{" "}
                and accept the licence; access is usually granted within minutes.
            </li>
            <li>
                Set <span className="font-mono">HF_TOKEN</span> on the minibrain server and restart
                it.{" "}
                {catalog.token_configured ? (
                    <StatusText tone="success">Token configured</StatusText>
                ) : (
                    <StatusText tone="warning">No token configured</StatusText>
                )}
            </li>
        </ol>
    );
}

export type Actions = {
    download: (entry: CatalogEntry) => void;
    requirements: (entry: CatalogEntry) => void;
    open: (path: string) => void;
    refresh: () => Promise<unknown>;
    online: boolean;
    tokenConfigured: boolean;
};

export function EntryAction({ entry, on }: { entry: CatalogEntry; on: Actions }) {
    const available = entry.added.find((added) => added.availability.state === "available");
    const moving = entry.added.find((added) =>
        ["downloading", "importing"].includes(added.availability.state),
    );
    const failed = entry.added.find((added) => added.availability.state === "not_downloaded");
    const retry = useMutation({
        mutationFn: (key: string) =>
            unwrap(api.POST("/api/models/base/{key}/retry", { params: { path: { key } } })),
        onSuccess: on.refresh,
    });
    const can = useCan();
    if (!can.build) {
        return null;
    }
    if (moving) {
        const progress = moving.availability.progress;
        return (
            <div className="flex items-center justify-end gap-2">
                <div className="flex flex-col items-end gap-1">
                    <span className="text-sm tabular-nums text-muted-foreground">
                        {moving.availability.state === "importing" ? "Importing" : "Downloading"}
                        {progress !== null && progress !== undefined
                            ? ` · ${Math.round(progress * 100)}%`
                            : "…"}
                    </span>
                    <ProgressBar value={progress} label={`${entry.name} download`} />
                </div>
                {moving.availability.job_id !== null &&
                    moving.availability.job_id !== undefined && (
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={() =>
                                cancelJob(moving.availability.job_id ?? 0).then(on.refresh)
                            }
                        >
                            Cancel
                        </Button>
                    )}
            </div>
        );
    }
    if (available) {
        return (
            <div className="flex justify-end">
                <Button size="xs" onClick={() => on.download(entry)}>
                    <Plus />
                    Add model
                </Button>
            </div>
        );
    }
    if (!can.admin) {
        return null;
    }
    if (failed && on.online) {
        return (
            <div className="flex flex-col items-end gap-1">
                <Button
                    variant="outline"
                    size="xs"
                    onClick={() => retry.mutate(failed.key)}
                    disabled={retry.isPending}
                >
                    Retry
                </Button>
                {failed.error && (
                    <span className="max-w-56 truncate text-sm text-destructive">
                        {failed.error}
                    </span>
                )}
            </div>
        );
    }
    if (entry.gated && !on.tokenConfigured) {
        return (
            <div className="flex justify-end">
                <Button size="xs" onClick={() => on.requirements(entry)}>
                    <KeyRound />
                    Get access
                </Button>
            </div>
        );
    }
    const label = (
        <>
            <Plus />
            Add model
        </>
    );
    return (
        <div className="flex justify-end gap-1">
            {on.online ? (
                <Button size="xs" onClick={() => on.download(entry)}>
                    {label}
                </Button>
            ) : (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span>
                            <Button size="xs" disabled>
                                {label}
                            </Button>
                        </span>
                    </TooltipTrigger>
                    <TooltipContent>
                        Downloads need a connection. Import model works offline.
                    </TooltipContent>
                </Tooltip>
            )}
        </div>
    );
}

function AddedStatus({ entry }: { entry: CatalogEntry }) {
    const states = entry.added.map((added) => added.availability);
    const moving = states.find((state) => ["downloading", "importing"].includes(state.state));
    if (moving) {
        const progress = moving.progress;
        return (
            <StatusText tone="info" className="text-sm tabular-nums">
                {moving.state === "importing" ? "Importing" : "Downloading"}
                {progress !== null && progress !== undefined
                    ? ` · ${Math.round(progress * 100)}%`
                    : "…"}
            </StatusText>
        );
    }
    const available = entry.added.find((added) => added.availability.state === "available");
    if (available) {
        return (
            <Link href={`/models/base/${available.key}`} className="w-fit hover:underline">
                <StatusText tone="success" className="text-sm">
                    On this install
                </StatusText>
            </Link>
        );
    }
    if (states.some((state) => state.state === "not_downloaded")) {
        return (
            <StatusText tone="destructive" className="text-sm">
                Download failed
            </StatusText>
        );
    }
    if (states.some((state) => state.state === "evicted")) {
        return (
            <StatusText tone="neutral" className="text-sm">
                Removed to free space
            </StatusText>
        );
    }
    return null;
}

function recommendedOrder(entry: CatalogEntry): number[] {
    const fitRank = FIT_ORDER.indexOf(bestFit(entry).fit.level);
    return [
        fitRank < 0 ? 9 : fitRank,
        entry.recommended ? 0 : 1,
        entry.superseded_by ? 1 : 0,
        -entry.popularity,
    ];
}

function byRecommended(left: CatalogEntry, right: CatalogEntry): number {
    const a = recommendedOrder(left);
    const b = recommendedOrder(right);
    const index = a.findIndex((value, position) => value !== b[position]);
    return index < 0 ? 0 : a[index] - b[index];
}

function smallest(entry: CatalogEntry): number {
    return Math.min(...entry.variants.map((variant) => variant.size_bytes ?? Number.MAX_VALUE));
}

const SORTS: Record<
    string,
    { label: string; compare: (a: CatalogEntry, b: CatalogEntry) => number }
> = {
    recommended: { label: "Recommended", compare: byRecommended },
    popular: { label: "Most popular", compare: (a, b) => b.popularity - a.popularity },
    small: { label: "Smallest first", compare: (a, b) => smallest(a) - smallest(b) },
    large: { label: "Largest first", compare: (a, b) => smallest(b) - smallest(a) },
    name: { label: "Name", compare: (a, b) => a.name.localeCompare(b.name) },
};

function SortSelect({ value, onSort }: { value: string; onSort: (value: string) => void }) {
    return (
        <Select value={value} onValueChange={(next) => onSort(String(next))}>
            <SelectTrigger aria-label="Sort models" className="w-44">
                <ArrowUpDown aria-hidden="true" className="size-4 text-muted-foreground" />
                <SelectValue className="flex-1 text-left" />
            </SelectTrigger>
            <SelectContent>
                {Object.entries(SORTS).map(([key, sort]) => (
                    <SelectItem key={key} value={key}>
                        {sort.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function smallestVariant(entry: CatalogEntry): number {
    return Math.min(...entry.variants.map((variant) => variant.size_bytes));
}

const DOWNLOADS = new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
});

export function parameters(entry: CatalogEntry): string {
    return `${entry.params_b.toFixed(1)}B${entry.moe ? " MoE" : ""}`;
}

export function addModelHref(entry: CatalogEntry, variant?: string): string {
    const query = new URLSearchParams({ model: entry.id });
    if (variant) {
        query.set("variant", variant);
    }
    return `/models/new?${query.toString()}`;
}

export function discoverHref(entry: CatalogEntry, pool?: string): string {
    const query = pool ? `?pool=${encodeURIComponent(pool)}` : "";
    return `/discover/${encodeURIComponent(entry.id)}${query}`;
}

export const COMPARE_MAX = 6;

export function compareHref(ids: string[], pool?: string, onlyDifferences = false): string {
    const parts = [`ids=${ids.map(encodeURIComponent).join(",")}`];
    if (onlyDifferences) {
        parts.push("only=differences");
    }
    if (pool) {
        parts.push(`pool=${encodeURIComponent(pool)}`);
    }
    return `/discover/compare?${parts.join("&")}`;
}

const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;

const HIDDEN_COLUMNS = [
    "size",
    "newer",
    "publisher",
    "tasks",
    "downloads",
    "architecture",
    "generation",
    "repo",
];

function columns(names: Map<string, string>): ColumnDef<CatalogEntry, unknown>[] {
    return [
        {
            id: "model",
            header: "Model",
            enableHiding: false,
            accessorFn: (entry) => entry.name.toLowerCase(),
            cell: ({ row }) => (
                <div className="flex w-64 items-center gap-2.5">
                    <PublisherLogo
                        publisher={row.original.provider}
                        name={row.original.name}
                        size="sm"
                    />
                    <div className="flex min-w-0 flex-col">
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                            <span className="min-w-0 truncate text-base font-semibold">
                                {row.original.name}
                            </span>
                            {row.original.recommended && (
                                <Badge variant="outline">Recommended</Badge>
                            )}
                        </span>
                        <AddedStatus entry={row.original} />
                        <DataGridDetail
                            className="line-clamp-2 whitespace-normal text-sm text-muted-foreground"
                            title={row.original.description}
                        >
                            {row.original.description}
                        </DataGridDetail>
                    </div>
                </div>
            ),
        },
        {
            id: "newer",
            header: "Newer version",
            accessorFn: (entry) =>
                entry.superseded_by ? (names.get(entry.superseded_by) ?? entry.superseded_by) : "",
            cell: ({ row }) =>
                row.original.superseded_by
                    ? (names.get(row.original.superseded_by) ?? row.original.superseded_by)
                    : muted("—"),
        },
        { id: "publisher", header: "Publisher", accessorFn: (entry) => entry.provider },
        {
            id: "parameters",
            header: "Parameters",
            accessorFn: (entry) => entry.params_b,
            cell: ({ row }) => parameters(row.original),
        },
        {
            id: "size",
            header: "Download",
            accessorFn: smallestVariant,
            cell: ({ row }) =>
                row.original.variants.length > 1
                    ? `From ${bytes(smallestVariant(row.original))}`
                    : bytes(row.original.variants[0]?.size_bytes),
        },
        {
            id: "fit",
            header: "Fits here",
            meta: {
                info: "Estimated from the best-fitting variant's memory needs and this machine's memory.",
            },
            accessorFn: (entry) => FIT_ORDER.indexOf(bestFit(entry).fit.level),
            cell: ({ row }) => <Fit fit={bestFit(row.original).fit} />,
        },
        {
            id: "licence",
            header: "Licence",
            accessorFn: (entry) => entry.license_name,
            cell: ({ row }) => (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span className="flex max-w-48 flex-col">
                            <span className="truncate">{row.original.license_name}</span>
                            <DataGridDetail className="truncate text-sm text-muted-foreground">
                                {`Commercial use: ${licenceUseLabel(row.original.license_use).toLowerCase()}`}
                            </DataGridDetail>
                        </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-72">
                        {row.original.license_summary}
                    </TooltipContent>
                </Tooltip>
            ),
        },
        {
            id: "tasks",
            header: "Tasks",
            accessorFn: (entry) => entry.capabilities.join(", "),
        },
        {
            id: "downloads",
            header: "Downloads",
            accessorFn: (entry) => entry.popularity,
            cell: ({ row }) => DOWNLOADS.format(row.original.popularity),
        },
        { id: "architecture", header: "Architecture", accessorFn: (entry) => entry.architecture },
        { id: "generation", header: "Generation", accessorFn: (entry) => entry.generation },
        {
            id: "repo",
            header: "Repository",
            accessorFn: (entry) => entry.repo,
            cell: ({ row }) => <span className="font-mono">{row.original.repo}</span>,
        },
    ];
}

function PoolSelect({
    catalog,
    onPool,
}: {
    catalog: CatalogResponse;
    onPool: (pool: string) => void;
}) {
    if (catalog.pools.length < 2) {
        return null;
    }
    return (
        <Select value={catalog.pool} onValueChange={(next) => onPool(String(next))}>
            <SelectTrigger aria-label="Compute pool" className="w-full">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {catalog.pools.map((pool) => (
                    <SelectItem key={pool.name} value={pool.name}>
                        {`Pool: ${pool.label}`}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

export function poolPhrase(catalog: CatalogResponse): string {
    return catalog.pool === "local" ? "this machine" : `pool ${catalog.pool}`;
}

function fitHint(catalog: CatalogResponse): string {
    const phrase = poolPhrase(catalog);
    if (!catalog.hardware.known) {
        return `Unavailable: the memory of ${phrase} is unknown, so fit is not checked.`;
    }
    return `Shows models that fit, or fit with limited headroom, on ${phrase}: ${bytes(catalog.hardware.memory_bytes)} ${catalog.hardware.memory_label}.`;
}

const FITTING: FitInfo["level"][] = ["fits", "limited"];

function FitsOption({
    catalog,
    checked,
    count,
    onChecked,
    onPool,
}: {
    catalog: CatalogResponse;
    checked: boolean;
    count: number;
    onChecked: (checked: boolean) => void;
    onPool: (pool: string) => void;
}) {
    const known = catalog.hardware.known;
    return (
        <>
            <Option
                checked={known && checked}
                disabled={!known}
                onChange={onChecked}
                count={known ? count : undefined}
            >
                {`Fits ${poolPhrase(catalog)}`}
                <InfoTip label="About hardware fit">{fitHint(catalog)}</InfoTip>
            </Option>
            <PoolSelect catalog={catalog} onPool={onPool} />
        </>
    );
}

function compareHint(count: number): ReactNode {
    if (count < 2) {
        return (
            <span className="text-sm text-muted-foreground">
                Select at least 2 models to compare.
            </span>
        );
    }
    if (count > COMPARE_MAX) {
        return (
            <StatusText tone="warning" className="text-sm whitespace-normal">
                {`Compare takes up to ${COMPARE_MAX} models; deselect ${count - COMPARE_MAX}.`}
            </StatusText>
        );
    }
    return null;
}

function SelectionBar({
    count,
    onCompare,
    onClear,
    className,
}: {
    count: number;
    onCompare: () => void;
    onClear: () => void;
    className?: string;
}) {
    const hintId = useId();
    const hint = compareHint(count);
    return (
        <div className={cn("flex flex-wrap items-center gap-2", className)}>
            <span className="text-sm font-medium tabular-nums">{`${count} selected`}</span>
            <Button variant="outline" onClick={onClear}>
                <X />
                Clear selection
            </Button>
            <div className="ml-auto flex flex-wrap items-center gap-2">
                {hint && <span id={hintId}>{hint}</span>}
                <Button
                    disabled={hint !== null}
                    onClick={onCompare}
                    aria-describedby={hint ? hintId : undefined}
                >
                    Compare
                </Button>
            </div>
        </div>
    );
}

const SKELETON_GROUPS: { id: string; title?: string; rows: number }[] = [
    { id: "toggles", rows: 2 },
    { id: "task", title: "Task", rows: 5 },
    { id: "size", title: "Size", rows: 4 },
    { id: "publisher", title: "Publisher", rows: 6 },
    { id: "commercial", title: "Commercial use", rows: 3 },
    { id: "licence", title: "Licence", rows: 4 },
];

const SKELETON_WIDTHS = ["70%", "52%", "64%", "46%", "58%", "40%"];

function skeletonRows(id: string, rows: number): string[] {
    return SKELETON_WIDTHS.slice(0, rows).map((width) => `${id}:${width}`);
}

function FilterSkeleton() {
    return (
        <div className="flex flex-col divide-y rounded-md border bg-card">
            <div className="flex h-10 items-center px-3">
                <span className="text-sm font-semibold">Filters</span>
            </div>
            {SKELETON_GROUPS.map((group) => (
                <div key={group.id} className="flex flex-col px-3 py-3">
                    {group.title && (
                        <span className="mb-2 text-sm font-semibold">{group.title}</span>
                    )}
                    {skeletonRows(group.id, group.rows).map((row) => (
                        <div key={row} className="flex h-[26px] items-center gap-2">
                            <Skeleton className="size-4 rounded-sm" />
                            <Skeleton className="h-3.5" style={{ width: row.split(":")[1] }} />
                            <Skeleton className="ml-auto h-3.5 w-5" />
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}

function noSelection() {}

function DiscoverSkeleton({
    columns,
    search,
    update,
}: {
    columns: ColumnDef<CatalogEntry, unknown>[];
    search: ModelsSearch;
    update: (patch: ModelsSearch) => void;
}) {
    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-start gap-4">
                <aside className="hidden w-56 shrink-0 min-[1400px]:block">
                    <FilterSkeleton />
                </aside>
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <SearchInput
                            aria-label="Search supported models"
                            placeholder="Search supported models"
                            value={search.q ?? ""}
                            onValueChange={(q) => update({ q })}
                            className="w-64"
                        />
                        <Skeleton className="h-8 w-28 min-[1400px]:hidden" />
                        <span className="w-32 text-sm text-muted-foreground">Loading…</span>
                        <Skeleton className="ml-auto h-8 w-44" />
                    </div>
                    <DataGrid
                        columns={columns}
                        rows={[]}
                        loading
                        loadingRows={12}
                        loadingLines={3}
                        storageKey="minibrain.discover.columns"
                        columnPicker
                        hiddenColumns={HIDDEN_COLUMNS}
                        selectedIds={[]}
                        onSelectedIdsChange={noSelection}
                        minWidth="min-w-[840px]"
                    />
                </div>
            </div>
        </div>
    );
}

function idList(value: string | undefined): string[] {
    return value ? value.split(",").filter(Boolean) : [];
}

export function Discover({
    search,
    update,
    onImport,
}: {
    search: ModelsSearch;
    update: (patch: ModelsSearch) => void;
    onImport: () => void;
}) {
    const router = useRouter();
    const refresh = useModelsRefresh();
    const catalog = useCatalog(search.pool);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const data = catalog.data;
    const on: Actions = useMemo(
        () => ({
            download: (entry) => router.history.push(addModelHref(entry)),
            requirements: (entry) => router.history.push(discoverHref(entry, search.pool)),
            open: (path) => router.history.push(path),
            refresh,
            online: data?.online !== false,
            tokenConfigured: Boolean(data?.token_configured),
        }),
        [router, refresh, data?.online, data?.token_configured, search.pool],
    );
    const names = useMemo(
        () => new Map((data?.entries ?? []).map((entry) => [entry.id, entry.name])),
        [data?.entries],
    );
    const tableColumns = useMemo(() => columns(names), [names]);
    const selected = useMemo(() => idList(search.selected), [search.selected]);
    if (catalog.isLoading) {
        return <DiscoverSkeleton columns={tableColumns} search={search} update={update} />;
    }
    if (catalog.error || !data) {
        return (
            <div className="flex items-center gap-2">
                <ErrorLine error={catalog.error} />
                <Button variant="outline" size="sm" onClick={() => catalog.refetch()}>
                    Try again
                </Button>
            </div>
        );
    }
    const filters = readFilters(search, data.hardware.known);
    const needsAccess = filters.access.includes("needs-access");
    const sort = SORTS[search.sort ?? ""] ? (search.sort ?? "recommended") : "recommended";
    const visible = data.entries.filter((entry) => matches(entry, filters));
    visible.sort(SORTS[sort].compare);
    const active = activeFilters(filters);
    const selecting = selected.length > 0;
    const select = (ids: string[]) => update({ selected: ids.join(",") });
    const toggles = (
        <>
            <FitsOption
                catalog={data}
                checked={filters.fit.length > 0}
                count={
                    data.entries.filter(
                        (entry) =>
                            matches(entry, filters, "fit") &&
                            FITTING.includes(bestFit(entry).fit.level),
                    ).length
                }
                onChecked={(checked) => update(fitsPatch(checked))}
                onPool={(pool) => update({ pool: pool === "local" ? "" : pool })}
            />
            <Option
                checked={latestOnly(filters)}
                onChange={(checked) => update(latestPatch(checked))}
                count={
                    data.entries.filter(
                        (entry) => matches(entry, filters, "latest") && !entry.superseded_by,
                    ).length
                }
            >
                Latest generation only
            </Option>
        </>
    );
    const panel = (
        <FilterPanel entries={data.entries} filters={filters} update={update} toggles={toggles} />
    );
    const empty: ReactNode = (
        <div className="flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground">No supported models match these filters.</p>
            {(active > 0 || filters.q) && (
                <Button variant="outline" size="sm" onClick={() => update(CLEARED)}>
                    Clear filters
                </Button>
            )}
        </div>
    );
    return (
        <div className="flex flex-col gap-3">
            {data.online === false && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 px-3 py-2 text-sm">
                    <StatusText tone="warning">
                        {data.offline_forced ? "Offline mode" : `No connection to ${data.endpoint}`}
                    </StatusText>
                    <span className="text-muted-foreground">
                        Downloads need a connection. Import model keeps working; imported files stay
                        on your infrastructure.
                    </span>
                    <Button variant="outline" size="xs" onClick={onImport} className="ml-auto">
                        Import model
                    </Button>
                </div>
            )}
            <div className="flex items-start gap-4">
                <aside className="sticky top-4 hidden max-h-[calc(100dvh-2rem)] w-56 shrink-0 overflow-y-auto min-[1400px]:block">
                    {panel}
                </aside>
                <div className="flex min-w-0 flex-1 flex-col gap-3">
                    <div className="grid">
                        <div
                            className={cn(
                                "col-start-1 row-start-1 flex flex-wrap items-center gap-2",
                                selecting && "invisible",
                            )}
                        >
                            <SearchInput
                                aria-label="Search supported models"
                                placeholder="Search supported models"
                                value={search.q ?? ""}
                                onValueChange={(q) => update({ q })}
                                className="w-64"
                            />
                            <Button
                                variant="outline"
                                className="w-28 min-[1400px]:hidden"
                                onClick={() => setFiltersOpen(true)}
                            >
                                {active > 0 ? `Filters (${active})` : "Filters"}
                            </Button>
                            <span className="w-32 text-sm text-muted-foreground tabular-nums">
                                {`${visible.length} of ${data.entries.length} models`}
                            </span>
                            <div className="ml-auto">
                                <SortSelect
                                    value={sort}
                                    onSort={(next) =>
                                        update({ sort: next === "recommended" ? "" : next })
                                    }
                                />
                            </div>
                        </div>
                        <SelectionBar
                            className={cn("col-start-1 row-start-1", !selecting && "invisible")}
                            count={selected.length}
                            onCompare={() =>
                                router.history.push(compareHref(selected, search.pool))
                            }
                            onClear={() => select([])}
                        />
                    </div>
                    <DataGrid
                        columns={tableColumns}
                        rows={visible}
                        getRowId={(entry) => entry.id}
                        storageKey="minibrain.discover.columns"
                        onOpen={(entry) => router.history.push(discoverHref(entry, search.pool))}
                        columnPicker
                        hiddenColumns={HIDDEN_COLUMNS}
                        rowLabel={(entry) => `${entry.name} by ${entry.provider}`}
                        selectedIds={selected}
                        onSelectedIdsChange={select}
                        rowActions={(entry) => <EntryAction entry={entry} on={on} />}
                        empty={empty}
                        minWidth="min-w-[840px]"
                    />
                    {needsAccess && (
                        <div className="flex flex-col gap-2 rounded-md border px-3 py-2">
                            <p className="text-sm font-semibold">
                                Models that need access from their publisher first
                            </p>
                            <AccessSteps catalog={data} />
                        </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                        Models run on your infrastructure. Offline?{" "}
                        <button
                            type="button"
                            onClick={onImport}
                            className="text-primary hover:underline"
                        >
                            Import model files
                        </button>
                        .
                    </p>
                </div>
            </div>
            <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
                <DialogContent className="max-h-[85vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>Filters</DialogTitle>
                        <DialogDescription>{`${visible.length} of ${data.entries.length} models match.`}</DialogDescription>
                    </DialogHeader>
                    {panel}
                </DialogContent>
            </Dialog>
            <Link href="/models" className="sr-only">
                Models
            </Link>
        </div>
    );
}
