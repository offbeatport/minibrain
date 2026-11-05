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
    Wrench,
    X,
} from "lucide-react";
import {
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
    Separator,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import { type CSSProperties, Fragment, type ReactNode, useMemo, useRef, useState } from "react";
import { type ModelRow, api, removed, unwrap } from "~/api/client";
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
import { type HealthAction, HealthStatus } from "~/components/models/HealthStatus";
import { Requests, failingShare } from "~/components/models/ModelMetrics";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import { TeardownStatus } from "~/components/models/TeardownStatus";
import { type Abilities, useCan } from "~/lib/access";
import {
    deploymentPageHref,
    evaluationsHref,
    modelDataHref,
    playgroundHref,
    trainingHref,
} from "~/lib/modelLinks";
import type { ModelsSearch } from "~/lib/modelsSearch";
import {
    RETRY_LABELS,
    beingDeleted,
    builtOn,
    busyTearingDown,
    deleteModel,
    retryTeardown,
    rowId,
    setDeployed,
} from "~/lib/teardown";
import { bytes, exactTime, relativeTime } from "~/lib/time";
import { DeleteModelsDialog } from "./DeleteModelsDialog";
import { ModelsEmpty } from "./ModelsEmpty";
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
    entryHealth,
    entryTeardown,
    failingEntry,
    stateOfEntry,
    usageOf,
} from "./entries";
import { useHealthActions } from "./healthActions";

const AVAILABILITY_LABELS: Record<string, string> = {
    available: "Available",
    downloading: "Downloading",
    importing: "Importing",
    missing: "Missing files",
    not_downloaded: "Not downloaded",
    evicted: "Removed to free space",
};
const AVAILABILITY_TONES: Record<string, Tone> = {
    available: "success",
    downloading: "info",
    importing: "info",
    missing: "destructive",
    not_downloaded: "neutral",
    evicted: "neutral",
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
    stopping: "info",
    stop_failed: "destructive",
};

export function detailHref(row: ModelRow): string {
    return `/models/${row.kind}/${encodeURIComponent(row.key)}`;
}

const MODEL_PAGES: Record<string, (slug: string) => string> = {
    "/deployments": deploymentPageHref,
    "/training": trainingHref,
    "/evaluations": evaluationsHref,
    "/playground": playgroundHref,
};

