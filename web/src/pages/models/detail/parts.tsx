import { useParams, useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Check, ChevronLeft, Plug } from "lucide-react";
import {
    Badge,
    Button,
    DataGrid,
    Link,
    TabNav,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import { type ReactNode, useEffect, useState } from "react";
import type { BaseModelDetail, KeyCreated, ModelRef, ModelRow } from "~/api/client";
import { ApiKeys } from "~/components/ApiKeys";
import { HarnessConfigs } from "~/components/HarnessConfigs";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine, PanelSection } from "~/components/Section";
import { FILE_STATES, type HealthAction } from "~/components/models/HealthStatus";
import { StatusText, type Tone } from "~/components/models/StatusText";
import { useCan } from "~/lib/access";
import { jobPageHref } from "~/lib/jobs";
import { type ModelTab, modelPageHref, playgroundHref } from "~/lib/modelLinks";
import { modelsHref } from "~/lib/modelsSearch";
import {
    RETRY_LABELS,
    REVIEW_LABEL,
    needsReview,
    retryTeardown,
    setDeployed,
} from "~/lib/teardown";
import { bytes, exactTime, relativeTime } from "~/lib/time";
import { Updated } from "../MyModels";
import type { Confirmation } from "../dialogs";

const DEPLOYMENT_STATUS: Record<string, { tone: Tone; label: string }> = {
    running: { tone: "success", label: "Live" },
    starting: { tone: "info", label: "Starting" },
    unhealthy: { tone: "destructive", label: "Unhealthy" },
    stopping: { tone: "info", label: "Stopping" },
    stop_failed: { tone: "destructive", label: "Stop failed" },
    not_deployed: { tone: "neutral", label: "Not deployed" },
};

const TAB_LABELS: Record<ModelTab, string> = {
    overview: "Overview",
    versions: "Versions",
    data: "Data",
    api: "API",
    files: "Files",
};

export const BASE_TABS: ModelTab[] = ["overview", "api"];
export const CUSTOM_TABS: ModelTab[] = ["overview", "versions", "data", "api"];

export function BackLink() {
    return (
        <Link
            href={modelsHref()}
            className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
            <ChevronLeft className="size-4" />
            Models
        </Link>
    );
}

export function useModelTab(row: ModelRow | undefined): ModelTab {
    const { tab } = useParams({ strict: false }) as { tab?: string };
    const router = useRouter();
    const tabs = row?.kind === "base" ? BASE_TABS : CUSTOM_TABS;
    const known = [...tabs, "files" as const].find((item) => item === tab);
    const unknown = row !== undefined && tab !== undefined && !known;
    const key = row?.key;
    useEffect(() => {
        if (unknown && key) {
            router.history.replace(modelPageHref(key));
        }
    }, [unknown, key, router]);
    return known ?? "overview";
}

export function ModelTabs({ row }: { row: ModelRow }) {
    const tabs = row.kind === "base" ? BASE_TABS : CUSTOM_TABS;
    return (
        <TabNav
            label={`${row.name} pages`}
            tabs={tabs.map((tab) => ({
                href: modelPageHref(row.key, tab),
                label: TAB_LABELS[tab],
            }))}
        />
    );
}

function DeploymentStatus({ row }: { row: ModelRow }) {
    const status = DEPLOYMENT_STATUS[row.deployment.state] ?? {
        tone: "neutral",
        label: row.deployment.label,
    };
    return (
        <StatusText tone={status.tone} className="px-1 text-sm">
            {status.label}
        </StatusText>
    );
}

export function ModelHeader({
    row,
    caption,
    deployed,
    onDeploy,
    actions,
}: {
    row: ModelRow;
    caption: ReactNode;
    deployed: boolean;
    onDeploy?: () => void;
    actions?: ReactNode;
}) {
    return (
        <PageHeader
            title={row.name}
            icon={<PublisherLogo publisher={row.publisher} name={row.name} size="lg" />}
            badge={<Badge variant="outline">{row.kind === "base" ? "Base" : "Custom"}</Badge>}
            caption={caption}
            actions={
                <>
                    {row.can_test && (
                        <Button variant="outline" asChild>
                            <Link href={playgroundHref(row.key)}>Open in Playground</Link>
                        </Button>
                    )}
                    {actions}
                    <DeploymentStatus row={row} />
                    {onDeploy && (
                        <Button variant={deployed ? "outline" : "default"} onClick={onDeploy}>
                            {deployed ? "Undeploy" : "Deploy"}
                        </Button>
                    )}
                </>
            }
        />
    );
}

