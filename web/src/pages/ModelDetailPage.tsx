import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronLeft, ExternalLink, Files, History, Info, Plug } from "lucide-react";
import { Badge, Button, Card, CardContent, DataGrid, Link } from "obp-ui";
import { useState } from "react";
import { type BaseModelDetail, type ModelRow, type VersionInfo, api, unwrap } from "~/api/client";
import { isActiveJob, keys, useBaseModel, useJobs, useModels, useVersions } from "~/api/queries";
import { ApiKeys } from "~/components/ApiKeys";
import { Facts } from "~/components/Facts";
import { JobPanel } from "~/components/JobPanel";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine, Page, PanelSection, PanelSections } from "~/components/Section";
import { percent } from "~/lib/format";
import { modelsHref } from "~/lib/modelsSearch";
import { bytes, exactTime } from "~/lib/time";
import { Activity, Availability, Deployment, Updated } from "./models/MyModels";
import {
    ConfirmAction,
    type Confirmation,
    EditModelDialog,
    TestBaseDialog,
    useModelsRefresh,
} from "./models/dialogs";

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
                <pre
                    id="api"
                    className="overflow-x-auto rounded-md border bg-secondary p-3 font-mono text-sm"
                >
                    {`curl ${origin}/v1/chat/completions \\\n  -H "Authorization: Bearer $MINIBRAIN_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${model.key}", "messages": [{"role": "user", "content": "Hello"}]}'`}
                </pre>
            </PanelSection>
            <ApiKeys scope={{ kind: "base", key: model.key }} />
        </>
    );
}

function BaseModelView({ model }: { model: BaseModelDetail }) {
    const refresh = useModelsRefresh();
    const queryClient = useQueryClient();
    const [testing, setTesting] = useState<ModelRow | null>(null);
    const [editing, setEditing] = useState<ModelRow | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const job = useJob(model.activity.job_id ?? model.availability.job_id);
    const reload = async () => {
        await refresh();
        await queryClient.invalidateQueries({ queryKey: keys.baseModel(model.key) });
    };
    const path = { params: { path: { key: model.key } } };
    const deployed = model.deployed;
    const available = model.availability.state === "available";
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
        run: () =>
            unwrap(
                api.POST("/api/models/base/{key}/deploy", {
                    ...path,
                    body: { deployed: !deployed },
                }),
            ).then(reload),
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
                icon={<PublisherLogo publisher={model.publisher} name={model.name} />}
                caption={model.description || model.key}
                actions={
                    <>
                        {model.activity.state === "failed" && !available && (
                            <Button
                                onClick={() =>
                                    unwrap(api.POST("/api/models/base/{key}/retry", path)).then(
                                        reload,
                                    )
                                }
                            >
                                Retry
                            </Button>
                        )}
                        {available && (
                            <Button variant="outline" onClick={() => setTesting(model)}>
                                Test
                            </Button>
                        )}
                        {available && (
                            <Button
                                variant={deployed ? "outline" : "default"}
                                onClick={() => setConfirmation(deployConfirmation())}
                            >
                                {deployed ? "Undeploy" : "Deploy"}
                            </Button>
                        )}
                        <Button variant="ghost" onClick={() => setEditing(model)}>
                            Edit
                        </Button>
                    </>
                }
            />
            <StatusStrip row={model} />
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
                                "Storage",
                                <span key="storage" className="font-mono">
                                    {model.storage_path}
                                </span>,
                            ],
                        ]}
                    />
                    {model.error && <p className="mt-2 text-sm text-destructive">{model.error}</p>}
                </PanelSection>
                {job.data && <JobPanel job={job.data} slug="" />}
                <PanelSection
                    icon={Files}
                    title="Files"
                    description="Checked on download or import; each is re-checked by size when listed."
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
        accessorKey: "sha256",
        cell: (info) => (
            <span className="font-mono text-muted-foreground">
                {String(info.getValue() ?? "—").slice(0, 16)}
            </span>
        ),
    },
];

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
    const jobs = useJobs(row.key);
    const [editing, setEditing] = useState<ModelRow | null>(null);
    const router = useRouter();
    const scoped = (path: string) => `${path}?minibrain=${encodeURIComponent(row.key)}`;
    const active = (jobs.data ?? []).filter(isActiveJob);
    return (
        <>
            <PageHeader
                title={row.name}
                icon={<PublisherLogo publisher={row.publisher} name={row.name} />}
                caption={row.description || `Custom model on ${row.base_model}`}
                actions={
                    <>
                        <Button
                            variant="outline"
                            onClick={() => router.history.push(scoped("/data"))}
                        >
                            Data
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => router.history.push(scoped("/training"))}
                        >
                            Train
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => router.history.push(scoped("/evaluations"))}
                        >
                            Review results
                        </Button>
                        {row.deployment.state !== "not_deployed" && (
                            <Button onClick={() => router.history.push(scoped("/deployments"))}>
                                Use API
                            </Button>
                        )}
                        <Button variant="ghost" onClick={() => setEditing(row)}>
                            Edit
                        </Button>
                    </>
                }
            />
            <StatusStrip row={row} />
            {active.map((job) => (
                <JobPanel key={job.id} job={job} slug={row.key} />
            ))}
            <PanelSection
                icon={History}
                title="Revisions"
                description="Each training or scoring run creates a revision; one is deployed at a time."
                bare
            >
                <DataGrid
                    columns={VERSION_COLUMNS}
                    rows={versions.data ?? []}
                    empty="No revisions yet: add examples, then train or score a prompt."
                />
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