function scoped(path: string, row: ModelRow): string {
    return (MODEL_PAGES[path] ?? modelDataHref)(row.key);
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
    const label =
        state === "evicted" && row.health?.state === "evicted"
            ? row.health.label
            : AVAILABILITY_LABELS[state];
    const moving = state === "downloading" || state === "importing";
    const subject = moving && row.kind === "custom" ? `${label} base` : label;
    return (
        <div className="flex items-center gap-2">
            <StatusText tone={AVAILABILITY_TONES[state]}>
                {subject}
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
              ? scoped("/training", row)
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
    stopping: "Stopping",
    stop_failed: "Stop failed",
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
    remove: (row: ModelRow) => void;
    createFrom: (base: string) => void;
    refresh: () => Promise<unknown>;
    health: (row: ModelRow, action: HealthAction) => void;
};

function healthStep(row: ModelRow, action: HealthAction | undefined, on: Handlers) {
    return action ? { label: action.label, run: () => on.health(row, action) } : null;
}

function retry(row: ModelRow) {
    return unwrap(api.POST("/api/models/base/{key}/retry", { params: { path: { key: row.key } } }));
}

function teardownStep(row: ModelRow, on: Handlers): { label: string; run: () => void } | null {
    const teardown = row.teardown;
    if (teardown?.state !== "failed") {
        return null;
    }
    return { label: RETRY_LABELS[teardown.kind], run: () => retryTeardown(row).then(on.refresh) };
}

function primaryAction(row: ModelRow, on: Handlers): { label: string; run: () => void } | null {
    const deployed = row.deployment.state === "running";
    if (row.teardown) {
        return teardownStep(row, on);
    }
    if (row.health) {
        return healthStep(row, row.health.actions[0], on);
    }
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
        return { label: "Train", run: () => on.open(scoped("/training", row)) };
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

function DeployedWarning({ row }: { row: ModelRow }) {
    return (
        <p>
            It has to be undeployed before it can be deleted. Apps calling{" "}
            <span className="font-mono">{row.key}</span> get errors from then on.
        </p>
    );
}

function promoteVersion(row: ModelRow, number: number) {
    return unwrap(
        api.POST("/api/minibrains/{slug}/versions/{number}/promote", {
            params: { path: { slug: row.key, number } },
        }),
    );
}

function deleteVersion(row: ModelRow, number: number) {
    return removed(
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
    if (row.teardown) {
        return entryTeardown(entry) ? teardownStep(row, on) : null;
    }
    const health = entryHealth(entry);
    if (health) {
        return healthStep(row, health.actions[0], on);
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

function TrainItem({
    label,
    blocked,
    onSelect,
}: {
    label: string;
    blocked: { label: string } | null;
    onSelect: () => void;
}) {
    if (!blocked) {
        return (
            <DropdownMenuItem onSelect={onSelect}>
                <GraduationCap />
                {label}
            </DropdownMenuItem>
        );
    }
    return (
        <DropdownMenuItem disabled className="items-start">
            <GraduationCap className="mt-0.5" />
            <span className="flex flex-col">
                <span>{label}</span>
                <span className="text-sm text-muted-foreground">{`Fix the base model first: ${blocked.label}`}</span>
            </span>
        </DropdownMenuItem>
    );
}

function ActionItems({ entry, on, admin }: { entry: Entry; on: Handlers; admin: boolean }) {
    const row = entry.model;
    const manages = admin || row.kind === "custom";
    const version = entry.version;
    const deployed = row.deployment.state !== "not_deployed";
    const transferring = row.kind === "base" && ["running", "queued"].includes(row.activity.state);
    const deployable =
        !row.health && (row.kind === "custom" || row.availability.state === "available");
    const fixes = entryHealth(entry)?.actions ?? [];
    const retryable = row.teardown?.state === "failed" ? row.teardown : null;
    return (
        <>
            {retryable && (manages || retryable.kind === "undeploy") && (
                <DropdownMenuItem
                    className="md:hidden"
                    onSelect={() => retryTeardown(row).then(on.refresh)}
                >
                    <RotateCcw />
                    {RETRY_LABELS[retryable.kind]}
                </DropdownMenuItem>
            )}
            {fixes
                .filter((action) => manages && action.kind !== "remove")
                .map((action) => (
                    <DropdownMenuItem
                        key={action.kind}
                        className={action === fixes[0] ? "md:hidden" : undefined}
                        onSelect={() => on.health(row, action)}
                    >
                        <Wrench />
                        {action.label}
                    </DropdownMenuItem>
                ))}
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
            {manages && (
                <DropdownMenuItem onSelect={() => on.edit(row)}>
                    <Pencil />
                    Edit
                </DropdownMenuItem>
            )}
            {row.kind === "custom" && (
                <TrainItem
                    label="Train"
                    blocked={row.health?.state === "base_unusable" ? row.health : null}
                    onSelect={() => on.open(scoped("/training", row))}
                />
            )}
            {row.kind === "base" && row.availability.state === "available" && (
                <TrainItem
                    label="Train a model on it"
                    blocked={row.health ?? null}
                    onSelect={() => on.createFrom(row.key)}
                />
            )}
            {row.kind === "custom" && !version && (row.versions ?? []).length > 0 && (
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
            {admin && transferring && row.activity.job_id !== null && (
                <DropdownMenuItem onSelect={() => on.confirm(cancelTransferConfirmation(row, on))}>
                    <CircleX />
                    Cancel {TRANSFER_NOUNS[row.activity.kind ?? ""] ?? "download"}
                </DropdownMenuItem>
            )}
        </>
    );
}

const TRANSFER_NOUNS: Record<string, string> = {
    download: "download",
    import: "import",
    verify: "verification",
    repair: "repair",
};

function StopItems({ entry, on, admin }: { entry: Entry; on: Handlers; admin: boolean }) {
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
            {(admin || row.kind === "custom") && (
                <DropdownMenuItem variant="destructive" onSelect={() => on.remove(row)}>
                    <Trash2 />
                    {row.kind === "custom" ? "Delete model and all versions" : "Delete model"}
                </DropdownMenuItem>
            )}
        </>
    );
}

const VIEWER_STEPS = new Set(["Use API", "Review results", "Test", "Details"]);
const ADMIN_RETRIES = new Set(["Retry", RETRY_LABELS.delete]);

function allowedStep(
    step: { label: string; run: () => void } | null,
    row: ModelRow,
    can: Abilities,
): { label: string; run: () => void } | null {
    if (!step || can.admin) {
        return step;
    }
    if (!can.build) {
        return VIEWER_STEPS.has(step.label) ? step : null;
    }
    return row.kind === "base" && (row.health || ADMIN_RETRIES.has(step.label)) ? null : step;
}

function ViewerItems({ entry, on }: { entry: Entry; on: Handlers }) {
    const row = entry.model;
    const version = entry.version;
    return (
        <>
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
        </>
    );
}

function FailedDeleteItems({ row, on, admin }: { row: ModelRow; on: Handlers; admin: boolean }) {
    return (
        <>
            {(admin || row.kind === "custom") && (
                <DropdownMenuItem onSelect={() => retryTeardown(row).then(on.refresh)}>
                    <RotateCcw />
                    {RETRY_LABELS.delete}
                </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => on.open(detailHref(row))}>
                <Eye />
                View details
            </DropdownMenuItem>
        </>
    );
}

function RowActions({ entry, on }: { entry: Entry; on: Handlers }) {
    const row = entry.model;
    const can = useCan();
    const step = entry.version ? versionAction(entry, on) : primaryAction(row, on);
    const primary = allowedStep(step, row, can);
    const busy = busyTearingDown(row);
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
                        disabled={busy}
                        aria-label={`More actions for ${row.name}`}
                    >
                        <MoreHorizontal />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                    {can.build && row.teardown?.kind === "delete" ? (
                        <FailedDeleteItems row={row} on={on} admin={can.admin} />
                    ) : can.build ? (
                        <>
                            <ActionItems entry={entry} on={on} admin={can.admin} />
                            <DropdownMenuSeparator />
                            <StopItems entry={entry} on={on} admin={can.admin} />
                        </>
                    ) : (
                        <ViewerItems entry={entry} on={on} />
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

function failedLabel(entry: Entry): string {
    const { model, version } = entry;
    if (version) {
        return version.kind === "lora" && version.score === null
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
    const health = entryHealth(entry);
    const teardown = entryTeardown(entry);
    if (teardown) {
        return <TeardownStatus teardown={teardown} name={model.name} />;
    }
    if (health && !failingEntry(entry)) {
        return <HealthStatus health={health} />;
    }
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
        const checking = ["verify", "repair"].includes(model.activity.kind ?? "");
        const transferring = ["downloading", "importing"].includes(model.availability.state);
        return (model.kind === "base" && !checking) || transferring ? (
            <Availability row={model} />
        ) : (
            <Activity row={model} />
        );
    }
    if (model.kind === "base" && model.availability.state === "not_downloaded") {
        return <Availability row={model} />;
    }
    return <span className="text-muted-foreground">Not deployed</span>;
}

const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;

function summary(entry: Entry): string {
    const { model } = entry;
    const size = model.kind === "base" && model.size_bytes ? bytes(model.size_bytes) : null;
    if (model.description) {
        return size ? `${size} · ${model.description}` : model.description;
    }
    if (model.kind === "base") {
        return size ? `Base model · ${size}` : "Base model";
    }
    return `On ${model.base_model}`;
}

function VersionCell({ entry }: { entry: Entry }) {
    const { model, version } = entry;
    if (version) {
        const score = version.score === null ? "" : ` · ${Math.round(version.score * 100)}%`;
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
    selecting,
    onSelect,
    widths,
}: {
    entry: Entry;
    on: Handlers;
    selected: boolean;
    selecting: boolean;
    onSelect: (selected: boolean) => void;
    widths: ColumnWidths;
}) {
    const { model } = entry;
    const deleting = beingDeleted(model);
    const greyed = deleting ? "opacity-60" : undefined;
    return (
        <li
            data-state={selected ? "selected" : undefined}
            aria-disabled={deleting || undefined}
            className={cn(
                ROW_GRID,
                "relative py-3 hover:bg-secondary has-[a:focus-visible]:bg-secondary data-[state=selected]:bg-accent/60",
            )}
        >
            {selecting && (
                <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden="true"
                    className="absolute inset-0 z-[5] cursor-pointer"
                    onClick={() => onSelect(!selected)}
                />
            )}
            <label className="relative z-10 -my-3 -ml-4 flex cursor-pointer items-center self-stretch py-3 pr-2 pl-4">
                <Checkbox
                    aria-label={`Select ${model.name}${entry.version ? ` v${entry.version.number}` : ""}`}
                    checked={selected}
                    disabled={deleting}
                    onCheckedChange={(value) => onSelect(value === true)}
                />
            </label>
            <div className={cn("flex min-w-0 items-center gap-3", greyed)}>
                <PublisherLogo publisher={model.publisher} name={model.name} />
                <div className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                        <Link
                            href={detailHref(model)}
                            className="truncate font-semibold text-foreground outline-none after:absolute after:inset-0 after:content-['']"
                        >
                            {model.name}
                        </Link>
                    </span>
                    <span
                        className="line-clamp-2 text-sm text-muted-foreground"
                        title={summary(entry)}
                    >
                        {summary(entry)}
                    </span>
                </div>
            </div>
            <div className={cn("hidden min-w-0 truncate md:block", greyed)}>
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
            <div className={cn("relative z-10 hidden min-w-0 md:block", greyed)}>
                <Requests
                    usage={usageOf(entry)}
                    live={
                        entry.version
                            ? entry.version.live
                            : entry.model.deployment.state !== "not_deployed"
                    }
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

const GROUPS = [
    { kind: "custom", label: "Your models" },
    { kind: "base", label: "Base models" },
] as const;

function groupFacts(kind: ModelRow["kind"], members: Entry[]): string {
    const models = unique(members.map((entry) => entry.model));
    const count = plural(models.length, "model");
    if (kind === "custom") {
        return count;
    }
    const disk = models
        .filter((row) => row.availability.state === "available")
        .reduce((sum, row) => sum + (row.size_bytes ?? 0), 0);
    return disk > 0 ? `${count} · ${bytes(disk)} on disk` : count;
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
                <label className="-ml-4 flex cursor-pointer items-center self-stretch pr-2 pl-4">
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
                </label>
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
                <div className="col-span-full flex min-h-72 flex-col items-center justify-center gap-3 px-4 text-center">
                    {empty}
                </div>
            ) : (
                <ul className="col-span-full grid grid-cols-subgrid divide-y">
                    {GROUPS.map((group) => {
                        const members = entries.filter((entry) => entry.model.kind === group.kind);
                        return (
                            members.length > 0 && (
                                <Fragment key={group.kind}>
                                    <li className="col-span-full flex items-baseline gap-2 px-4 pt-4 pb-1.5 text-sm text-muted-foreground">
                                        <span className="font-medium">{group.label}</span>
                                        <span className="tabular-nums">
                                            {groupFacts(group.kind, members)}
                                        </span>
                                    </li>
                                    {members.map((entry) => (
                                        <ModelListRow
                                            key={entry.key}
                                            entry={entry}
                                            on={on}
                                            selected={selected.includes(entry.key)}
                                            selecting={selected.length > 0}
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
                                </Fragment>
                            )
                        );
                    })}
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

async function deleteSelected(chosen: Entry[], rows: ModelRow[], cascade: boolean): Promise<void> {
    const whole = unique(chosen.filter((entry) => !entry.version).map((entry) => entry.model));
    const wholeKeys = new Set(whole.map(rowId));
    const cascading = new Set(
        whole
            .filter((row) => row.kind === "base")
            .filter((row) => {
                const built = builtOn(rows, row);
                return (
                    built.length > 0 &&
                    (cascade || built.every((item) => wholeKeys.has(rowId(item))))
                );
            })
            .map((row) => row.key),
    );
    const versions = [
        ...new Map(
            chosen
                .filter(
                    (entry) =>
                        entry.version &&
                        !wholeKeys.has(rowId(entry.model)) &&
                        !cascading.has(entry.model.base_model ?? ""),
                )
                .map((entry) => [`${rowId(entry.model)}@${entry.version?.number}`, entry]),
        ).values(),
    ];
    await undeploySelected(versions);
    for (const entry of versions) {
        await deleteVersion(entry.model, entry.version?.number ?? 0);
    }
    for (const row of whole) {
        if (row.kind === "custom" && cascading.has(row.base_model ?? "")) {
            continue;
        }
        await deleteModel(row, { undeploy: true, cascade: cascading.has(row.key) });
    }
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function BulkBar({
    chosen,
    onClear,
    onDelete,
    onDone,
}: {
    chosen: Entry[];
    onClear: () => void;
    onDelete: () => void;
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
            <Button variant="outline" size="sm" onClick={onClear}>
                <X />
                Clear selection
            </Button>
            <ErrorLine error={act.error} />
            <div className="ml-auto flex flex-wrap items-center gap-2">
                {canDeploy ? (
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={!canDeploy || act.isPending}
                        onClick={() => act.mutate(deploySelected)}
                    >
                        <Rocket />
                        Deploy
                    </Button>
                ) : (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="inline-flex">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={!canDeploy || act.isPending}
                                    onClick={() => act.mutate(deploySelected)}
                                >
                                    <Rocket />
                                    Deploy
                                </Button>
                            </span>
                        </TooltipTrigger>
                        <TooltipContent>
                            Pick rows that are ready and not live, at most one per model.
                        </TooltipContent>
                    </Tooltip>
                )}
                <Button
                    variant="outline"
                    size="sm"
                    disabled={!canUndeploy || act.isPending}
                    onClick={() => act.mutate(undeploySelected)}
                >
                    <PowerOff />
                    Undeploy
                </Button>
                <Separator
                    orientation="vertical"
                    className="mx-1 data-[orientation=vertical]:h-5"
                />
                <Button variant="destructive" size="sm" disabled={act.isPending} onClick={onDelete}>
                    <Trash2 />
                    Delete
                </Button>
            </div>
        </div>
    );
}

export function MyModels({
    search,
    update,
}: {
    search: ModelsSearch;
    update: (patch: ModelsSearch) => void;
}) {
    const can = useCan();
    const router = useRouter();
    const refresh = useModelsRefresh();
    const models = useModels();
    const [testing, setTesting] = useState<ModelRow | null>(null);
    const [editing, setEditing] = useState<ModelRow | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [deleting, setDeleting] = useState<Entry[] | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const healthActions = useRef<Handlers["health"] | null>(null);
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
                                ? ` (needs about ${bytes(row.needed_bytes)} memory)`
                                : ""}{" "}
                            if it is not running yet. It unloads after 15 minutes without requests;
                            nothing is deployed.
                        </p>
                    ),
                    confirmLabel: "Open playground",
                    run: async () => router.history.push(scoped("/playground", row)),
                });
            },
            edit: setEditing,
            confirm: setConfirmation,
            remove: (row) => setDeleting([{ key: rowId(row), model: row, version: null }]),
            createFrom: (base) =>
                router.history.push(`/models/new?base=${encodeURIComponent(base)}`),
            refresh,
            health: (row, action) => healthActions.current?.(row, action),
        }),
        [router, refresh],
    );
    const health = useHealthActions({ refresh, confirm: setConfirmation, remove: on.remove });
    healthActions.current = health.run;
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
            {can.build && selected.length > 0 ? (
                <BulkBar
                    chosen={entries.filter((entry) => selected.includes(entry.key))}
                    onClear={() => setSelected([])}
                    onDelete={() =>
                        setDeleting(entries.filter((entry) => selected.includes(entry.key)))
                    }
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
                    empty={rows.length === 0 ? <ModelsEmpty /> : noMatch}
                />
            )}
            <TestBaseDialog row={testing} onOpenChange={(open) => !open && setTesting(null)} />
            <EditModelDialog row={editing} onOpenChange={(open) => !open && setEditing(null)} />
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
            <DeleteModelsDialog
                chosen={deleting}
                rows={rows}
                onOpenChange={(open) => !open && setDeleting(null)}
                onDelete={async (cascade) => {
                    await deleteSelected(deleting ?? [], rows, cascade);
                    setSelected([]);
                    await refresh();
                }}
            />
            {health.dialogs}
        </div>
    );
}
