import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ExternalLink, Search } from "lucide-react";
import {
    Badge,
    Button,
    Checkbox,
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
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
    type CatalogEntry,
    type CatalogResponse,
    type CatalogVariantInfo,
    type FitInfo,
    api,
    unwrap,
} from "~/api/client";
import { useCatalog } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { SortableTable } from "~/components/models/SortableTable";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import type { ModelsSearch } from "~/lib/modelsSearch";
import { bytes, relativeTime } from "~/lib/time";
import { cancelJob, useModelsRefresh } from "./dialogs";

const ANY = "all";
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
const FIT_ORDER: FitInfo["level"][] = ["fits", "limited", "unknown", "insufficient"];

function bestFit(entry: CatalogEntry): CatalogVariantInfo {
    return [...entry.variants].sort(
        (a, b) => FIT_ORDER.indexOf(a.fit.level) - FIT_ORDER.indexOf(b.fit.level),
    )[0];
}

function fitLabel(fit: FitInfo): string {
    const enoughMemory = fit.available_bytes !== null && fit.needed_bytes <= fit.available_bytes;
    return fit.level === "insufficient" && enoughMemory
        ? "Not supported here"
        : FIT_LABELS[fit.level];
}

function Fit({ fit }: { fit: FitInfo }) {
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

function AccessSteps({ entry, catalog }: { entry?: CatalogEntry; catalog: CatalogResponse }) {
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

function DownloadDialog({
    entry,
    catalog,
    onOpenChange,
}: {
    entry: CatalogEntry | null;
    catalog: CatalogResponse;
    onOpenChange: (open: boolean) => void;
}) {
    const refresh = useModelsRefresh();
    const [variantId, setVariantId] = useState("");
    const [accepted, setAccepted] = useState(false);
    useEffect(() => {
        if (entry) {
            setVariantId(bestFit(entry).id);
            setAccepted(false);
        }
    }, [entry]);
    const variant = entry?.variants.find((item) => item.id === variantId);
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
            <DialogContent className="max-w-xl">
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
                        This variant is unlikely to run on this machine. You can still download it
                        for another machine.
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
                <ErrorLine error={start.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        onClick={() => start.mutate()}
                        disabled={!accepted || blocked || start.isPending}
                    >
                        {variant ? `Download ${bytes(variant.size_bytes)}` : "Download"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function RequirementsDialog({
    open,
    entry,
    catalog,
    onOpenChange,
}: {
    open: boolean;
    entry: CatalogEntry | null;
    catalog: CatalogResponse;
    onOpenChange: (open: boolean) => void;
}) {
    const entries = entry ? [entry] : catalog.entries;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>
                        {entry ? `${entry.name} requirements` : "Requirements on this machine"}
                    </DialogTitle>
                    <DialogDescription>
                        Estimates for serving with the transformers runtime, from the weights' size;
                        real use also depends on context length and batch size.
                    </DialogDescription>
                </DialogHeader>
                <div className="max-h-96 overflow-y-auto">
                    <table className="w-full text-sm">
                        <thead className="text-left text-muted-foreground">
                            <tr>
                                <th className="py-1 pr-3 font-medium">Model</th>
                                <th className="py-1 pr-3 font-medium">Needs</th>
                                <th className="py-1 font-medium">Fit</th>
                            </tr>
                        </thead>
                        <tbody>
                            {entries.flatMap((item) =>
                                item.variants.map((variant) => (
                                    <tr key={variant.id} className="border-t align-top">
                                        <td className="py-1.5 pr-3">
                                            {item.name}
                                            <span className="block text-muted-foreground">
                                                {variant.label}
                                            </span>
                                        </td>
                                        <td className="py-1.5 pr-3 tabular-nums">
                                            {bytes(variant.fit.needed_bytes)}
                                        </td>
                                        <td className="py-1.5">
                                            <StatusText tone={FIT_TONES[variant.fit.level]}>
                                                {fitLabel(variant.fit)}
                                            </StatusText>
                                            <span className="block text-muted-foreground">
                                                {variant.fit.basis}
                                            </span>
                                        </td>
                                    </tr>
                                )),
                            )}
                        </tbody>
                    </table>
                </div>
                {entry?.gated && <AccessSteps entry={entry} catalog={catalog} />}
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

type Actions = {
    download: (entry: CatalogEntry) => void;
    requirements: (entry: CatalogEntry) => void;
    open: (path: string) => void;
    refresh: () => Promise<unknown>;
    online: boolean;
    tokenConfigured: boolean;
};

function EntryAction({ entry, on }: { entry: CatalogEntry; on: Actions }) {
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
                    View requirements
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
            <Button variant="ghost" size="xs" onClick={() => on.requirements(entry)}>
                Requirements
            </Button>
        </div>
    );
}

const SUPPORT_LABEL: Record<string, string> = {
    tested: "Tested by us",
    supported: "Supported architecture",
    untested: "Untested",
};

const TIERS = ["S", "M", "L", "XL"];

function recommendedOrder(entry: CatalogEntry): number[] {
    const fitRank = FIT_ORDER.indexOf(bestFit(entry).fit.level);
    const support = ["tested", "supported", "untested"].indexOf(entry.support);
    return [
        fitRank < 0 ? 9 : fitRank,
        support < 0 ? 9 : support,
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

function columns(on: Actions, names: Map<string, string>): ColumnDef<CatalogEntry, unknown>[] {
    return [
        {
            id: "model",
            header: "Model",
            accessorFn: (entry) => entry.name.toLowerCase(),
            cell: ({ row }) => (
                <div className="flex min-w-56 max-w-80 flex-col">
                    <span className="flex items-center gap-2">
                        <span className="font-semibold">{row.original.name}</span>
                        {row.original.recommended && (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button type="button" className="rounded-sm">
                                        <Badge variant="outline">Recommended</Badge>
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent>{row.original.recommendation}</TooltipContent>
                            </Tooltip>
                        )}
                    </span>
                    <span className="line-clamp-2 whitespace-normal text-sm text-muted-foreground">
                        {row.original.description}
                    </span>
                    <span className="text-sm tabular-nums text-muted-foreground">
                        {`${row.original.tier} · ${row.original.params_b.toFixed(1)}B · ${
                            SUPPORT_LABEL[row.original.support] ?? row.original.support
                        }`}
                    </span>
                    {row.original.superseded_by && (
                        <span className="text-sm text-muted-foreground">
                            {`Newer version available: ${
                                names.get(row.original.superseded_by) ?? row.original.superseded_by
                            }`}
                        </span>
                    )}
                </div>
            ),
        },
        { id: "provider", header: "Publisher", accessorFn: (entry) => entry.provider },
        {
            id: "capabilities",
            header: "Capabilities",
            enableSorting: false,
            cell: ({ row }) => (
                <span className="block min-w-40 max-w-56 whitespace-normal text-sm text-muted-foreground">
                    {row.original.capabilities.join(", ")}
                    {row.original.trainable ? ", Fine-tuning" : ""}
                </span>
            ),
        },
        {
            id: "size",
            header: "Download size",
            accessorFn: (entry) => entry.variants[0]?.size_bytes ?? 0,
            cell: ({ row }) =>
                row.original.variants.length > 1 ? (
                    <span className="text-muted-foreground">Varies</span>
                ) : (
                    <span className="tabular-nums">
                        {bytes(row.original.variants[0]?.size_bytes)}
                    </span>
                ),
        },
        {
            id: "fit",
            header: "Hardware fit",
            accessorFn: (entry) => FIT_ORDER.indexOf(bestFit(entry).fit.level),
            cell: ({ row }) => <Fit fit={bestFit(row.original).fit} />,
        },
        {
            id: "action",
            header: () => <span className="sr-only">Action</span>,
            enableSorting: false,
            cell: ({ row }) => <EntryAction entry={row.original} on={on} />,
        },
    ];
}

function FilterSelect({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: string | undefined;
    options: string[];
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
                {options.map((option) => (
                    <SelectItem key={option} value={option}>
                        {`${label}: ${option}`}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function MachineBar({
    catalog,
    onRequirements,
}: {
    catalog: CatalogResponse;
    onRequirements: () => void;
}) {
    const refresh = useModelsRefresh();
    const { hardware } = catalog;
    const sync = useMutation({
        mutationFn: () => unwrap(api.POST("/api/catalog/sync")),
        onSuccess: refresh,
    });
    const daily = useMutation({
        mutationFn: (value: boolean) =>
            unwrap(api.PUT("/api/catalog/settings", { body: { daily_sync: value } })),
    });
    const settings = useQuery({
        queryKey: ["catalog", "settings"],
        queryFn: () => unwrap(api.GET("/api/catalog/settings")),
    });
    const [dailyOn, setDailyOn] = useState<boolean | null>(null);
    const syncing = catalog.sync_job && ["queued", "running"].includes(catalog.sync_job.status);
    return (
        <div className="flex flex-col gap-2 rounded-md border bg-card px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-semibold">{hardware.machine}</span>
                <span className="text-muted-foreground">{hardware.accelerator}</span>
                {hardware.known ? (
                    <span className="tabular-nums text-muted-foreground">
                        {bytes(hardware.memory_bytes)} {hardware.memory_label}
                    </span>
                ) : (
                    <StatusText tone="neutral">Compatibility not checked</StatusText>
                )}
                <Button variant="ghost" size="xs" onClick={onRequirements}>
                    View requirements
                </Button>
                <span className="ml-auto flex items-center gap-3 text-muted-foreground">
                    <span>
                        {catalog.synced_at
                            ? `Checked ${relativeTime(catalog.synced_at)}`
                            : "Bundled catalogue"}
                        {catalog.sync_job?.status === "failed" ? " · last check failed" : ""}
                    </span>
                    <Button
                        variant="outline"
                        size="xs"
                        onClick={() => sync.mutate()}
                        disabled={catalog.online === false || Boolean(syncing) || sync.isPending}
                    >
                        {syncing ? "Checking…" : "Check for updates"}
                    </Button>
                    <span className="flex items-center gap-1.5">
                        <Switch
                            id="daily-sync"
                            checked={dailyOn ?? settings.data?.daily_sync ?? false}
                            onCheckedChange={(checked) => {
                                setDailyOn(checked);
                                daily.mutate(checked);
                            }}
                            disabled={catalog.offline_forced}
                        />
                        <Label htmlFor="daily-sync" className="text-sm text-muted-foreground">
                            Daily
                        </Label>
                    </span>
                </span>
            </div>
            <ErrorLine error={sync.error ?? daily.error} />
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
    const catalog = useCatalog();
    const [downloading, setDownloading] = useState<CatalogEntry | null>(null);
    const [requirements, setRequirements] = useState<{ entry: CatalogEntry | null } | null>(null);
    const data = catalog.data;
    const on: Actions = useMemo(
        () => ({
            download: setDownloading,
            requirements: (entry) => setRequirements({ entry }),
            open: (path) => router.history.push(path),
            refresh,
            online: data?.online !== false,
            tokenConfigured: Boolean(data?.token_configured),
        }),
        [router, refresh, data?.online, data?.token_configured],
    );
    const names = useMemo(
        () => new Map((data?.entries ?? []).map((entry) => [entry.id, entry.name])),
        [data?.entries],
    );
    const tableColumns = useMemo(() => columns(on, names), [on, names]);
    if (catalog.isLoading) {
        return <p className="text-sm text-muted-foreground">Loading the catalogue…</p>;
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
    const needsAccess = search.access === "needs-access";
    const fitsOnly = search.fits === "true" && data.hardware.known;
    const text = (search.q ?? "").trim().toLowerCase();
    const visible = data.entries.filter(
        (entry) =>
            entry.gated === needsAccess &&
            (!text ||
                `${entry.name} ${entry.description} ${entry.provider} ${entry.family} ${entry.architecture}`
                    .toLowerCase()
                    .includes(text)) &&
            (!search.task || entry.capabilities.includes(search.task)) &&
            (!search.tier || entry.tier === search.tier) &&
            (!search.provider || entry.provider === search.provider) &&
            (!fitsOnly ||
                entry.variants.some((variant) => ["fits", "limited"].includes(variant.fit.level))),
    );
    visible.sort(byRecommended);
    const tasks = [...new Set(data.entries.flatMap((entry) => entry.capabilities))].sort();
    const providers = [...new Set(data.entries.map((entry) => entry.provider))].sort();
    const gatedCount = data.entries.filter((entry) => entry.gated).length;
    const filtering = Boolean(
        search.q || search.task || search.provider || search.tier || fitsOnly,
    );
    const empty: ReactNode = (
        <div className="flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground">No supported models match these filters.</p>
            {filtering && (
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => update({ q: "", task: "", provider: "", tier: "", fits: "" })}
                >
                    Clear filters
                </Button>
            )}
        </div>
    );
    return (
        <div className="flex flex-col gap-3">
            <MachineBar catalog={data} onRequirements={() => setRequirements({ entry: null })} />
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
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        aria-label="Search supported models"
                        placeholder="Search supported models"
                        value={search.q ?? ""}
                        onChange={(event) => update({ q: event.target.value })}
                        className="h-8 w-64 pl-8"
                    />
                </div>
                <FilterSelect
                    label="Task"
                    value={search.task}
                    options={tasks}
                    onChange={(task) => update({ task })}
                />
                <FilterSelect
                    label="Publisher"
                    value={search.provider}
                    options={providers}
                    onChange={(provider) => update({ provider })}
                />
                <FilterSelect
                    label="Size"
                    value={search.tier}
                    options={TIERS}
                    onChange={(tier) => update({ tier })}
                />
                <Select
                    value={needsAccess ? "needs-access" : "ready"}
                    onValueChange={(value) =>
                        update({ access: value === "needs-access" ? "needs-access" : "" })
                    }
                >
                    <SelectTrigger aria-label="Access" className="w-auto min-w-36">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="ready">One-click download</SelectItem>
                        <SelectItem value="needs-access">{`Needs access (${gatedCount})`}</SelectItem>
                    </SelectContent>
                </Select>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span className="flex items-center gap-1.5">
                            <Switch
                                id="fits"
                                checked={fitsOnly}
                                disabled={!data.hardware.known}
                                onCheckedChange={(checked) =>
                                    update({ fits: checked ? "true" : "" })
                                }
                            />
                            <Label htmlFor="fits" className="text-sm text-muted-foreground">
                                Fits this machine
                            </Label>
                        </span>
                    </TooltipTrigger>
                    <TooltipContent>
                        {data.hardware.known
                            ? "Estimated from the weights' size against this machine's memory."
                            : "Compatibility not checked: this machine's memory is unknown."}
                    </TooltipContent>
                </Tooltip>
            </div>
            {needsAccess && (
                <div className="flex flex-col gap-2 rounded-md border px-3 py-2">
                    <p className="text-sm font-semibold">
                        These models need access from their publisher first
                    </p>
                    <AccessSteps catalog={data} />
                </div>
            )}
            <SortableTable
                columns={tableColumns}
                rows={visible}
                onOpen={(entry) => setRequirements({ entry })}
                rowLabel={(entry) => `${entry.name} by ${entry.provider}`}
                empty={empty}
                minWidth="min-w-[900px]"
            />
            <p className="text-sm text-muted-foreground">
                Models run on your infrastructure. Offline?{" "}
                <button type="button" onClick={onImport} className="text-primary hover:underline">
                    Import model files
                </button>
                .
            </p>
            <DownloadDialog
                entry={downloading}
                catalog={data}
                onOpenChange={(open) => !open && setDownloading(null)}
            />
            <RequirementsDialog
                open={requirements !== null}
                entry={requirements?.entry ?? null}
                catalog={data}
                onOpenChange={(open) => !open && setRequirements(null)}
            />
            <Link href="/models" className="sr-only">
                My models
            </Link>
        </div>
    );
}
