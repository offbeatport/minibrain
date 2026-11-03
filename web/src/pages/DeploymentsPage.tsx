import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronLeft, History, Plug, Radio } from "lucide-react";
import { Badge, Button, DataGrid, Link } from "obp-ui";
import { useState } from "react";
import {
    type KeyCreated,
    type MinibrainDetail,
    type ModelRow,
    type ModelVersionRow,
    api,
    unwrap,
} from "~/api/client";
import { useMinibrain, useModels } from "~/api/queries";
import { ApiKeys } from "~/components/ApiKeys";
import { HarnessConfigs } from "~/components/HarnessConfigs";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine, Page, PanelSection, PanelSections } from "~/components/Section";
import { HealthStatus } from "~/components/models/HealthStatus";
import { LastUsed, Requests, failingShare } from "~/components/models/ModelMetrics";
import { StatusText } from "~/components/models/StatusText";
import { count, percent } from "~/lib/format";
import { Deployment as DeploymentCell } from "./models/MyModels";

function serving(detail: MinibrainDetail): string {
    if (!detail.deployed) {
        return "Not deployed";
    }
    if (detail.current_version === null || detail.current_version === undefined) {
        return `Serving base model ${detail.base_model} until you deploy a version`;
    }
    return detail.current_accuracy === null || detail.current_accuracy === undefined
        ? `Serving v${detail.current_version}`
        : `Serving v${detail.current_version} · ${percent(detail.current_accuracy)} held-out accuracy`;
}

function DeployToggle({ slug, deployed }: { slug: string; deployed: boolean }) {
    const client = useQueryClient();
    const toggle = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/minibrains/{slug}/deploy", {
                    params: { path: { slug } },
                    body: { deployed: !deployed },
                }),
            ),
        onSuccess: () => client.invalidateQueries(),
    });
    return (
        <Button
            variant={deployed ? "outline" : "default"}
            onClick={() => toggle.mutate()}
            disabled={toggle.isPending}
        >
            {deployed ? "Undeploy" : "Deploy"}
        </Button>
    );
}

function Connect({ slug }: { slug: string }) {
    const { data: detail } = useMinibrain(slug);
    const [created, setCreated] = useState<KeyCreated | null>(null);
    if (!detail) {
        return null;
    }
    const baseUrl = `${window.location.origin}/v1`;
    const model = detail.models[0] ?? slug;
    return (
        <>
            <PanelSection icon={Plug} title="Connect">
                <div className="flex flex-col gap-4 text-sm">
                    <div>
                        <div className="text-muted-foreground">Base URL</div>
                        <div className="font-mono">{baseUrl}</div>
                    </div>
                    <div>
                        <div className="text-muted-foreground">Model names</div>
                        {detail.models.length === 0 ? (
                            <div>No ready version yet.</div>
                        ) : (
                            <div className="flex flex-wrap gap-x-4 font-mono">
                                {detail.models.map((name) => (
                                    <span key={name}>{name}</span>
                                ))}
                            </div>
                        )}
                        <p className="text-muted-foreground">
                            <span className="font-mono">{slug}</span> follows the current version;{" "}
                            <span className="font-mono">{slug}@N</span> pins one.
                        </p>
                    </div>
                    <HarnessConfigs
                        baseUrl={baseUrl}
                        model={model}
                        keyValue={created?.secret ?? null}
                    />
                </div>
            </PanelSection>
            <ApiKeys scope={{ kind: "custom", key: slug }} onCreated={setCreated} />
        </>
    );
}

const KIND_NAMES: Record<string, string> = { lora: "Trained", prompt: "Prompt-only" };

export function deploymentHref(row: ModelRow): string {
    return row.kind === "custom"
        ? `/deployments/${encodeURIComponent(row.key)}`
        : `/models/base/${encodeURIComponent(row.key)}#api`;
}

