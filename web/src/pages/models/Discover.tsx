import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";
import {
    Badge,
    Button,
    Checkbox,
    DataGrid,
    DataGridDetail,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Link,
    RadioGroup,
    RadioGroupItem,
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
} from "obp-ui";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { type CatalogEntry, type CatalogResponse, type FitInfo, api, unwrap } from "~/api/client";
import { useCatalog } from "~/api/queries";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine } from "~/components/Section";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import type { ModelsSearch } from "~/lib/modelsSearch";
import { bytes } from "~/lib/time";
import {
    CLEARED,
    FIT_ORDER,
    FilterChips,
    FilterPanel,
    activeFilters,
    bestFit,
    matches,
    readFilters,
} from "./DiscoverFilters";
import { cancelJob, useModelsRefresh } from "./dialogs";

const RESERVE_BYTES = 1024 ** 3;
const FIT_LABELS: Record<FitInfo["level"], string> = {
    fits: "Estimated fit",
    limited: "Limited headroom",
    insufficient: "Insufficient memory",
    unknown: "Compatibility not checked",
};
const FIT_TONES: Record<FitInfo["level"], Tone> = {
    fits: "success",
    limited: "warning",
    insufficient: "destructive",
    unknown: "neutral",
};
function fitLabel(fit: FitInfo): string {
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
            <TooltipContent className="max-w-80">{fit.basis}</TooltipContent>
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

export function DownloadDialog({
    entry,
    catalog,
    onOpenChange,
    preferred,
}: {
    entry: CatalogEntry | null;
    catalog: CatalogResponse;
    onOpenChange: (open: boolean) => void;
    preferred?: string;
}) {
    const refresh = useModelsRefresh();
    const [variantId, setVariantId] = useState("");
    const [accepted, setAccepted] = useState(false);
    useEffect(() => {
        if (entry) {
            setVariantId(preferred ?? bestFit(entry).id);
            setAccepted(false);
        }
    }, [entry, preferred]);
    const variant = entry?.variants.find((item) => item.id === variantId);
    const free = catalog.store_free_bytes;
    const tooBig =
        variant !== undefined &&
        free !== null &&
        free !== undefined &&
        variant.size_bytes + RESERVE_BYTES > free;
    const start = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/catalog/{catalog_id}/download", {
                    params: { path: { catalog_id: entry?.id ?? "" } },
                    body: { variant: variantId, accept_license: accepted },
                }),
            ),
        onSuccess: async () => {
            await refresh();
            onOpenChange(false);
        },
    });
    if (!entry) {
        return null;
    }
    const blocked = entry.gated && !catalog.token_configured;
    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>Download {entry.name}</DialogTitle>
                    <DialogDescription>
                        Downloads in the background into managed storage and is checked against the
                        published SHA-256 sums. Nothing is loaded or deployed until you choose to.
                    </DialogDescription>
                </DialogHeader>
                {entry.variants.length > 1 && (
                    <RadioGroup
                        value={variantId}
                        onValueChange={(value) => setVariantId(String(value))}
                    >
                        {entry.variants.map((item) => (
                            <label
                                key={item.id}
                                htmlFor={`variant-${item.id}`}
                                className="flex cursor-pointer items-start gap-3 rounded-md border p-3"
                            >
                                <RadioGroupItem
                                    id={`variant-${item.id}`}
                                    value={item.id}
                                    className="mt-0.5"
                                />
                                <span className="flex flex-1 flex-col gap-0.5">
                                    <span className="font-semibold">
                                        {item.label} · {bytes(item.size_bytes)}
                                    </span>
                                    <span className="text-sm text-muted-foreground">
                                        Runs on {item.runtimes.join(", ")}. {item.fit.basis}
                                    </span>
                                    <StatusText tone={FIT_TONES[item.fit.level]}>
                                        {fitLabel(item.fit)}
                                    </StatusText>
                                </span>
                            </label>
                        ))}
                    </RadioGroup>
                )}
                {variant && entry.variants.length === 1 && (
                    <div className="flex flex-col gap-1 rounded-md border p-3 text-sm">
                        <span className="font-semibold">
                            {variant.label} · {bytes(variant.size_bytes)} · {variant.files} files
                        </span>
                        <span className="text-muted-foreground">{variant.fit.basis}</span>
                        <StatusText tone={FIT_TONES[variant.fit.level]}>
                            {fitLabel(variant.fit)}
                        </StatusText>
                    </div>
                )}
                {variant?.fit.level === "insufficient" && (
                    <p className="text-sm text-warning">
                        {`This variant is unlikely to run on ${poolPhrase(catalog)}. You can still download it for another pool.`}
                    </p>
                )}
                <div className="flex flex-col gap-2 rounded-md border p-3">
                    <p className="text-sm font-semibold">
                        {entry.license_name}{" "}
                        <a
                            href={entry.license_url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-normal text-primary hover:underline"
                        >
                            Read the licence
                            <ExternalLink className="ml-0.5 inline size-3.5" />
                        </a>
                    </p>
                    <p className="text-sm text-muted-foreground">{entry.license_summary}</p>
                    {entry.gated && <AccessSteps entry={entry} catalog={catalog} />}
                    <div className="flex items-center gap-2">
                        <Checkbox
                            id="accept-license"
                            checked={accepted}
                            onCheckedChange={(checked) => setAccepted(checked === true)}
                        />
                        <Label htmlFor="accept-license">
                            I accept the {entry.license_name} for this install
                        </Label>
                    </div>
                </div>
                {tooBig && variant && (
                    <p className="text-sm text-destructive">
                        {`Needs ${bytes(variant.size_bytes)}; ${bytes(catalog.store_free_bytes)} free on the disk that holds models. Delete unused models or free up space.`}
                    </p>
                )}
                <ErrorLine error={start.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        onClick={() => start.mutate()}
                        disabled={!accepted || blocked || tooBig || start.isPending}
                    >
                        {variant ? `Download ${bytes(variant.size_bytes)}` : "Download"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
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
                <Button
                    variant="outline"
                    size="xs"
                    onClick={() => on.open(`/models/base/${available.key}`)}
                >
                    View model
                </Button>
            </div>
        );
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
                <Button variant="outline" size="xs" onClick={() => on.requirements(entry)}>
                    How to get access
                </Button>
            </div>
        );
    }
    const label = entry.variants.length > 1 ? "Choose variant" : "Download";
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
            <SelectTrigger aria-label="Sort models" size="sm" className="w-auto min-w-40">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {Object.entries(SORTS).map(([key, sort]) => (
                    <SelectItem key={key} value={key}>
                        {`Sort: ${sort.label}`}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function AddFromHubDialog({
    open,
    onOpenChange,
    onAdded,
    endpoint,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAdded: (entry: CatalogEntry) => void;
    endpoint: string;
}) {
    const refresh = useModelsRefresh();
    const [repo, setRepo] = useState("");
    const add = useMutation({
        mutationFn: () => unwrap(api.POST("/api/catalog/hub", { body: { repo: repo.trim() } })),
        onSuccess: async (entry) => {
            await refresh();
            setRepo("");
            onOpenChange(false);
            onAdded(entry);
        },
    });
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (repo.trim()) {
            add.mutate();
        }
    };
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <form onSubmit={submit} className="flex flex-col gap-4">
                    <DialogHeader>
                        <DialogTitle>Add from Hugging Face</DialogTitle>
                        <DialogDescription>
                            {`Find any model on ${endpoint}, then paste its link or id. minibrain reads that one model's details now and adds it to Discover as untested unless our engines support its architecture.`}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="hub-repo">Model link or id</Label>
                        <Input
                            id="hub-repo"
                            value={repo}
                            onChange={(event) => setRepo(event.target.value)}
                            placeholder="Qwen/Qwen3-8B"
                            autoFocus
                        />
                    </div>
                    <ErrorLine error={add.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!repo.trim() || add.isPending}>
                            {add.isPending ? "Checking…" : "Add model"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
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

export function discoverHref(entry: CatalogEntry, pool?: string): string {
    const query = pool ? `?pool=${encodeURIComponent(pool)}` : "";
    return `/discover/${encodeURIComponent(entry.id)}${query}`;
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

function columns(on: Actions, names: Map<string, string>): ColumnDef<CatalogEntry, unknown>[] {
    return [
        {
            id: "model",
            header: "Model",
            enableHiding: false,
            accessorFn: (entry) => entry.name.toLowerCase(),
            cell: ({ row }) => (
                <div className="flex w-56 items-center gap-2.5">
                    <PublisherLogo
                        publisher={row.original.provider}
                        name={row.original.name}
                        size="sm"
                    />
                    <div className="flex min-w-0 flex-col">
                        <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-semibold">{row.original.name}</span>
                            {row.original.recommended && (
                                <Badge variant="outline">Recommended</Badge>
                            )}
                        </span>
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
            header: "Hardware fit",
            accessorFn: (entry) => FIT_ORDER.indexOf(bestFit(entry).fit.level),
            cell: ({ row }) => <Fit fit={bestFit(row.original).fit} />,
        },
        {
            id: "licence",
            header: "Licence",
            accessorFn: (entry) => entry.license_name,
            cell: ({ row }) => (
                <span className="block max-w-28 truncate" title={row.original.license_name}>
                    {row.original.license_name}
                </span>
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
        {
            id: "action",
            header: () => <span className="sr-only">Action</span>,
            enableSorting: false,
            enableHiding: false,
            cell: ({ row }) => <EntryAction entry={row.original} on={on} />,
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
            <SelectTrigger aria-label="Compute pool" size="sm" className="w-full">
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

const SKELETON_GROUPS = ["fit", "use", "download", "publisher"];

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
                <aside className="hidden w-52 shrink-0 min-[1400px]:block">
                    <div className="flex flex-col divide-y rounded-md border bg-card">
                        {SKELETON_GROUPS.map((group) => (
                            <div key={group} className="flex flex-col gap-2.5 px-3 py-3">
                                <Skeleton className="h-4 w-24" />
                                <Skeleton className="h-4 w-36" />
                                <Skeleton className="h-4 w-32" />
                            </div>
                        ))}
                    </div>
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
                        <Skeleton className="h-8 w-44" />
                        <span className="text-sm text-muted-foreground">
                            Loading the catalogue…
                        </span>
                    </div>
                    <DataGrid
                        columns={columns}
                        rows={[]}
                        loading
                        loadingRows={10}
                        storageKey="minibrain.discover.columns"
                        hiddenColumns={HIDDEN_COLUMNS}
                        minWidth="min-w-[840px]"
                    />
                </div>
            </div>
        </div>
    );
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
    const [downloading, setDownloading] = useState<CatalogEntry | null>(null);
    const [adding, setAdding] = useState(false);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const data = catalog.data;
    const on: Actions = useMemo(
        () => ({
            download: setDownloading,
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
    const tableColumns = useMemo(() => columns(on, names), [on, names]);
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
    const panel = (
        <FilterPanel
            entries={data.entries}
            filters={filters}
            update={update}
            fitsKnown={data.hardware.known}
            fitsHint={
                data.hardware.known
                    ? `For ${poolPhrase(data)}: ${bytes(data.hardware.memory_bytes)} ${data.hardware.memory_label}`
                    : `Not checked: the memory of ${poolPhrase(data)} is unknown.`
            }
            pool={
                <PoolSelect
                    catalog={data}
                    onPool={(pool) => update({ pool: pool === "local" ? "" : pool })}
                />
            }
        />
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
                    <div className="flex flex-wrap items-center gap-2">
                        <SearchInput
                            aria-label="Search supported models"
                            placeholder="Search supported models"
                            value={search.q ?? ""}
                            onValueChange={(q) => update({ q })}
                            className="w-64"
                        />
                        <Button
                            variant="outline"
                            className="min-[1400px]:hidden"
                            onClick={() => setFiltersOpen(true)}
                        >
                            {active > 0 ? `Filters (${active})` : "Filters"}
                        </Button>
                        <SortSelect
                            value={sort}
                            onSort={(next) => update({ sort: next === "recommended" ? "" : next })}
                        />
                        <span className="text-sm text-muted-foreground tabular-nums">
                            {`${visible.length} of ${data.entries.length} models`}
                        </span>
                        {data.hub_add_allowed && (
                            <Button
                                variant="outline"
                                className="ml-auto"
                                size="sm"
                                onClick={() => setAdding(true)}
                                disabled={data.offline_forced}
                            >
                                Add from Hugging Face
                            </Button>
                        )}
                    </div>
                    <FilterChips filters={filters} update={update} />
                    {needsAccess && (
                        <div className="flex flex-col gap-2 rounded-md border px-3 py-2">
                            <p className="text-sm font-semibold">
                                These models need access from their publisher first
                            </p>
                            <AccessSteps catalog={data} />
                        </div>
                    )}
                    <DataGrid
                        columns={tableColumns}
                        rows={visible}
                        storageKey="minibrain.discover.columns"
                        onOpen={(entry) => router.history.push(discoverHref(entry, search.pool))}
                        columnPicker
                        hiddenColumns={HIDDEN_COLUMNS}
                        rowLabel={(entry) => `${entry.name} by ${entry.provider}`}
                        empty={empty}
                        minWidth="min-w-[840px]"
                    />
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
            <AddFromHubDialog
                open={adding}
                onOpenChange={setAdding}
                endpoint={data.endpoint}
                onAdded={(entry) =>
                    update({ q: entry.repo, access: entry.gated ? "needs-access" : "" })
                }
            />
            <DownloadDialog
                entry={downloading}
                catalog={data}
                onOpenChange={(open) => !open && setDownloading(null)}
            />
            <Link href="/models" className="sr-only">
                Models
            </Link>
        </div>
    );
}
