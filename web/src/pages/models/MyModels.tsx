import { useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Search } from "lucide-react";
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
import { type ReactNode, useMemo, useState } from "react";
import { type ModelRow, api, unwrap } from "~/api/client";
import { useModels } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { SortableTable } from "~/components/models/SortableTable";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import type { ModelsSearch } from "~/lib/modelsSearch";
import { bytes, exactTime, relativeTime } from "~/lib/time";
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
            <p>It shows in My models again.</p>
        ) : (
            <>
                <p>It is hidden from My models; use Show archived to find it again.</p>
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
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

function columns(on: Handlers): ColumnDef<ModelRow, unknown>[] {
    return [
        {
            id: "model",
            header: "Model",
            accessorFn: (row) => row.name.toLowerCase(),
            cell: ({ row }) => (
                <div className="flex min-w-56 max-w-80 flex-col">
                    <Link
                        href={detailHref(row.original)}
                        className="font-semibold text-foreground hover:underline"
                    >
                        {row.original.name}
                    </Link>
                    <span className="truncate text-sm text-muted-foreground">
                        {row.original.description ||
                            (row.original.kind === "custom"
                                ? `Classify model on ${row.original.base_model}`
                                : row.original.key)}
                    </span>
                </div>
            ),
        },
        {
            id: "type",
            header: "Type",
            accessorFn: (row) => row.kind,
            cell: ({ row }) => (row.original.kind === "base" ? "Base" : "Custom"),
        },
        {
            id: "availability",
            header: "Availability",
            accessorFn: (row) => STATE_ORDER.indexOf(row.availability.state),
            cell: ({ row }) => <Availability row={row.original} />,
        },
        {
            id: "activity",
            header: "Latest activity",
            accessorFn: (row) => row.activity.label,
            cell: ({ row }) => <Activity row={row.original} />,
        },
        {
            id: "deployment",
            header: "Deployment",
            accessorFn: (row) => row.deployment.state,
            cell: ({ row }) => <Deployment row={row.original} />,
        },
        {
            id: "updated",
            header: "Updated",
            accessorFn: (row) => row.updated_at,
            cell: ({ row }) => <Updated value={row.original.updated_at} />,
        },
        {
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }) => <RowActions row={row.original} on={on} />,
        },
    ];
}

function matches(row: ModelRow, search: ModelsSearch): boolean {
    const text = (search.q ?? "").trim().toLowerCase();
    if (text && !`${row.name} ${row.description}`.toLowerCase().includes(text)) {
        return false;
    }
    if (search.type && row.kind !== search.type) {
        return false;
    }
    if (search.availability && row.availability.state !== search.availability) {
        return false;
    }
    if (search.deployment === "deployed" && row.deployment.state === "not_deployed") {
        return false;
    }
    if (search.deployment === "not-deployed" && row.deployment.state !== "not_deployed") {
        return false;
    }
    return !search.tag || row.tags.includes(search.tag);
}

function FilterSelect({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: string | undefined;
    options: [string, string][];
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
                {options.map(([key, text]) => (
                    <SelectItem key={key} value={key}>
                        {`${label}: ${text}`}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function filterContext(search: ModelsSearch): string {
    const parts = [
        search.q && `“${search.q}”`,
        search.type && (search.type === "base" ? "Base" : "Custom"),
        search.availability && AVAILABILITY_LABELS[search.availability],
        search.deployment && (search.deployment === "deployed" ? "Deployed" : "Not deployed"),
        search.tag && `tag ${search.tag}`,
    ].filter(Boolean);
    return parts.join(", ");
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
    const tableColumns = useMemo(() => columns(on), [on]);
    const rows = models.data ?? [];
    const visible = rows.filter((row) => matches(row, search));
    const tags = [...new Set(rows.flatMap((row) => row.tags))].sort();
    const filtering = Boolean(
        search.q || search.type || search.availability || search.deployment || search.tag,
    );
    const clear = () => update({ q: "", type: "", availability: "", deployment: "", tag: "" });
    let empty: ReactNode;
    if (rows.length === 0 && !filtering && !archived) {
        empty = (
            <div className="flex flex-col items-start gap-2">
                <p>Start with a base model or create a model for your task.</p>
                <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={onDiscover}>
                        Discover models
                    </Button>
                    <Button size="sm" onClick={onCreate}>
                        Create model
                    </Button>
                </div>
            </div>
        );
    } else {
        empty = (
            <div className="flex flex-wrap items-center gap-2">
                <p className="text-muted-foreground">
                    No models match{" "}
                    {filterContext(search) || (archived ? "with archived shown" : "")}.
                </p>
                {filtering && (
                    <Button variant="outline" size="sm" onClick={clear}>
                        Clear filters
                    </Button>
                )}
            </div>
        );
    }
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
                <FilterSelect
                    label="Type"
                    value={search.type}
                    options={[
                        ["base", "Base"],
                        ["custom", "Custom"],
                    ]}
                    onChange={(type) => update({ type })}
                />
                <FilterSelect
                    label="Availability"
                    value={search.availability}
                    options={Object.entries(AVAILABILITY_LABELS)}
                    onChange={(availability) => update({ availability })}
                />
                <FilterSelect
                    label="Deployment"
                    value={search.deployment}
                    options={[
                        ["deployed", "Deployed"],
                        ["not-deployed", "Not deployed"],
                    ]}
                    onChange={(deployment) => update({ deployment })}
                />
                {tags.length > 0 && (
                    <FilterSelect
                        label="Tag"
                        value={search.tag}
                        options={tags.map((tag) => [tag, tag])}
                        onChange={(tag) => update({ tag })}
                    />
                )}
                {filtering && (
                    <Button variant="ghost" size="sm" onClick={clear}>
                        Clear filters
                    </Button>
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
                <SortableTable
                    columns={tableColumns}
                    rows={visible}
                    onOpen={(row) => on.open(detailHref(row))}
                    rowLabel={(row) =>
                        `${row.name}, ${row.kind === "base" ? "base" : "custom"} model`
                    }
                    empty={empty}
                    initialSort={[{ id: "updated", desc: true }]}
                />
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