function serves(row: ModelRow): string {
    if (row.kind === "base") {
        return row.revision ? `Base model · ${row.revision.slice(0, 7)}` : "Base model";
    }
    const current = row.versions?.find((version) => version.live);
    if (!current) {
        return `Base model ${row.base_model}`;
    }
    const kind = KIND_NAMES[current.kind] ?? current.kind;
    const score = current.accuracy === null ? "" : ` · ${Math.round(current.accuracy * 100)}%`;
    return `v${current.number} · ${kind}${score}`;
}

function DeploymentStatus({ row }: { row: ModelRow }) {
    if (row.health) {
        return <HealthStatus health={row.health} />;
    }
    const share = failingShare(row.usage);
    if (share >= 0.01) {
        return (
            <StatusText tone="destructive">{`${Math.round(share * 100)}% of requests failing`}</StatusText>
        );
    }
    return <DeploymentCell row={row} short />;
}

const LIVE_COLUMNS: ColumnDef<ModelRow, unknown>[] = [
    {
        id: "model",
        header: "Model",
        accessorFn: (row) => row.name.toLowerCase(),
        cell: ({ row }) => (
            <div className="flex min-w-44 items-center gap-2.5">
                <PublisherLogo
                    publisher={row.original.publisher}
                    name={row.original.name}
                    size="sm"
                />
                <Link
                    href={deploymentHref(row.original)}
                    className="truncate font-semibold text-foreground"
                >
                    {row.original.name}
                </Link>
            </div>
        ),
    },
    {
        id: "name",
        header: "API model name",
        accessorFn: (row) => row.key,
        cell: ({ row }) => <span className="font-mono">{row.original.key}</span>,
    },
    {
        id: "serves",
        header: "Serves",
        accessorFn: serves,
        cell: ({ row }) => <span className="tabular-nums">{serves(row.original)}</span>,
    },
    {
        id: "status",
        header: "Status",
        accessorFn: (row) => row.deployment.state,
        cell: ({ row }) => <DeploymentStatus row={row.original} />,
    },
    {
        id: "requests",
        header: "Requests, 7 days",
        accessorFn: (row) => row.usage?.total ?? 0,
        cell: ({ row }) => (
            <Requests
                usage={row.original.usage}
                live={row.original.deployment.state !== "not_deployed"}
            />
        ),
    },
    {
        id: "used",
        header: "Last used",
        accessorFn: (row) => row.usage?.last_at ?? "",
        cell: ({ row }) => <LastUsed usage={row.original.usage} />,
    },
    {
        id: "keys",
        header: "API keys",
        accessorFn: (row) => row.key_count ?? 0,
        cell: ({ row }) => (
            <span className="tabular-nums">{count(row.original.key_count ?? 0)}</span>
        ),
    },
];

export function DeploymentsPage() {
    const router = useRouter();
    const models = useModels();
    const live = (models.data ?? []).filter((row) => row.deployment.state !== "not_deployed");
    return (
        <Page wide>
            <PageHeader
                title="Deployments"
                caption="Everything apps can call now, on one OpenAI-compatible endpoint."
            />
            <ErrorLine error={models.error} />
            <PanelSections>
                <PanelSection icon={Radio} title="Live models" bare>
                    {models.isLoading ? (
                        <p className="text-sm text-muted-foreground">Loading…</p>
                    ) : (
                        <DataGrid
                            columns={LIVE_COLUMNS}
                            rows={live}
                            storageKey="minibrain.deployments.columns"
                            columnPicker
                            hiddenColumns={["used", "keys"]}
                            onOpen={(row) => router.history.push(deploymentHref(row))}
                            rowLabel={(row) => `${row.key}, serves ${serves(row)}`}
                            empty={
                                <p className="text-muted-foreground">
                                    Nothing is deployed. Deploy a model or one of its versions from
                                    Models.
                                </p>
                            }
                            minWidth="min-w-[760px]"
                        />
                    )}
                </PanelSection>
                <ApiKeys />
            </PanelSections>
        </Page>
    );
}

