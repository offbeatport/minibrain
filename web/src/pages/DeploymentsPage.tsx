import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronLeft, History } from "lucide-react";
import { Badge, Button, Input, Label, Link } from "obp-ui";
import { type FormEvent, useState } from "react";
import {
    type KeyCreated,
    type KeyInfo,
    type MinibrainDetail,
    type ModelRow,
    type ModelVersionRow,
    api,
    succeed,
    unwrap,
} from "~/api/client";
import { keys, useKeys, useMinibrain, useModels } from "~/api/queries";
import { DataTable } from "~/components/DataTable";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine, Page, PanelSection, PanelSections, Section } from "~/components/Section";
import { Requests, failingShare } from "~/components/models/ModelMetrics";
import { SortableTable } from "~/components/models/SortableTable";
import { StatusText } from "~/components/models/StatusText";
import { count, dateTime, percent } from "~/lib/format";
import { Deployment as DeploymentCell } from "./models/MyModels";

function Code({ children }: { children: string }) {
    return (
        <pre className="overflow-x-auto rounded-md border bg-secondary p-3 font-mono text-sm">
            {children}
        </pre>
    );
}

function snippets(baseUrl: string, model: string, secret: string) {
    const curl = [
        `curl ${baseUrl}/chat/completions \\`,
        `  -H "Authorization: Bearer ${secret}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model": "${model}", "messages": [{"role": "user", "content": "I was charged twice"}]}'`,
    ].join("\n");
    const python = [
        "from openai import OpenAI",
        "",
        `client = OpenAI(base_url="${baseUrl}", api_key="${secret}")`,
        "reply = client.chat.completions.create(",
        `    model="${model}",`,
        '    messages=[{"role": "user", "content": "I was charged twice"}],',
        ")",
        "print(reply.choices[0].message.content)",
    ].join("\n");
    return { curl, python };
}

function KeysSection({ slug, onCreated }: { slug: string; onCreated: (key: KeyCreated) => void }) {
    const queryClient = useQueryClient();
    const { data } = useKeys(slug);
    const [name, setName] = useState("");
    const refresh = () => queryClient.invalidateQueries({ queryKey: keys.keys(slug) });
    const create = useMutation({
        mutationFn: (value: string) =>
            unwrap(
                api.POST("/api/minibrains/{slug}/keys", {
                    params: { path: { slug } },
                    body: { name: value },
                }),
            ),
        onSuccess: (key) => {
            onCreated(key);
            setName("");
            return refresh();
        },
    });
    const remove = useMutation({
        mutationFn: (keyId: number) =>
            succeed(
                api.DELETE("/api/minibrains/{slug}/keys/{key_id}", {
                    params: { path: { slug, key_id: keyId } },
                }),
            ),
        onSuccess: refresh,
    });
    const columns: ColumnDef<KeyInfo, unknown>[] = [
        { header: "Name", accessorKey: "name" },
        {
            header: "Key",
            accessorKey: "prefix",
            cell: (info) => <span className="font-mono">{String(info.getValue())}…</span>,
        },
        {
            header: "Created",
            accessorKey: "created_at",
            cell: (info) => dateTime(String(info.getValue())),
        },
        {
            header: "Last used",
            accessorKey: "last_used_at",
            cell: (info) => dateTime(info.getValue() as string | null),
        },
        {
            header: "",
            id: "delete",
            cell: ({ row }) => (
                <Button variant="ghost" size="xs" onClick={() => remove.mutate(row.original.id)}>
                    Revoke
                </Button>
            ),
        },
    ];
    const submit = (event: FormEvent) => {
        event.preventDefault();
        create.mutate(name.trim() || "default");
    };
    return (
        <Section
            title="API keys"
            caption="A key only reaches this minibrain. The full key is shown once."
        >
            <form onSubmit={submit} className="mb-3 flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1">
                    <Label htmlFor="key-name">Name</Label>
                    <Input
                        id="key-name"
                        className="w-56"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="helpdesk-app"
                    />
                </div>
                <Button type="submit" disabled={create.isPending}>
                    Create key
                </Button>
            </form>
            <ErrorLine error={create.error ?? remove.error} />
            <DataTable columns={columns} rows={data ?? []} empty="No keys yet." />
        </Section>
    );
}

function serving(detail: MinibrainDetail): string {
    if (!detail.deployed) {
        return "Not deployed";
    }
    if (detail.current_version === null || detail.current_version === undefined) {
        return `Base model ${detail.base_model}, until you deploy a version`;
    }
    return detail.current_accuracy === null || detail.current_accuracy === undefined
        ? `v${detail.current_version}`
        : `v${detail.current_version} · ${percent(detail.current_accuracy)} held-out accuracy`;
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
            size="xs"
            variant={deployed ? "outline" : "default"}
            onClick={() => toggle.mutate()}
            disabled={toggle.isPending}
        >
            {deployed ? "Undeploy" : "Deploy"}
        </Button>
    );
}