export function deployConfirmation(
    row: ModelRow,
    deployed: boolean,
    deployText: ReactNode,
    after: () => Promise<unknown>,
): Confirmation {
    return {
        title: deployed ? `Undeploy ${row.name}?` : `Deploy ${row.name}?`,
        description: deployed ? (
            <p>{`Its API stops answering; keys and ${row.kind === "base" ? "files" : "versions"} stay.`}</p>
        ) : (
            deployText
        ),
        confirmLabel: deployed ? "Undeploy" : "Deploy",
        destructive: deployed,
        run: () => setDeployed(row, !deployed).then(after),
    };
}

export function HealthNotice({
    row,
    run,
    shown = () => true,
}: {
    row: ModelRow;
    run?: (row: ModelRow, action: HealthAction) => void;
    shown?: (action: HealthAction) => boolean;
}) {
    const health = row.health;
    if (!health) {
        return null;
    }
    const actions = run ? health.actions.filter(shown) : [];
    return (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive-soft p-3">
            <div className="flex min-w-0 max-w-3xl flex-col gap-1">
                <StatusText tone="destructive" className="font-semibold">
                    {health.label}
                </StatusText>
                <p>{health.detail}</p>
            </div>
            {actions.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                    {actions.map((action, index) => (
                        <Button
                            key={action.kind}
                            variant={index === 0 ? "default" : "outline"}
                            onClick={() => run?.(row, action)}
                        >
                            {action.label}
                        </Button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function TeardownNotice({
    row,
    canRetry,
    onRetried,
    onReview,
}: {
    row: ModelRow;
    canRetry: boolean;
    onRetried: () => Promise<unknown>;
    onReview?: () => void;
}) {
    const teardown = row.teardown;
    const [error, setError] = useState<unknown>(null);
    if (!teardown) {
        return null;
    }
    const failed = teardown.state === "failed";
    const retry = () =>
        retryTeardown(row)
            .then(onRetried)
            .then(() => setError(null), setError);
    return (
        <div
            className={cn(
                "flex flex-wrap items-start justify-between gap-3 rounded-md border p-3",
                failed
                    ? "border-destructive/40 bg-destructive-soft"
                    : "border-info/40 bg-info-soft",
            )}
        >
            <div className="flex min-w-0 max-w-3xl flex-col gap-1">
                <StatusText tone={failed ? "destructive" : "info"} className="font-semibold">
                    {teardown.label}
                </StatusText>
                <p>{teardown.detail}</p>
                <p className="text-muted-foreground">
                    {`Started by ${teardown.started_by} ${relativeTime(teardown.started_at)}.`}
                </p>
                <ErrorLine error={error} />
            </div>
            {failed && canRetry && onReview && needsReview(teardown) ? (
                <Button onClick={onReview}>{REVIEW_LABEL}</Button>
            ) : (
                failed && canRetry && <Button onClick={retry}>{RETRY_LABELS[teardown.kind]}</Button>
            )}
        </div>
    );
}

type Fact = [string, ReactNode];

function activityText(row: ModelRow): string {
    const { label, progress, state } = row.activity;
    return state === "running" && progress !== null && progress !== undefined
        ? `${label} ${Math.round(progress * 100)}%`
        : label;
}

export function activityFacts(row: ModelRow): Fact[] {
    const { state, job_id: jobId } = row.activity;
    if (state !== "running" && state !== "queued") {
        return [];
    }
    const text = <span className="tabular-nums">{activityText(row)}</span>;
    return [
        [
            "Latest activity",
            jobId ? (
                <Link
                    key="activity"
                    href={jobPageHref(jobId)}
                    className="text-primary hover:underline"
                >
                    {text}
                </Link>
            ) : (
                text
            ),
        ],
    ];
}

export function updatedFacts(row: ModelRow): Fact[] {
    return [["Updated", <Updated key="updated" value={row.updated_at} />]];
}

export function parametersText(count: number): string {
    return count >= 1e9
        ? `${(count / 1e9).toFixed(1)}B`
        : `${Math.max(1, Math.round(count / 1e6))}M`;
}

function licence(model: BaseModelDetail): ReactNode {
    if (!model.license_name) {
        return model.license ?? "—";
    }
    return (
        <span key="licence">
            {model.license_url ? (
                <a
                    href={model.license_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                >
                    {model.license_name}
                </a>
            ) : (
                model.license_name
            )}
            {model.license_ack_at &&
                ` · accepted by ${model.license_ack_by} on ${exactTime(model.license_ack_at)}`}
        </span>
    );
}

export function baseFacts(model: BaseModelDetail): Fact[] {
    return [
        ["Publisher", model.publisher ?? "—"],
        [
            "Parameters",
            <span key="parameters" className="tabular-nums">
                {model.parameters ? parametersText(model.parameters) : "—"}
            </span>,
        ],
        [
            "Context",
            <span key="context" className="tabular-nums">
                {model.context_tokens ? `${model.context_tokens.toLocaleString()} tokens` : "—"}
            </span>,
        ],
        ["Licence", licence(model)],
        [
            "Memory needed",
            <span key="memory" className="tabular-nums">
                {model.needed_bytes ? bytes(model.needed_bytes) : "—"}
            </span>,
        ],
    ];
}

type FileRow = {
    path: string;
    size: number;
    sha256: string | null;
    state?: BaseModelDetail["files"][number]["state"];
};

function FileHash({ file }: { file: FileRow }) {
    const state = file.state ?? "unchecked";
    const hash = (
        <span className="font-mono text-muted-foreground">
            {file.sha256 ? file.sha256.slice(0, 16) : "—"}
        </span>
    );
    if (state === "ok") {
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1.5 rounded-sm">
                        <Check aria-hidden="true" className="size-4 shrink-0 text-success" />
                        <span className="sr-only">Matches: </span>
                        {hash}
                    </span>
                </TooltipTrigger>
                <TooltipContent>Matches the SHA-256 saved at install</TooltipContent>
            </Tooltip>
        );
    }
    if (state === "unchecked") {
        return file.sha256 ? (
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="rounded-sm">{hash}</span>
                </TooltipTrigger>
                <TooltipContent className="font-mono">{file.sha256}</TooltipContent>
            </Tooltip>
        ) : (
            hash
        );
    }
    return (
        <span className="inline-flex items-center gap-2">
            <StatusText tone={FILE_STATES[state].tone}>{FILE_STATES[state].label}</StatusText>
            {hash}
        </span>
    );
}

const FILE_COLUMNS: ColumnDef<FileRow, unknown>[] = [
    {
        header: "File",
        accessorKey: "path",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
    {
        header: "Size",
        accessorKey: "size",
        cell: (info) => <span className="tabular-nums">{bytes(Number(info.getValue()))}</span>,
    },
    {
        header: "SHA-256",
        id: "sha256",
        accessorFn: (file) => `${file.state ?? "unchecked"} ${file.sha256 ?? ""}`,
        cell: ({ row }) => <FileHash file={row.original} />,
    },
];

export function FileTable({
    files,
    empty,
    loading = false,
}: {
    files: FileRow[];
    empty: string;
    loading?: boolean;
}) {
    return (
        <DataGrid
            columns={FILE_COLUMNS}
            rows={files}
            getRowId={(file) => file.path}
            loading={loading}
            empty={empty}
        />
    );
}

export function ApiTab({
    scope,
    model,
    description,
    actions,
}: {
    scope: ModelRef;
    model: string;
    description: ReactNode;
    actions?: ReactNode;
}) {
    const can = useCan();
    const [created, setCreated] = useState<KeyCreated | null>(null);
    return (
        <>
            {can.build && <ApiKeys scope={scope} onCreated={setCreated} />}
            <PanelSection icon={Plug} title="Call it" description={description} actions={actions}>
                <HarnessConfigs
                    baseUrl={`${window.location.origin}/v1`}
                    model={model}
                    keyValue={created?.secret ?? null}
                />
            </PanelSection>
        </>
    );
}
