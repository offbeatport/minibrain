import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter, useRouterState } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import {
    Check,
    ChevronLeft,
    ExternalLink,
    Files,
    History,
    Info,
    Plug,
    ThumbsUp,
} from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardContent,
    DataGrid,
    Link,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import { useState } from "react";
import { type BaseModelDetail, type ModelRow, type VersionInfo, api, unwrap } from "~/api/client";
import { isActiveJob, keys, useBaseModel, useJobs, useModels, useVersions } from "~/api/queries";
import { ApiKeys } from "~/components/ApiKeys";
import { Facts } from "~/components/Facts";
import { FeedbackSince } from "~/components/FeedbackSince";
import { HarnessConfigs } from "~/components/HarnessConfigs";
import { JobPanel } from "~/components/JobPanel";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine, Page, PanelSection, PanelSections } from "~/components/Section";
import { FILE_STATES, type HealthAction } from "~/components/models/HealthStatus";
import { StatusText } from "~/components/models/StatusText";
import { useCan } from "~/lib/access";
import { percent } from "~/lib/format";
import {
    deploymentPageHref,
    evaluationsHref,
    modelCardHref,
    modelDataHref,
    trainingHref,
} from "~/lib/modelLinks";
import { modelsHref } from "~/lib/modelsSearch";
import {
    RETRY_LABELS,
    beingDeleted,
    builtOn,
    busyTearingDown,
    deleteModel,
    retryTeardown,
    setDeployed,
} from "~/lib/teardown";
import { bytes, exactTime, relativeTime } from "~/lib/time";
import { ModelDataNotice, withDataColumns } from "./data/versionData";
import { DeleteBaseDialog } from "./models/DeleteBaseDialog";
import { KeepOnDisk } from "./models/ModelCache";
import { Activity, Availability, Deployment, Updated } from "./models/MyModels";
import {
    ConfirmAction,
    type Confirmation,
    EditModelDialog,
    TestBaseDialog,
    useModelsRefresh,
} from "./models/dialogs";
import { useHealthActions } from "./models/healthActions";