function VersionHistory({ row }: { row: ModelRow }) {
    const client = useQueryClient();
    const deploy = useMutation({
        mutationFn: (number: number) =>
            unwrap(
                api.POST("/api/minibrains/{slug}/versions/{number}/promote", {
                    params: { path: { slug: row.key, number } },
                }),
            ),
        onSuccess: () => client.invalidateQueries(),
    });
    const versions = row.versions ?? [];
    const columns: ColumnDef<ModelVersionRow, unknown>[] = [
        {
            header: "Version",
            id: "number",
            cell: ({ row: item }) => (
                <span className="flex items-center gap-2 tabular-nums">
                    {`v${item.original.number}`}
                    {item.original.live && <Badge variant="success">Live</Badge>}
                </span>
            ),
        },
        {
            header: "Kind",
            id: "kind",
            cell: ({ row: item }) => KIND_NAMES[item.original.kind] ?? item.original.kind,
        },
        {
            header: "Score",
            id: "score",
            cell: ({ row: item }) =>
                item.original.status === "failed" ? (
                    <StatusText tone="destructive">Failed</StatusText>
                ) : ["training", "evaluating"].includes(item.original.status) ? (
                    <StatusText tone="info">
                        {item.original.status === "training" ? "Training" : "Scoring"}
                    </StatusText>
                ) : item.original.accuracy === null ? (
                    <span className="text-muted-foreground">Not scored</span>
                ) : (
                    <span className="tabular-nums">{`${Math.round(item.original.accuracy * 100)}%`}</span>
                ),
        },
        {
            header: "Requests, 7 days",
            id: "requests",
            cell: ({ row: item }) => <Requests usage={item.original.usage} />,
        },
        {
            header: "Last used",
            id: "used",
            cell: ({ row: item }) => <LastUsed usage={item.original.usage} />,
        },
        {
            header: () => <span className="sr-only">Actions</span>,
            id: "actions",
            cell: ({ row: item }) =>
                item.original.status === "ready" && !item.original.live ? (
                    <Button
                        variant="outline"
                        size="xs"
                        disabled={deploy.isPending}
                        onClick={() => deploy.mutate(item.original.number)}
                    >
                        {`Deploy v${item.original.number}`}
                    </Button>
                ) : null,
        },
    ];
    return (
        <PanelSection icon={History} title="Versions" bare>
            <div className="flex flex-col gap-2">
                <DataGrid
                    columns={columns}
                    rows={versions}
                    empty="No versions yet: it serves its base model."
                />
                <ErrorLine error={deploy.error} />
            </div>
        </PanelSection>
    );
}

function DeploymentHeader({ row }: { row: ModelRow }) {
    const { data: detail } = useMinibrain(row.key);
    const status = detail ? ` · ${serving(detail)}` : "";
    return (
        <PageHeader
            title={row.name}
            icon={<PublisherLogo publisher={row.publisher} name={row.name} />}
            caption={`Apps call it as ${row.key}${status}`}
            actions={detail && <DeployToggle slug={row.key} deployed={detail.deployed ?? false} />}
        />
    );
}

export function DeploymentPage() {
    const { slug } = useParams({ strict: false }) as { slug?: string };
    const models = useModels();
    const row = models.data?.find((item) => item.kind === "custom" && item.key === slug);
    return (
        <Page>
            <Link
                href="/deployments"
                className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ChevronLeft className="size-4" />
                Deployments
            </Link>
            <ErrorLine error={models.error} />
            {models.data && !row && (
                <p className="text-sm text-muted-foreground">No custom model called {slug}.</p>
            )}
            {row && (
                <>
                    <DeploymentHeader row={row} />
                    <PanelSections>
                        <VersionHistory row={row} />
                        <Connect slug={row.key} />
                    </PanelSections>
                </>
            )}
        </Page>
    );
}
