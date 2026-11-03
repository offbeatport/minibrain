import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
    ArrowUpDown,
    CircleX,
    Eye,
    FlaskConical,
    GraduationCap,
    MoreHorizontal,
    Pencil,
    PowerOff,
    Rocket,
    RotateCcw,
    Trash2,
} from "lucide-react";
import {
    Badge,
    Button,
    Checkbox,
    CheckboxSelect,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Link,
    SearchInput,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { type ModelRow, api, succeed, unwrap } from "~/api/client";
import { useModels } from "~/api/queries";
import {
    type ColumnWidths,
    LeadingResizer,
    type ResizableColumn,
    SortButton,
    type SortDirection,
    ariaSort,
    useColumnWidths,
    widthVariables,
} from "~/components/ListColumns";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine } from "~/components/Section";
import { Requests, failingShare } from "~/components/models/ModelMetrics";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import type { ModelsSearch } from "~/lib/modelsSearch";
import { bytes, exactTime, relativeTime } from "~/lib/time";
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
    STATE_LABELS,
    STATE_RANK,
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
        ? succeed(api.DELETE("/api/models/base/{key}", { params: { path: { key: row.key } } }))
        : succeed(api.DELETE("/api/minibrains/{slug}", { params: { path: { slug: row.key } } }));
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
    return succeed(
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
                <Button
                    variant="outline"
                    size="xs"
                    className="hidden md:inline-flex"
                    onClick={primary.run}
                >
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

const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;

function summary(entry: Entry): string {
    const { model } = entry;
    if (model.description) {
        return model.description;
    }
    if (model.kind === "base") {
        return model.size_bytes ? `Base model · ${bytes(model.size_bytes)}` : "Base model";
    }
    return `On ${model.base_model}`;
}

function VersionCell({ entry }: { entry: Entry }) {
    const { model, version } = entry;
    if (version) {
        const score = version.accuracy === null ? "" : ` · ${Math.round(version.accuracy * 100)}%`;
        return (
            <span className="tabular-nums">
                {`v${version.number}`}
                <span className="text-muted-foreground">{score}</span>
            </span>
        );
    }
    if (model.kind === "base" && model.revision) {
        return (
            <span className="font-mono text-muted-foreground" title={model.revision}>
                {model.revision.slice(0, 7)}
            </span>
        );
    }
    return muted("—");
}

function requestTotal(entry: Entry): number {
    return (usageOf(entry)?.daily ?? []).reduce((sum, value) => sum + value, 0);
}

type SortKey = "status" | "name" | "version" | "updated" | "requests";
type Sort = { key: SortKey; direction: SortDirection };
type SortValue = string | number | null;

const SORTS: Record<
    SortKey,
    {
        initial: SortDirection;
        labels: Record<SortDirection, string>;
        value: (entry: Entry) => SortValue;
    }
> = {
    status: {
        initial: "asc",
        labels: { asc: "Status", desc: "Status, reversed" },
        value: (entry) => STATE_RANK.indexOf(stateOfEntry(entry)),
    },
    name: {
        initial: "asc",
        labels: { asc: "Name, A to Z", desc: "Name, Z to A" },
        value: (entry) => entry.model.name,
    },
    version: {
        initial: "desc",
        labels: { desc: "Newest version", asc: "Oldest version" },
        value: (entry) => entry.version?.number ?? null,
    },
    updated: {
        initial: "desc",
        labels: { desc: "Recently updated", asc: "Least recently updated" },
        value: (entry) => entry.model.updated_at,
    },
    requests: {
        initial: "desc",
        labels: { desc: "Most requests", asc: "Fewest requests" },
        value: requestTotal,
    },
};

const DEFAULT_SORT: Sort = { key: "status", direction: "asc" };

function isSortKey(value: string): value is SortKey {
    return Object.hasOwn(SORTS, value);
}

function parseSort(value: string | undefined): Sort {
    const key = (value ?? "").replace(/^-/, "");
    if (!isSortKey(key)) {
        return DEFAULT_SORT;
    }
    return { key, direction: value?.startsWith("-") ? "desc" : "asc" };
}

function sortValue({ key, direction }: Sort): string {
    return direction === "desc" ? `-${key}` : key;
}

function opposite(direction: SortDirection): SortDirection {
    return direction === "asc" ? "desc" : "asc";
}

const SORT_OPTIONS = (Object.keys(SORTS) as SortKey[]).flatMap((key) =>
    [SORTS[key].initial, opposite(SORTS[key].initial)].map((direction) => ({
        value: sortValue({ key, direction }),
        label: SORTS[key].labels[direction],
    })),
);

function byName(left: Entry, right: Entry): number {
    return (
        left.model.name.localeCompare(right.model.name) ||
        (right.version?.number ?? 0) - (left.version?.number ?? 0)
    );
}

function compareValues(left: string | number, right: string | number): number {
    return typeof left === "string" && typeof right === "string"
        ? left.localeCompare(right)
        : Number(left) - Number(right);
}

function sorter({ key, direction }: Sort) {
    const { value } = SORTS[key];
    const sign = direction === "asc" ? 1 : -1;
    return (left: Entry, right: Entry) => {
        const a = value(left);
        const b = value(right);
        if (a === null || b === null) {
            return Number(a === null) - Number(b === null) || byName(left, right);
        }
        return sign * compareValues(a, b) || byName(left, right);
    };
}

function SortSelect({ value, onSort }: { value: Sort; onSort: (sort: Sort) => void }) {
    return (
        <Select value={sortValue(value)} onValueChange={(next) => onSort(parseSort(String(next)))}>
            <SelectTrigger aria-label="Sort models" className="w-auto min-w-44">
                <ArrowUpDown aria-hidden="true" className="size-4 text-muted-foreground" />
                <SelectValue className="flex-1 text-left" />
            </SelectTrigger>
            <SelectContent>
                {SORT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                        {option.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

type ColumnId = "version" | "status" | "requests";

const COLUMNS: (ResizableColumn & { id: ColumnId; sort: SortKey })[] = [
    { id: "version", label: "Version", sort: "version", min: 64, max: 320 },
    { id: "status", label: "Status", sort: "status", min: 96, max: 480 },
    { id: "requests", label: "Requests, 7 days", sort: "requests", min: 144, max: 480 },
];

const WIDTHS_KEY = "minibrain.models.columns";

const LIST_GRID =
    "grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-4 md:grid-cols-[auto_minmax(12rem,1fr)_var(--col-version,minmax(5rem,auto))_var(--col-status,minmax(10rem,auto))_var(--col-requests,minmax(9rem,auto))_auto]";

const CLIPPED = "-mx-1 max-w-[calc(100%+0.5rem)] overflow-x-clip px-1";

const ROW_GRID = "col-span-full grid grid-cols-subgrid items-center px-4";

function ModelListRow({
    entry,
    on,
    selected,
    onSelect,
    widths,
}: {
    entry: Entry;
    on: Handlers;
    selected: boolean;
    onSelect: (selected: boolean) => void;
    widths: ColumnWidths;
}) {
    const { model } = entry;
    return (
        <li
            data-state={selected ? "selected" : undefined}
            className={cn(
                ROW_GRID,
                "relative py-3 hover:bg-secondary has-[a:focus-visible]:bg-secondary data-[state=selected]:bg-accent/60",
            )}
        >
            <Checkbox
                className="relative z-10"
                aria-label={`Select ${model.name}${entry.version ? ` v${entry.version.number}` : ""}`}
                checked={selected}
                onCheckedChange={(value) => onSelect(value === true)}
            />
            <div className="flex min-w-0 items-center gap-3">
                <PublisherLogo publisher={model.publisher} name={model.name} />
                <div className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                        <Link
                            href={detailHref(model)}
                            className="truncate font-semibold text-foreground outline-none after:absolute after:inset-0 after:content-['']"
                        >
                            {model.name}
                        </Link>
                        {model.kind === "base" && (
                            <Badge variant="outline" className="shrink-0">
                                Base
                            </Badge>
                        )}
                    </span>
                    <span
                        className="line-clamp-2 text-sm text-muted-foreground"
                        title={summary(entry)}
                    >
                        {summary(entry)}
                    </span>
                </div>
            </div>
            <div className="hidden min-w-0 truncate md:block">
                <VersionCell entry={entry} />
            </div>
            <div
                className={cn(
                    "relative z-10 hidden w-fit md:block",
                    widths.status !== undefined && CLIPPED,
                )}
            >
                <StatusCell entry={entry} />
            </div>
            <div className="relative z-10 hidden min-w-0 md:block">
                <Requests
                    usage={usageOf(entry)}
                    live={entry.model.deployment.state !== "not_deployed"}
                />
            </div>
            <div className="relative z-10">
                <RowActions entry={entry} on={on} />
            </div>
        </li>
    );
}

function ResetWidths({ onReset }: { onReset: () => void }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Reset column widths"
                    className="hidden md:inline-flex"
                    onClick={onReset}
                >
                    <RotateCcw />
                </Button>
            </TooltipTrigger>
            <TooltipContent>Reset column widths</TooltipContent>
        </Tooltip>
    );
}

function ModelList({
    entries,
    on,
    selected,
    onSelected,
    sort,
    onSort,
    empty,
}: {
    entries: Entry[];
    on: Handlers;
    selected: string[];
    onSelected: (ids: string[]) => void;
    sort: Sort;
    onSort: (key: SortKey) => void;
    empty: ReactNode;
}) {
    const sizing = useColumnWidths(WIDTHS_KEY, COLUMNS);
    const ids = entries.map((entry) => entry.key);
    const count = ids.filter((id) => selected.includes(id)).length;
    const all = count === 0 ? false : count === ids.length ? true : "indeterminate";
    const directionOf = (key: SortKey) => (sort.key === key ? sort.direction : null);
    return (
        <div
            className={cn(LIST_GRID, "overflow-x-auto rounded-lg border bg-card")}
            style={widthVariables(sizing.widths, "--col-") as CSSProperties}
        >
            <div
                className={cn(
                    ROW_GRID,
                    "h-9 border-b bg-secondary text-sm font-medium text-muted-foreground",
                )}
            >
                <Checkbox
                    aria-label="Select all models"
                    checked={all}
                    disabled={ids.length === 0}
                    onCheckedChange={(value) =>
                        onSelected(
                            value === true
                                ? [...new Set([...selected, ...ids])]
                                : selected.filter((id) => !ids.includes(id)),
                        )
                    }
                />
                <div aria-sort={ariaSort(directionOf("name"))} className="flex min-w-0">
                    <SortButton
                        label="Model"
                        direction={directionOf("name")}
                        onSort={() => onSort("name")}
                    />
                </div>
                {COLUMNS.map((column) => (
                    <div
                        key={column.id}
                        aria-sort={ariaSort(directionOf(column.sort))}
                        className="relative hidden min-w-0 items-center self-stretch md:flex"
                    >
                        <SortButton
                            label={column.label}
                            direction={directionOf(column.sort)}
                            onSort={() => onSort(column.sort)}
                        />
                        <LeadingResizer
                            column={column}
                            onResize={(width) => sizing.resize(column, width)}
                            onReset={() => sizing.reset(column)}
                        />
                    </div>
                ))}
                <div className="flex justify-end">
                    {Object.keys(sizing.widths).length > 0 && (
                        <ResetWidths onReset={sizing.resetAll} />
                    )}
                    <span className="sr-only">Actions</span>
                </div>
            </div>
            {entries.length === 0 ? (
                <div className="col-span-full px-4 py-8">{empty}</div>
            ) : (
                <ul className="col-span-full grid grid-cols-subgrid divide-y">
                    {entries.map((entry) => (
                        <ModelListRow
                            key={entry.key}
                            entry={entry}
                            on={on}
                            selected={selected.includes(entry.key)}
                            onSelect={(on) =>
                                onSelected(
                                    on
                                        ? [...selected, entry.key]
                                        : selected.filter((id) => id !== entry.key),
                                )
                            }
                            widths={sizing.widths}
                        />
                    ))}
                </ul>
            )}
        </div>
    );
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
    const states = picked(search.state);
    return skip === "state" || states.length === 0 || states.includes(stateOfEntry(entry));
}

const CLEARED: ModelsSearch = { q: "", state: "" };

function liveOf(entry: Entry): boolean {
    return entry.version ? entry.version.live : entry.model.deployment.state !== "not_deployed";
}

function deployable(entry: Entry): boolean {
    if (entry.version) {
        return entry.version.status === "ready" && !entry.version.live;
    }
    const { model } = entry;
    return (
        model.deployment.state === "not_deployed" &&
        (model.kind === "custom" || model.availability.state === "available")
    );
}

function unique(rows: ModelRow[]): ModelRow[] {
    return [...new Map(rows.map((row) => [`${row.kind}:${row.key}`, row])).values()];
}

async function deploySelected(chosen: Entry[]): Promise<void> {
    for (const entry of chosen) {
        if (entry.version) {
            await promoteVersion(entry.model, entry.version.number);
        } else {
            await setDeployed(entry.model, true);
        }
    }
}

async function undeploySelected(chosen: Entry[]): Promise<void> {
    for (const row of unique(chosen.filter(liveOf).map((entry) => entry.model))) {
        await setDeployed(row, false);
    }
}

async function deleteSelected(chosen: Entry[]): Promise<void> {
    await undeploySelected(chosen);
    const whole = unique(chosen.filter((entry) => !entry.version).map((entry) => entry.model));
    const wholeKeys = new Set(whole.map((row) => `${row.kind}:${row.key}`));
    for (const entry of chosen) {
        if (entry.version && !wholeKeys.has(`${entry.model.kind}:${entry.model.key}`)) {
            await deleteVersion(entry.model, entry.version.number);
        }
    }
    for (const row of whole) {
        await deleteModel(row);
    }
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function bulkDeleteConfirmation(chosen: Entry[], run: () => Promise<unknown>): Confirmation {
    const versions = chosen.filter((entry) => entry.version).length;
    const models = chosen.length - versions;
    const live = chosen.filter(liveOf).length;
    const parts = [
        models ? plural(models, "model") : "",
        versions ? plural(versions, "version") : "",
    ].filter(Boolean);
    return {
        title: `Delete ${parts.join(" and ")}?`,
        description: (
            <>
                <p>
                    {models
                        ? "Models go with all their versions, data links, scores and API keys. "
                        : ""}
                    {versions ? "Versions go with their adapters, scores and results. " : ""}
                    This cannot be undone.
                </p>
                {live > 0 && (
                    <p>
                        {`${plural(live, "selected row")} ${live === 1 ? "is" : "are"} deployed and must be undeployed first; apps calling them get errors from then on.`}
                    </p>
                )}
            </>
        ),
        acknowledge: live > 0 ? "Undeploy and delete" : undefined,
        confirmLabel: live > 0 ? "Undeploy and delete" : "Delete",
        destructive: true,
        run,
    };
}

function BulkBar({
    chosen,
    onClear,
    onConfirm,
    onDone,
}: {
    chosen: Entry[];
    onClear: () => void;
    onConfirm: (confirmation: Confirmation) => void;
    onDone: () => Promise<unknown>;
}) {
    const act = useMutation({
        mutationFn: (run: (rows: Entry[]) => Promise<void>) => run(chosen),
        onSettled: onDone,
    });
    const models = new Set(chosen.map((entry) => `${entry.model.kind}:${entry.model.key}`));
    const canDeploy =
        chosen.length > 0 && models.size === chosen.length && chosen.every(deployable);
    const canUndeploy = chosen.some(liveOf);
    return (
        <div className="flex min-h-8 flex-wrap items-center gap-2">
            <span className="text-sm font-medium tabular-nums">{`${chosen.length} selected`}</span>
            <Button
                variant="outline"
                size="sm"
                disabled={!canDeploy || act.isPending}
                title={
                    canDeploy
                        ? undefined
                        : "Pick rows that are ready and not live, at most one per model"
                }
                onClick={() => act.mutate(deploySelected)}
            >
                <Rocket />
                Deploy
            </Button>
            <Button
                variant="outline"
                size="sm"
                disabled={!canUndeploy || act.isPending}
                onClick={() => act.mutate(undeploySelected)}
            >
                <PowerOff />
                Undeploy
            </Button>
            <Button
                variant="destructive"
                size="sm"
                disabled={act.isPending}
                onClick={() =>
                    onConfirm(
                        bulkDeleteConfirmation(chosen, () => deleteSelected(chosen).then(onDone)),
                    )
                }
            >
                <Trash2 />
                Delete
            </Button>
            <ErrorLine error={act.error} />
            <Button variant="ghost" size="sm" className="ml-auto" onClick={onClear}>
                Clear selection
            </Button>
        </div>
    );
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
    const models = useModels();
    const [testing, setTesting] = useState<ModelRow | null>(null);
    const [editing, setEditing] = useState<ModelRow | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
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
            createFrom: (base) =>
                router.history.push(`/models/new?base=${encodeURIComponent(base)}`),
            refresh,
        }),
        [router, refresh],
    );
    const rows = models.data ?? [];
    const entries = entriesOf(rows);
    const sort = parseSort(search.sort);
    const setSort = (next: Sort) => {
        const value = sortValue(next);
        update({ sort: value === sortValue(DEFAULT_SORT) ? "" : value });
    };
    const toggleSort = (key: SortKey) =>
        setSort(
            sort.key === key
                ? { key, direction: opposite(sort.direction) }
                : { key, direction: SORTS[key].initial },
        );
    const visible = entries.filter((entry) => matches(entry, search)).sort(sorter(sort));
    const facetCount = (facet: Facet, test: (entry: Entry) => boolean) =>
        entries.filter((entry) => matches(entry, search, facet) && test(entry)).length;
    const filtering = Boolean(search.q || search.state);
    const clear = () => update(CLEARED);
    const firstRun = !rows.some((row) => row.kind === "custom") && !filtering;
    const stateOptions = STATE_RANK.map((state) => ({
        value: state,
        label: STATE_LABELS[state],
        count: facetCount("state", (entry) => stateOfEntry(entry) === state),
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
            {selected.length > 0 ? (
                <BulkBar
                    chosen={entries.filter((entry) => selected.includes(entry.key))}
                    onClear={() => setSelected([])}
                    onConfirm={setConfirmation}
                    onDone={async () => {
                        setSelected([]);
                        await refresh();
                    }}
                />
            ) : (
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
                        <SortSelect value={sort} onSort={setSort} />
                    </div>
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
                <ModelList
                    entries={visible}
                    on={on}
                    selected={selected}
                    onSelected={setSelected}
                    sort={sort}
                    onSort={toggleSort}
                    empty={noMatch}
                />
            )}
            <TestBaseDialog row={testing} onOpenChange={(open) => !open && setTesting(null)} />
            <EditModelDialog row={editing} onOpenChange={(open) => !open && setEditing(null)} />
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
        </div>
    );
}
