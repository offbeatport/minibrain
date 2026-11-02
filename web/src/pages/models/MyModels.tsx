import { useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import {
    CircleX,
    Eye,
    FlaskConical,
    GraduationCap,
    MoreHorizontal,
    Pencil,
    PowerOff,
    Rocket,
    Trash2,
} from "lucide-react";
import {
    Button,
    CheckboxSelect,
    DataGrid,
    DataGridDetail,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Link,
    SearchInput,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { useMemo, useState } from "react";
import { type ModelRow, api, unwrap } from "~/api/client";
import { useModels } from "~/api/queries";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine } from "~/components/Section";
import { Requests, failingShare } from "~/components/models/ModelMetrics";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import type { ModelsSearch } from "~/lib/modelsSearch";
import { bytes, exactTime, relativeTime } from "~/lib/time";
import { AddModelDialog } from "./AddModelDialog";
import { GetStarted } from "./GetStarted";
import {
    ConfirmAction,
    type Confirmation,
    EditModelDialog,
    TestBaseDialog,
    cancelJob,
    useModelsRefresh,
} from "./dialogs";
import {
    type Entry,
    KIND_LABELS,
    STATE_LABELS,
    STATE_RANK,
    byState,
    entriesOf,
    failingEntry,
    stateOfEntry,
    usageOf,
} from "./entries";

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

export function detailHref(row: ModelRow): string {
    return `/models/${row.kind}/${encodeURIComponent(row.key)}`;
}

function scoped(path: string, row: ModelRow): string {
    if (path === "/deployments") {
        return `/deployments/${encodeURIComponent(row.key)}`;
    }
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
        <div className="flex items-center gap-2">
            <StatusText tone={AVAILABILITY_TONES[state]}>
                {label}
                {moving && percent(progress) && (
                    <span className="tabular-nums"> · {percent(progress)}</span>
                )}
            </StatusText>
            {moving && (
                <ProgressBar
                    value={progress}
                    label={`${row.name} ${label.toLowerCase()}`}
                    className="w-16"
                />
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
        <div className="flex items-center gap-2">
            {href ? (
                <Link href={href} className="hover:underline">
                    {text}
                </Link>
            ) : (
                text
            )}
            {state === "running" && <ProgressBar value={progress} label={label} className="w-16" />}
        </div>
    );
}

const DEPLOYMENT_STATES: Record<string, string> = {
    running: "Live",
    starting: "Starting",
    unhealthy: "Unhealthy",
};

export function Deployment({ row, short = false }: { row: ModelRow; short?: boolean }) {
    const { state } = row.deployment;
    const label = short ? (DEPLOYMENT_STATES[state] ?? row.deployment.label) : row.deployment.label;
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
    const body = { deployed };
    return row.kind === "base"
        ? unwrap(
              api.POST("/api/models/base/{key}/deploy", {
                  params: { path: { key: row.key } },
                  body,
              }),
          )
        : unwrap(
              api.POST("/api/minibrains/{slug}/deploy", {
                  params: { path: { slug: row.key } },
                  body,
              }),
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

function deleteModel(row: ModelRow) {
    return row.kind === "base"
        ? unwrap(api.DELETE("/api/models/base/{key}", { params: { path: { key: row.key } } }))
        : unwrap(api.DELETE("/api/minibrains/{slug}", { params: { path: { slug: row.key } } }));
}

function DeployedWarning({ row }: { row: ModelRow }) {
    return (
        <p>
            It has to be undeployed before it can be deleted. Apps calling{" "}
            <span className="font-mono">{row.key}</span> get errors from then on.
        </p>
    );
}

function deleteConfirmation(row: ModelRow, on: Handlers): Confirmation {
    const deployed = row.deployment.state !== "not_deployed";
    const removed =
        row.kind === "base" ? (
            <p>
                {row.size_bytes
                    ? `Its weights (${bytes(row.size_bytes)}) are removed from storage, with its API keys.`
                    : "Its record and API keys are removed."}{" "}
                You can download or import it again later.
            </p>
        ) : (
            <p>
                Its data, versions, evaluation results and API keys are removed. This cannot be
                undone.
            </p>
        );
    if (deployed) {
        return {
            title: `${row.name} is deployed. Delete it?`,
            description: (
                <>
                    <DeployedWarning row={row} />
                    {removed}
                </>
            ),
            acknowledge: `Undeploy and delete ${row.name}`,
            confirmLabel: "Undeploy and delete",
            destructive: true,
            run: () =>
                setDeployed(row, false)
                    .then(() => deleteModel(row))
                    .then(on.refresh),
        };
    }
    return {
        title: `Delete ${row.name}?`,
        description: removed,
        confirmLabel: "Delete",
        destructive: true,
        run: () => deleteModel(row).then(on.refresh),
    };
}

function promoteVersion(row: ModelRow, number: number) {
    return unwrap(
        api.POST("/api/minibrains/{slug}/versions/{number}/promote", {
            params: { path: { slug: row.key, number } },
        }),
    );
}

function deleteVersion(row: ModelRow, number: number) {
    return unwrap(
        api.DELETE("/api/minibrains/{slug}/versions/{number}", {
            params: { path: { slug: row.key, number } },
        }),
    );
}

function deleteVersionConfirmation(entry: Entry, on: Handlers): Confirmation {
    const row = entry.model;
    const number = entry.version?.number ?? 0;
    const removed = (
        <p>
            Its adapter, scores and results are removed. This cannot be undone; the number v{number}{" "}
            is not reused.
        </p>
    );
    if (entry.version?.live) {
        return {
            title: `v${number} of ${row.name} is deployed. Delete it?`,
            description: (
                <>
                    <DeployedWarning row={row} />
                    {removed}
                </>
            ),
            acknowledge: `Undeploy ${row.name} and delete v${number}`,
            confirmLabel: "Undeploy and delete",
            destructive: true,
            run: () =>
                setDeployed(row, false)
                    .then(() => deleteVersion(row, number))
                    .then(on.refresh),
        };
    }
    return {
        title: `Delete v${number} of ${row.name}?`,
        description: removed,
        confirmLabel: "Delete version",
        destructive: true,
        run: () => deleteVersion(row, number).then(on.refresh),
    };
}

function versionAction(entry: Entry, on: Handlers): { label: string; run: () => void } | null {
    const row = entry.model;
    const version = entry.version;
    if (!version) {
        return null;
    }
    if (version.live) {
        return { label: "Use API", run: () => on.open(scoped("/deployments", row)) };
    }
    if (version.status === "ready") {
        return { label: "Deploy", run: () => promoteVersion(row, version.number).then(on.refresh) };
    }
    if (version.status === "failed") {
        return { label: "Details", run: () => on.open(scoped("/training", row)) };
    }
    return null;
}

function undeployConfirmation(row: ModelRow, on: Handlers): Confirmation {
    return {
        title: `Undeploy ${row.name}?`,
        description: <p>Its API stops answering; versions, keys and files stay.</p>,
        confirmLabel: "Undeploy",
        destructive: true,
        run: () => setDeployed(row, false).then(on.refresh),
    };
}

function deployConfirmation(row: ModelRow, on: Handlers): Confirmation {
    return {
        title: `Deploy ${row.name}?`,
        description: (
            <p>
                It becomes callable as <span className="font-mono">{row.key}</span> on the
                OpenAI-compatible API with its own keys
                {row.needed_bytes ? `, using about ${bytes(row.needed_bytes)} of memory` : ""}.
            </p>
        ),
        confirmLabel: "Deploy",
        run: () => setDeployed(row, true).then(on.refresh),
    };
}

function cancelTransferConfirmation(row: ModelRow, on: Handlers): Confirmation {
    return {
        title: `Cancel ${row.activity.label.toLowerCase()}?`,
        description: <p>Files already validated are kept, so a retry resumes.</p>,
        confirmLabel: "Cancel transfer",
        destructive: true,
        run: () => cancelJob(row.activity.job_id ?? 0).then(on.refresh),
    };
}

function ActionItems({ entry, on }: { entry: Entry; on: Handlers }) {
    const row = entry.model;
    const version = entry.version;
    const deployed = row.deployment.state !== "not_deployed";
    const transferring = row.kind === "base" && ["running", "queued"].includes(row.activity.state);
    const deployable = row.kind === "custom" || row.availability.state === "available";
    return (
        <>
            {version?.status === "ready" && !version.live && (
                <DropdownMenuItem
                    onSelect={() => promoteVersion(row, version.number).then(on.refresh)}
                >
                    <Rocket />
                    {`Deploy v${version.number}`}
                </DropdownMenuItem>
            )}
            {version?.status === "ready" && (
                <DropdownMenuItem onSelect={() => on.test(row)}>
                    <FlaskConical />
                    {`Test v${version.number}`}
                </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => on.open(detailHref(row))}>
                <Eye />
                View details
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => on.edit(row)}>
                <Pencil />
                Edit name, description and tags
            </DropdownMenuItem>
            {row.kind === "custom" && (
                <DropdownMenuItem onSelect={() => on.open(scoped("/training", row))}>
                    <GraduationCap />
                    Train
                </DropdownMenuItem>
            )}
            {row.kind === "base" && row.availability.state === "available" && (
                <DropdownMenuItem onSelect={() => on.createFrom(row.key)}>
                    <GraduationCap />
                    Train a model on it
                </DropdownMenuItem>
            )}
            {row.kind === "custom" && !version && (
                <DropdownMenuItem onSelect={() => on.open(scoped("/evaluations", row))}>
                    <Rocket />
                    {deployed ? "Change deployed version" : "Deploy a version"}
                </DropdownMenuItem>
            )}
            {!version && deployable && !deployed && (
                <DropdownMenuItem onSelect={() => on.confirm(deployConfirmation(row, on))}>
                    <Rocket />
                    Deploy
                </DropdownMenuItem>
            )}
            {transferring && row.activity.job_id !== null && (
                <DropdownMenuItem onSelect={() => on.confirm(cancelTransferConfirmation(row, on))}>
                    <CircleX />
                    Cancel {row.activity.kind === "import" ? "import" : "download"}
                </DropdownMenuItem>
            )}
        </>
    );
}

function StopItems({ entry, on }: { entry: Entry; on: Handlers }) {
    const row = entry.model;
    const version = entry.version;
    const deployed = row.deployment.state !== "not_deployed";
    const live = version ? version.live : deployed;
    return (
        <>
            {live && (
                <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => on.confirm(undeployConfirmation(row, on))}
                >
                    <PowerOff />
                    Undeploy
                </DropdownMenuItem>
            )}
            {version && (
                <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => on.confirm(deleteVersionConfirmation(entry, on))}
                >
                    <Trash2 />
                    {`Delete v${version.number} only`}
                </DropdownMenuItem>
            )}
            <DropdownMenuItem
                variant="destructive"
                onSelect={() => on.confirm(deleteConfirmation(row, on))}
            >
                <Trash2 />
                {row.kind === "custom" ? "Delete model and all versions" : "Delete model"}
            </DropdownMenuItem>
        </>
    );
}

function RowActions({ entry, on }: { entry: Entry; on: Handlers }) {
    const row = entry.model;
    const primary = entry.version ? versionAction(entry, on) : primaryAction(row, on);
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
                <DropdownMenuContent align="end" className="w-64">
                    <ActionItems entry={entry} on={on} />
                    <DropdownMenuSeparator />
                    <StopItems entry={entry} on={on} />
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

function failedLabel(entry: Entry): string {
    const { model, version } = entry;
    if (version) {
        return version.kind === "lora" && version.accuracy === null
            ? "Training failed"
            : "Scoring failed";
    }
    if (model.availability.state === "missing") {
        return "Missing files";
    }
    if (model.deployment.state === "unhealthy") {
        return "Deployment unhealthy";
    }
    return model.activity.label;
}

function errorDetail(entry: Entry): string {
    const usage = usageOf(entry);
    if (failingEntry(entry)) {
        return `${usage?.failed ?? 0} of ${usage?.total ?? 0} requests in the last 7 days failed.`;
    }
    const { model, version } = entry;
    if (version) {
        return version.error || "The job failed without a message.";
    }
    if (model.availability.state === "missing") {
        return "Some of its files are gone from storage. Retry the download or delete it.";
    }
    if (model.deployment.state === "unhealthy") {
        return "The engine serving it does not answer health checks.";
    }
    return model.error || "The last job failed without a message.";
}

function ErrorStatus({ label, detail }: { label: string; detail: string }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="rounded-sm text-left">
                    <StatusText tone="destructive">{label}</StatusText>
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-normal">{detail}</TooltipContent>
        </Tooltip>
    );
}

function StatusCell({ entry }: { entry: Entry }) {
    const { model, version } = entry;
    const state = stateOfEntry(entry);
    if (state === "error") {
        const share = Math.round(failingShare(usageOf(entry)) * 100);
        const label = failingEntry(entry) ? `${share}% of requests failing` : failedLabel(entry);
        return <ErrorStatus label={label} detail={errorDetail(entry)} />;
    }
    if (state === "live") {
        return <Deployment row={model} short />;
    }
    if (version && state === "progress") {
        const verb = version.status === "training" ? "Training" : "Scoring";
        const share = version.progress ? ` · ${Math.round(version.progress * 100)}%` : "";
        return (
            <div className="flex items-center gap-2">
                <StatusText tone="info">
                    {verb}
                    <span className="tabular-nums">{share}</span>
                </StatusText>
                <ProgressBar
                    value={version.progress}
                    label={`${model.name} v${version.number}`}
                    className="w-16"
                />
            </div>
        );
    }
    if (state === "progress") {
        return model.kind === "base" ? <Availability row={model} /> : <Activity row={model} />;
    }
    if (model.kind === "base" && model.availability.state === "not_downloaded") {
        return <Availability row={model} />;
    }
    return <span className="text-muted-foreground">Not deployed</span>;
}

function ModelName({ entry }: { entry: Entry }) {
    const { model } = entry;
    return (
        <div className="flex w-80 items-center gap-2.5">
            <PublisherLogo publisher={model.publisher} name={model.name} size="sm" />
            <div className="flex min-w-0 flex-col">
                <Link href={detailHref(model)} className="truncate font-semibold text-foreground">
                    {model.name}
                </Link>
                {model.description && (
                    <DataGridDetail
                        className="line-clamp-2 whitespace-normal text-sm text-muted-foreground"
                        title={model.description}
                    >
                        {model.description}
                    </DataGridDetail>
                )}
            </div>
        </div>
    );
}

const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;

function versionLabel(entry: Entry): string {
    if (entry.version) {
        return `v${entry.version.number}`;
    }
    return entry.model.kind === "base" ? (entry.model.revision?.slice(0, 7) ?? "—") : "—";
}

function requestTotal(entry: Entry): number {
    return (usageOf(entry)?.daily ?? []).reduce((sum, value) => sum + value, 0);
}

function lastUsed(entry: Entry): string {
    return usageOf(entry)?.last_at ?? "";
}

function modelOrder(entry: Entry): string {
    const number = String(1_000_000 - (entry.version?.number ?? 0)).padStart(7, "0");
    return `${entry.model.name.toLowerCase()} ${number}`;
}

const HIDDEN_COLUMNS = ["type", "base", "kind", "used", "size", "tags", "updated"];
function columns(on: Handlers): ColumnDef<Entry, unknown>[] {
    return [
        {
            id: "model",
            header: "Model",
            enableHiding: false,
            accessorFn: modelOrder,
            cell: ({ row }) => <ModelName entry={row.original} />,
        },
        {
            id: "type",
            header: "Type",
            accessorFn: (entry) => entry.model.kind,
            cell: ({ row }) => (row.original.model.kind === "custom" ? "Custom" : "Base"),
        },
        {
            id: "base",
            header: "Base model",
            accessorFn: (entry) => entry.model.base_model ?? "",
            cell: ({ row }) =>
                row.original.model.base_model ? (
                    <span className="font-mono">{row.original.model.base_model}</span>
                ) : (
                    muted("—")
                ),
        },
        {
            id: "version",
            header: "Version",
            accessorFn: (entry) => entry.version?.number ?? -1,
            cell: ({ row }) =>
                row.original.version ? (
                    <span className="tabular-nums">{versionLabel(row.original)}</span>
                ) : row.original.model.kind === "base" && row.original.model.revision ? (
                    <span
                        className="font-mono text-muted-foreground"
                        title={row.original.model.revision}
                    >
                        {versionLabel(row.original)}
                    </span>
                ) : (
                    muted("—")
                ),
        },
        {
            id: "kind",
            header: "Kind",
            accessorFn: (entry) =>
                entry.version ? (KIND_LABELS[entry.version.kind] ?? entry.version.kind) : "",
            cell: ({ row }) =>
                row.original.version
                    ? (KIND_LABELS[row.original.version.kind] ?? row.original.version.kind)
                    : muted("—"),
        },
        {
            id: "score",
            header: "Score",
            accessorFn: (entry) => entry.version?.accuracy ?? -1,
            cell: ({ row }) =>
                row.original.version?.accuracy === null ||
                row.original.version?.accuracy === undefined ? (
                    muted("—")
                ) : (
                    <span className="tabular-nums">{`${Math.round(row.original.version.accuracy * 100)}%`}</span>
                ),
        },
        {
            id: "status",
            header: "Status",
            accessorFn: (entry) => STATE_RANK.indexOf(stateOfEntry(entry)),
            cell: ({ row }) => <StatusCell entry={row.original} />,
        },
        {
            id: "requests",
            header: "Requests, 7 days",
            accessorFn: requestTotal,
            cell: ({ row }) => <Requests usage={usageOf(row.original)} />,
        },
        {
            id: "used",
            header: "Last used",
            accessorFn: lastUsed,
            cell: ({ row }) => {
                const at = lastUsed(row.original);
                return at ? <span title={exactTime(at)}>{relativeTime(at)}</span> : muted("Never");
            },
        },
        {
            id: "size",
            header: "Size",
            accessorFn: (entry) => entry.model.size_bytes ?? 0,
            cell: ({ row }) =>
                row.original.model.size_bytes ? (
                    <span className="tabular-nums">{bytes(row.original.model.size_bytes)}</span>
                ) : (
                    muted("—")
                ),
        },
        {
            id: "tags",
            header: "Tags",
            accessorFn: (entry) => entry.model.tags.join(", "),
            cell: ({ row }) =>
                row.original.model.tags.length ? (
                    <span className="block max-w-48 truncate">
                        {row.original.model.tags.join(", ")}
                    </span>
                ) : (
                    muted("—")
                ),
        },
        {
            id: "updated",
            header: "Updated",
            accessorFn: (entry) => entry.model.updated_at,
            cell: ({ row }) => (
                <span title={exactTime(row.original.model.updated_at)}>
                    {relativeTime(row.original.model.updated_at)}
                </span>
            ),
        },
        {
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            enableSorting: false,
            enableHiding: false,
            cell: ({ row }) => <RowActions entry={row.original} on={on} />,
        },
    ];
}

type Facet = "type" | "state";

function searchable(entry: Entry): string {
    const { model, version } = entry;
    const number = version ? `v${version.number}` : "";
    return `${model.name} ${model.description} ${model.key} ${model.tags.join(" ")} ${number}`.toLowerCase();
}

function picked(value: string | undefined): string[] {
    return (value ?? "").split(",").filter(Boolean);
}

function matches(entry: Entry, search: ModelsSearch, skip?: Facet): boolean {
    const text = (search.q ?? "").trim().toLowerCase();
    if (text && !searchable(entry).includes(text)) {
        return false;
    }
    const types = picked(search.type);
    if (skip !== "type" && types.length > 0 && !types.includes(entry.model.kind)) {
        return false;
    }
    const states = picked(search.state);
    return skip === "state" || states.length === 0 || states.includes(stateOfEntry(entry));
}

const CLEARED: ModelsSearch = { q: "", type: "", state: "" };

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
    const models = useModels();
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
    const entries = entriesOf(rows);
    const visible = entries.filter((entry) => matches(entry, search)).sort(byState);
    const facetCount = (facet: Facet, test: (entry: Entry) => boolean) =>
        entries.filter((entry) => matches(entry, search, facet) && test(entry)).length;
    const filtering = Boolean(search.q || search.type || search.state);
    const clear = () => update(CLEARED);
    const firstRun = !rows.some((row) => row.kind === "custom") && !filtering;
    const stateOptions = STATE_RANK.map((state) => ({
        value: state,
        label: STATE_LABELS[state],
        count: facetCount("state", (entry) => stateOfEntry(entry) === state),
    }));
    const typeOptions = (["custom", "base"] as const).map((kind) => ({
        value: kind,
        label: kind === "custom" ? "Custom" : "Base",
        count: facetCount("type", (entry) => entry.model.kind === kind),
    }));
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
    return (
        <div className="flex flex-col gap-3">
            {firstRun && <GetStarted onDiscover={onDiscover} onCreate={onCreate} />}
            <div className="flex flex-wrap items-center gap-2">
                <SearchInput
                    aria-label="Search models"
                    placeholder="Search models"
                    value={search.q ?? ""}
                    onValueChange={(q) => update({ q })}
                    className="w-full max-w-xs flex-1"
                />
                <div className="ml-auto flex flex-wrap items-center gap-2">
                    <CheckboxSelect
                        label="Status"
                        allLabel="All statuses"
                        noun="statuses"
                        options={stateOptions}
                        value={picked(search.state)}
                        onValueChange={(states) => update({ state: states.join(",") })}
                    />
                    <CheckboxSelect
                        label="Type"
                        allLabel="All types"
                        noun="types"
                        options={typeOptions}
                        value={picked(search.type)}
                        onValueChange={(types) => update({ type: types.join(",") })}
                    />
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
                <DataGrid
                    columns={tableColumns}
                    rows={visible}
                    storageKey="minibrain.models.columns"
                    columnPicker
                    hiddenColumns={HIDDEN_COLUMNS}
                    onOpen={(entry) => on.open(detailHref(entry.model))}
                    rowLabel={(entry) =>
                        `${entry.model.name}${entry.version ? ` v${entry.version.number}` : ""}, ${entry.model.kind} model, ${STATE_LABELS[stateOfEntry(entry)]}`
                    }
                    empty={noMatch}
                    minWidth="min-w-[880px]"
                />
            )}
            <TestBaseDialog row={testing} onOpenChange={(open) => !open && setTesting(null)} />
            <EditModelDialog row={editing} onOpenChange={(open) => !open && setEditing(null)} />
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
            <AddModelDialog
                open={createBase !== null}
                onOpenChange={(open) => !open && setCreateBase(null)}
                base={createBase ?? undefined}
            />
        </div>
    );
}