function BackLink() {
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

function StatusStrip({ row }: { row: ModelRow }) {
    return (
        <Card>
            <CardContent className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-5">
                <div>
                    <p className="text-muted-foreground">Type</p>
                    <p>{row.kind === "base" ? "Base" : "Custom"}</p>
                </div>
                <div>
                    <p className="text-muted-foreground">Availability</p>
                    <Availability row={row} />
                </div>
                <div>
                    <p className="text-muted-foreground">Latest activity</p>
                    <Activity row={row} />
                </div>
                <div>
                    <p className="text-muted-foreground">Deployment</p>
                    <Deployment row={row} />
                </div>
                <div>
                    <p className="text-muted-foreground">Updated</p>
                    <Updated value={row.updated_at} />
                </div>
            </CardContent>
        </Card>
    );
}

function HealthNotice({
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
    const removed = health.state === "evicted";
    return (
        <div
            className={cn(
                "flex flex-wrap items-start justify-between gap-3 rounded-md border p-3 text-sm",
                removed
                    ? "border-info/40 bg-info-soft"
                    : "border-destructive/40 bg-destructive-soft",
            )}
        >
            <div className="flex min-w-0 max-w-3xl flex-col gap-1">
                <StatusText tone={removed ? "info" : "destructive"} className="font-semibold">
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

function TeardownNotice({
    row,
    canRetry,
    onRetried,
}: {
    row: ModelRow;
    canRetry: boolean;
    onRetried: () => Promise<unknown>;
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
                "flex flex-wrap items-start justify-between gap-3 rounded-md border p-3 text-sm",
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
            {failed && canRetry && <Button onClick={retry}>{RETRY_LABELS[teardown.kind]}</Button>}
        </div>
    );
}

function verifiedText(model: BaseModelDetail): string {
    if (!model.verified_at) {
        return "Each file is checked against the SHA-256 saved at install.";
    }
    return `Each file is checked against the SHA-256 saved at install; last verified ${relativeTime(model.verified_at)}.`;
}

function useJob(jobId: number | null | undefined) {
    return useQuery({
        queryKey: ["jobs", "detail", jobId],
        queryFn: () =>
            unwrap(api.GET("/api/jobs/{job_id}", { params: { path: { job_id: jobId ?? 0 } } })),
        enabled: jobId !== null && jobId !== undefined,
        refetchInterval: (query) =>
            query.state.data && isActiveJob(query.state.data) ? 2000 : false,
    });
}

function ApiSection({ model }: { model: BaseModelDetail }) {
    const origin = window.location.origin;
    const can = useCan();
    return (
        <>
            <PanelSection
                icon={Plug}
                title="API"
                description={
                    model.deployed
                        ? `Call it as ${model.key} on the OpenAI-compatible endpoint.`
                        : "Deploy it to call it from the API; keys can be created now."
                }
            >
                <div id="api">
                    <HarnessConfigs baseUrl={`${origin}/v1`} model={model.key} keyValue={null} />
                </div>
            </PanelSection>
            {can.build && <ApiKeys scope={{ kind: "base", key: model.key }} />}
        </>
    );
}

function BaseModelView({ model }: { model: BaseModelDetail }) {
    const router = useRouter();
    const can = useCan();
    const refresh = useModelsRefresh();
    const queryClient = useQueryClient();
    const [testing, setTesting] = useState<ModelRow | null>(null);
    const [editing, setEditing] = useState<ModelRow | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [removing, setRemoving] = useState<ModelRow | null>(null);
    const models = useModels();
    const dependents = builtOn(models.data ?? [], model);
    const job = useJob(model.activity.job_id ?? model.availability.job_id);
    const reload = async () => {
        await refresh();
        await queryClient.invalidateQueries({ queryKey: keys.baseModel(model.key) });
    };
    const deployed = model.deployed;
    const tearingDown = busyTearingDown(model);
    const available = model.availability.state === "available" && !model.health && !tearingDown;
    const health = useHealthActions({
        refresh: reload,
        confirm: setConfirmation,
        remove: (row) => {
            if (dependents.length > 0) {
                setRemoving(row);
                return;
            }
            setConfirmation({
                title: `Delete ${row.name}?`,
                description: (
                    <p>
                        {model.relocated
                            ? `Its record and API keys are removed; the files in ${model.storage_path} stay.`
                            : "Its record, files and API keys are removed. You can download or import it again later."}
                        {deployed ? " It is deployed, so it stops serving first." : ""}
                    </p>
                ),
                confirmLabel: deployed ? "Undeploy and delete" : "Delete",
                destructive: true,
                run: () =>
                    deleteModel(row, { undeploy: deployed })
                        .then(refresh)
                        .then(() => router.history.push(modelsHref())),
            });
        },
    });
    const busy = ["running", "queued"].includes(model.activity.state);
    const verify = () => health.run(model, { kind: "verify", label: "Verify files" });
    const deployConfirmation = (): Confirmation => ({
        title: deployed ? `Undeploy ${model.name}?` : `Deploy ${model.name}?`,
        description: deployed ? (
            <p>Its API stops answering; keys and files stay.</p>
        ) : (
            <p>
                It becomes callable as <span className="font-mono">{model.key}</span>
                {model.needed_bytes ? ` and uses about ${bytes(model.needed_bytes)} of memory` : ""}
                .
            </p>
        ),
        confirmLabel: deployed ? "Undeploy" : "Deploy",
        destructive: deployed,
        run: () => setDeployed(model, !deployed).then(reload),
    });
    const repoLink = model.repo ? (
        <a
            href={`https://huggingface.co/${model.repo}/tree/${model.revision ?? "main"}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-primary hover:underline"
        >
            {model.repo}@{(model.revision ?? "").slice(0, 12)}
            <ExternalLink className="ml-0.5 inline size-3.5" />
        </a>
    ) : (
        "—"
    );
    return (
        <>
            <PageHeader
                title={model.name}
                icon={<PublisherLogo publisher={model.publisher} name={model.name} size="lg" />}
                caption={model.description || model.key}
                actions={
                    <>
                        {available && (
                            <Button variant="outline" onClick={() => setTesting(model)}>
                                Test
                            </Button>
                        )}
                        {can.build && !tearingDown && (available || deployed) && (
                            <Button
                                variant={deployed ? "outline" : "default"}
                                onClick={() => setConfirmation(deployConfirmation())}
                            >
                                {deployed ? "Undeploy" : "Deploy"}
                            </Button>
                        )}
                        {can.admin && !beingDeleted(model) && (
                            <Button variant="ghost" onClick={() => setEditing(model)}>
                                Edit
                            </Button>
                        )}
                    </>
                }
            />
            <StatusStrip row={model} />
            <TeardownNotice
                row={model}
                canRetry={can.admin || (can.build && model.teardown?.kind === "undeploy")}
                onRetried={reload}
            />
            <HealthNotice
                row={model}
                run={can.admin ? health.run : undefined}
                shown={(action) => action.kind !== "verify" || model.health?.actions[0] === action}
            />
            <PanelSections>
                <PanelSection icon={Info} title="Overview">
                    <Facts
                        items={[
                            [
                                "Source",
                                model.source === "download"
                                    ? "Downloaded from the catalogue"
                                    : `Imported from ${model.source_path?.replace(/^\w+:/, "")}`,
                            ],
                            ["Repository", repoLink],
                            [
                                "Verification",
                                model.verified ? (
                                    "Every file matches the catalogue checksums"
                                ) : (
                                    <Badge key="verification" variant="warning">
                                        Not verified against the catalogue
                                    </Badge>
                                ),
                            ],
                            [
                                "Update",
                                model.update_available
                                    ? `A newer revision is published (${(model.latest_revision ?? "").slice(0, 12)}); this pin stays until you choose.`
                                    : "Pinned revision is current",
                            ],
                            [
                                "Licence",
                                model.license_name ? (
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
                                ) : (
                                    (model.license ?? "—")
                                ),
                            ],
                            ["Size", `${bytes(model.size_bytes)} in ${model.files.length} files`],
                            [
                                "Last used",
                                model.last_used_at ? (
                                    <Updated key="used" value={model.last_used_at} />
                                ) : (
                                    "—"
                                ),
                            ],
                            ["Pinned", <KeepOnDisk key="pinned" model={model} />],
                            [
                                "Content hash",
                                model.content_hash ? (
                                    <span key="hash" className="font-mono">
                                        {model.content_hash.slice(0, 16)}
                                    </span>
                                ) : (
                                    "—"
                                ),
                            ],
                            [
                                "Storage",
                                <span key="storage" className="font-mono">
                                    {model.storage_path}
                                </span>,
                            ],
                        ]}
                    />
                    {model.error && !model.health && (
                        <p className="mt-2 text-sm text-destructive">{model.error}</p>
                    )}
                </PanelSection>
                {job.data && <JobPanel job={job.data} slug="" />}
                <PanelSection
                    icon={Files}
                    title="Files"
                    description={verifiedText(model)}
                    actions={
                        can.admin &&
                        model.availability.state === "available" && (
                            <Button variant="outline" onClick={verify} disabled={busy}>
                                Verify files
                            </Button>
                        )
                    }
                    bare
                >
                    <DataGrid columns={FILE_COLUMNS} rows={model.files} empty="No files yet." />
                </PanelSection>
                <ApiSection model={model} />
            </PanelSections>
            <TestBaseDialog row={testing} onOpenChange={(open) => !open && setTesting(null)} />
            <EditModelDialog row={editing} onOpenChange={(open) => !open && setEditing(null)} />
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
            <DeleteBaseDialog
                row={removing}
                dependents={removing ? dependents : []}
                onOpenChange={(open) => !open && setRemoving(null)}
                onStarted={reload}
            />
            {health.dialogs}
        </>
    );
}

const FILE_COLUMNS: ColumnDef<BaseModelDetail["files"][number], unknown>[] = [
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

function FileHash({ file }: { file: BaseModelDetail["files"][number] }) {
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
        return hash;
    }
    return (
        <span className="inline-flex items-center gap-2">
            <StatusText tone={FILE_STATES[state].tone}>{FILE_STATES[state].label}</StatusText>
            {hash}
        </span>
    );
}

const VERSION_COLUMNS: ColumnDef<VersionInfo, unknown>[] = [
    {
        header: "Revision",
        id: "number",
        cell: ({ row }) => (
            <span className="flex items-center gap-2">
                <span className="font-semibold">v{row.original.number}</span>
                {row.original.current && <Badge variant="success">Deployed</Badge>}
            </span>
        ),
    },
    {
        header: "Kind",
        id: "kind",
        cell: ({ row }) => (row.original.kind === "lora" ? "Trained" : "Prompt-only"),
    },
    { header: "Status", id: "status", cell: ({ row }) => row.original.status },
    {
        header: "Held-out accuracy",
        id: "accuracy",
        cell: ({ row }) => percent(row.original.held_out?.accuracy),
    },
    { header: "Created", id: "created", cell: ({ row }) => exactTime(row.original.created_at) },
];

function CustomModelView({ row }: { row: ModelRow }) {
    const versions = useVersions(row.key);
    const can = useCan();
    const refresh = useModelsRefresh();
    const jobs = useJobs(row.key);
    const deleting = beingDeleted(row);
    const [editing, setEditing] = useState<ModelRow | null>(null);
    const router = useRouter();
    const recipe = useRouterState({
        select: (state) => {
            const search = state.location.search as { rows?: unknown; epochs?: unknown };
            return search.rows && search.epochs
                ? `?rows=${String(search.rows)}&epochs=${String(search.epochs)}`
                : "";
        },
    });
    const active = (jobs.data ?? []).filter(isActiveJob);
    const open = (_row: ModelRow, action: HealthAction) => {
        if (action.kind === "open_base" && row.base_model) {
            router.history.push(`/models/base/${encodeURIComponent(row.base_model)}`);
        }
    };
    return (
        <>
            <PageHeader
                title={row.name}
                icon={<PublisherLogo publisher={row.publisher} name={row.name} size="lg" />}
                caption={row.description || `Custom model on ${row.base_model}`}
                actions={
                    <>
                        {can.build && (
                            <Button
                                variant="outline"
                                disabled={deleting}
                                onClick={() => router.history.push(modelDataHref(row.key))}
                            >
                                Data
                            </Button>
                        )}
                        {can.build && (
                            <Button
                                variant="outline"
                                disabled={deleting}
                                onClick={() =>
                                    router.history.push(`${trainingHref(row.key)}${recipe}`)
                                }
                            >
                                Train
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            onClick={() => router.history.push(evaluationsHref(row.key))}
                        >
                            Review results
                        </Button>
                        {row.deployment.state !== "not_deployed" && (
                            <Button
                                onClick={() => router.history.push(deploymentPageHref(row.key))}
                            >
                                Use API
                            </Button>
                        )}
                        {can.build && (
                            <Button
                                variant="ghost"
                                disabled={deleting}
                                onClick={() => setEditing(row)}
                            >
                                Edit
                            </Button>
                        )}
                    </>
                }
            />
            <StatusStrip row={row} />
            <TeardownNotice row={row} canRetry={can.build} onRetried={refresh} />
            <HealthNotice row={row} run={open} />
            <ModelDataNotice slug={row.key} />
            {active.map((job) => (
                <JobPanel key={job.id} job={job} slug={row.key} />
            ))}
            <PanelSection
                icon={History}
                title="Revisions"
                description="Each training or scoring run creates a revision; one is deployed at a time. Open one for its model card."
                bare
            >
                <DataGrid
                    columns={withDataColumns(VERSION_COLUMNS, versions.data ?? [])}
                    rows={versions.data ?? []}
                    getRowId={(version) => String(version.number)}
                    onOpen={(version) =>
                        router.history.push(modelCardHref(row.key, version.number))
                    }
                    rowLabel={(version) => `Model card for v${version.number}`}
                    rowActions={(version) => (
                        <Button variant="outline" size="xs" asChild>
                            <Link href={modelCardHref(row.key, version.number)}>Model card</Link>
                        </Button>
                    )}
                    empty="No revisions yet: add training data on Training, then train or score a prompt."
                />
            </PanelSection>
            <PanelSection
                icon={ThumbsUp}
                title="Feedback"
                description="Answers marked right or wrong in the playground and through the API."
            >
                <FeedbackSince slug={row.key} />
            </PanelSection>
            <EditModelDialog row={editing} onOpenChange={(open) => !open && setEditing(null)} />
        </>
    );
}

export function BaseModelPage() {
    const { key } = useParams({ strict: false }) as { key?: string };
    const model = useBaseModel(key ?? "");
    return (
        <Page>
            <BackLink />
            {model.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            <ErrorLine error={model.error} />
            {model.data && <BaseModelView model={model.data} />}
        </Page>
    );
}

export function CustomModelPage() {
    const { slug } = useParams({ strict: false }) as { slug?: string };
    const models = useModels();
    const row = models.data?.find((item) => item.kind === "custom" && item.key === slug);
    return (
        <Page>
            <BackLink />
            {models.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            <ErrorLine error={models.error} />
            {models.data && !row && (
                <p className="text-sm text-muted-foreground">Model {slug} was not found.</p>
            )}
            {row && <CustomModelView row={row} />}
        </Page>
    );
}