function Deployment({ slug }: { slug: string }) {
    const { data: detail } = useMinibrain(slug);
    const [created, setCreated] = useState<KeyCreated | null>(null);
    if (!detail) {
        return null;
    }
    const baseUrl = `${window.location.origin}/v1`;
    const model = detail.models[0] ?? slug;
    const code = snippets(baseUrl, model, created?.secret ?? "YOUR_KEY");
    return (
        <>
            <Section
                title="Endpoint"
                caption="OpenAI-compatible. Point any OpenAI client at this base URL."
            >
                <div className="flex flex-col gap-3 text-sm">
                    <div>
                        <div className="text-muted-foreground">Serving</div>
                        <div className="flex flex-wrap items-center gap-3">
                            <span>{serving(detail)}</span>
                            <DeployToggle slug={slug} deployed={detail.deployed ?? false} />
                        </div>
                    </div>
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
                </div>
            </Section>
            <KeysSection slug={slug} onCreated={setCreated} />
            {created && (
                <div className="rounded-lg border border-success/40 bg-success-soft p-4 text-sm">
                    <div className="font-semibold">New key for {created.name}</div>
                    <div className="mt-1 break-all font-mono">{created.secret}</div>
                    <p className="mt-1 text-muted-foreground">
                        Copy it now; it is not shown again.
                    </p>
                </div>
            )}
            <Section title="Examples">
                <div className="flex flex-col gap-3">
                    <Code>{code.curl}</Code>
                    <Code>{code.python}</Code>
                </div>
            </Section>
        </>
    );
}

const KIND_NAMES: Record<string, string> = { lora: "Trained", prompt: "Prompt-only" };

export function endpointHref(row: ModelRow): string {
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
    const share = failingShare(row.usage);
    if (share >= 0.01) {
        return (
            <StatusText tone="destructive">{`${Math.round(share * 100)}% of requests failing`}</StatusText>
        );
    }
    return <DeploymentCell row={row} short />;
}

const ENDPOINT_COLUMNS: ColumnDef<ModelRow, unknown>[] = [
    {
        id: "endpoint",
        header: "Endpoint",
        accessorFn: (row) => row.key,
        cell: ({ row }) => (
            <div className="flex min-w-52 items-start gap-3">
                <PublisherLogo publisher={row.original.publisher} name={row.original.name} />
                <div className="flex min-w-0 flex-col">
                    <Link
                        href={endpointHref(row.original)}
                        className="font-mono font-semibold text-foreground hover:underline"
                    >
                        {row.original.key}
                    </Link>
                    <span className="truncate text-sm text-muted-foreground">
                        {row.original.name}
                    </span>
                </div>
            </div>
        ),
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
        header: "Requests, last 7 days",
        accessorFn: (row) => row.usage?.total ?? 0,
        cell: ({ row }) => <Requests usage={row.original.usage} />,
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
    const models = useModels(false);
    const live = (models.data ?? []).filter((row) => row.deployment.state !== "not_deployed");
    return (
        <Page>
            <PageHeader
                title="Deployments"
                caption="Everything apps can call now, on one OpenAI-compatible endpoint."
            />
            <ErrorLine error={models.error} />
            {models.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
                <SortableTable
                    columns={ENDPOINT_COLUMNS}
                    rows={live}
                    onOpen={(row) => router.history.push(endpointHref(row))}
                    rowLabel={(row) => `${row.key}, serves ${serves(row)}`}
                    empty={
                        <p className="text-muted-foreground">
                            Nothing is deployed. Deploy a model or one of its versions from Models.
                        </p>
                    }
                    minWidth="min-w-[760px]"
                />
            )}
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
            header: "Requests, last 7 days",
            id: "requests",
            cell: ({ row: item }) => <Requests usage={item.original.usage} />,
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
        <PanelSection icon={History} title="Versions">
            <div className="flex flex-col gap-2">
                <DataTable
                    columns={columns}
                    rows={versions}
                    empty="No versions yet: it serves its base model."
                />
                <ErrorLine error={deploy.error} />
            </div>
        </PanelSection>
    );
}

export function EndpointPage() {
    const { slug } = useParams({ strict: false }) as { slug?: string };
    const models = useModels(true);
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
                    <PageHeader
                        title={row.name}
                        icon={<PublisherLogo publisher={row.publisher} name={row.name} />}
                        caption={`Apps call it as ${row.key}`}
                    />
                    <PanelSections>
                        <VersionHistory row={row} />
                        <Deployment slug={row.key} />
                    </PanelSections>
                </>
            )}
        </Page>
    );
}
