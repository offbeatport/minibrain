import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Cable, Puzzle } from "lucide-react";
import {
    Badge,
    Button,
    ConfirmDialog,
    EmptyState,
    Input,
    Link,
    NumberField,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    SettingsGroup,
    SettingsRow,
    Switch,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { type FormEvent, type ReactNode, useState } from "react";
import { api, succeed, unwrap } from "~/api/client";
import {
    type ConnectionBody,
    type ConnectionInfo,
    type ConnectionKind,
    KIND_LABELS,
    connectionKeys,
    useConnections,
    useExtensions,
} from "~/api/connectionQueries";
import { ErrorLine, PanelSection, PanelSections } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import { StatusText } from "~/components/models/StatusText";
import { CONNECTIONS } from "~/pages/settings/settingsIndex";

const SSL_MODES: Record<"postgres" | "mysql", string[]> = {
    postgres: ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"],
    mysql: ["disabled", "preferred", "required", "verify_ca", "verify_identity"],
};

const DEFAULT_PORTS = { postgres: 5432, mysql: 3306 };

type Draft = {
    name: string;
    kind: ConnectionKind;
    endpoint: string;
    region: string;
    bucket: string;
    access_key: string;
    path_style: boolean;
    host: string;
    port: number | null;
    database: string;
    user: string;
    ssl_mode: string;
    secret: string;
    replacing: boolean;
};

const EMPTY: Draft = {
    name: "",
    kind: "s3",
    endpoint: "",
    region: "",
    bucket: "",
    access_key: "",
    path_style: true,
    host: "",
    port: null,
    database: "",
    user: "",
    ssl_mode: "",
    secret: "",
    replacing: true,
};

function draftOf(connection: ConnectionInfo): Draft {
    return {
        name: connection.name,
        kind: connection.kind,
        endpoint: connection.endpoint,
        region: connection.region,
        bucket: connection.bucket,
        access_key: connection.access_key,
        path_style: connection.path_style,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        user: connection.user,
        ssl_mode: connection.ssl_mode,
        secret: "",
        replacing: !connection.secret_set,
    };
}

function bodyOf(draft: Draft): ConnectionBody {
    const { replacing: _replacing, ...body } = draft;
    return { ...body, secret: draft.secret || null };
}

function useRefresh() {
    const client = useQueryClient();
    return () =>
        Promise.all([
            client.invalidateQueries({ queryKey: connectionKeys.all }),
            client.invalidateQueries({ queryKey: ["sources"] }),
        ]);
}

function TextRow({
    id,
    label,
    description,
    value,
    placeholder,
    mono = true,
    type = "text",
    onChange,
}: {
    id: string;
    label: string;
    description?: ReactNode;
    value: string;
    placeholder?: string;
    mono?: boolean;
    type?: string;
    onChange: (value: string) => void;
}) {
    return (
        <SettingsRow
            id={id}
            wide
            label={label}
            description={description}
            control={
                <Input
                    id={id}
                    type={type}
                    value={value}
                    placeholder={placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    className={mono ? "font-mono" : undefined}
                    onChange={(event) => onChange(event.target.value)}
                />
            }
        />
    );
}

function SecretRow({
    draft,
    saved,
    onChange,
}: {
    draft: Draft;
    saved: boolean;
    onChange: (patch: Partial<Draft>) => void;
}) {
    const label = draft.kind === "s3" ? "Secret key" : "Password";
    if (saved && !draft.replacing) {
        return (
            <SettingsRow
                label={label}
                description="Encrypted on this server and never shown again."
                control={
                    <>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onChange({ replacing: true })}
                        >
                            Replace
                        </Button>
                        <StatusText tone="success">Set</StatusText>
                    </>
                }
            />
        );
    }
    return (
        <TextRow
            id="connection-secret"
            label={label}
            type="password"
            mono={false}
            description={
                saved
                    ? "The new value replaces the saved one when you save."
                    : "Encrypted on this server and never shown again."
            }
            value={draft.secret}
            onChange={(secret) => onChange({ secret })}
        />
    );
}

function S3Fields({ draft, set }: { draft: Draft; set: (patch: Partial<Draft>) => void }) {
    return (
        <>
            <TextRow
                id="connection-endpoint"
                label="Endpoint"
                description="minibrain connects to this address only. Leave empty for AWS."
                value={draft.endpoint}
                placeholder="https://minio.internal:9000"
                onChange={(endpoint) => set({ endpoint })}
            />
            <TextRow
                id="connection-region"
                label="Region"
                description="Leave empty unless the store asks for one."
                value={draft.region}
                placeholder="us-east-1"
                onChange={(region) => set({ region })}
            />
            <TextRow
                id="connection-bucket"
                label="Bucket"
                description="Optional. When set, sources and imports must be in this bucket."
                value={draft.bucket}
                placeholder="exports"
                onChange={(bucket) => set({ bucket })}
            />
            <TextRow
                id="connection-access-key"
                label="Access key"
                value={draft.access_key}
                onChange={(access_key) => set({ access_key })}
            />
            <SettingsRow
                id="connection-path-style"
                toggle
                label="Path-style addressing"
                description="The bucket goes in the path (MinIO, Ceph) rather than in the host name (AWS)."
                control={
                    <Switch
                        id="connection-path-style"
                        checked={draft.path_style}
                        onCheckedChange={(path_style) => set({ path_style })}
                    />
                }
            />
        </>
    );
}

function DatabaseFields({
    draft,
    set,
}: {
    draft: Draft;
    set: (patch: Partial<Draft>) => void;
}) {
    const kind = draft.kind === "mysql" ? "mysql" : "postgres";
    return (
        <>
            <TextRow
                id="connection-host"
                label="Host"
                value={draft.host}
                placeholder="db.internal"
                onChange={(host) => set({ host })}
            />
            <SettingsRow
                id="connection-port"
                label="Port"
                control={
                    <NumberField
                        id="connection-port"
                        min={1}
                        max={65535}
                        format={{ useGrouping: false }}
                        value={draft.port ?? DEFAULT_PORTS[kind]}
                        onValueChange={(port) => set({ port })}
                    />
                }
            />
            <TextRow
                id="connection-database"
                label="Database"
                value={draft.database}
                onChange={(database) => set({ database })}
            />
            <TextRow
                id="connection-user"
                label="User"
                description="Use a user that can only read."
                value={draft.user}
                onChange={(user) => set({ user })}
            />
            <SettingsRow
                id="connection-ssl"
                label="SSL mode"
                control={
                    <Select
                        value={draft.ssl_mode || SSL_MODES[kind][kind === "postgres" ? 2 : 1]}
                        onValueChange={(ssl_mode) => set({ ssl_mode: String(ssl_mode ?? "") })}
                    >
                        <SelectTrigger id="connection-ssl" className="w-48 font-mono">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {SSL_MODES[kind].map((mode) => (
                                <SelectItem key={mode} value={mode} className="font-mono">
                                    {mode}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                }
            />
        </>
    );
}

function ConnectionForm({
    editing,
    onDone,
}: {
    editing: ConnectionInfo | null;
    onDone: () => void;
}) {
    const refresh = useRefresh();
    const [draft, setDraft] = useState<Draft>(() => (editing ? draftOf(editing) : EMPTY));
    const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
    const test = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/connections/test", {
                    body: { ...bodyOf(draft), id: editing?.id ?? null },
                }),
            ),
    });
    const save = useMutation({
        mutationFn: () =>
            editing
                ? unwrap(
                      api.PUT("/api/connections/{connection_id}", {
                          params: { path: { connection_id: editing.id } },
                          body: bodyOf(draft),
                      }),
                  )
                : unwrap(api.POST("/api/connections", { body: bodyOf(draft) })),
        onSuccess: async () => {
            await refresh();
            onDone();
        },
    });
    const submit = (event: FormEvent) => {
        event.preventDefault();
        save.mutate();
    };
    const kindLocked = Boolean(editing?.sources.length);
    return (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <SettingsGroup>
                <TextRow
                    id="connection-name"
                    label="Name"
                    mono={false}
                    value={draft.name}
                    placeholder="Exports bucket"
                    onChange={(name) => set({ name })}
                />
                <SettingsRow
                    id="connection-kind"
                    label="Kind"
                    description={
                        kindLocked ? "Sources use this connection, so its kind stays." : undefined
                    }
                    control={
                        <Select
                            value={draft.kind}
                            disabled={kindLocked}
                            onValueChange={(kind) =>
                                set({ kind: (kind ?? "s3") as ConnectionKind, ssl_mode: "" })
                            }
                        >
                            <SelectTrigger id="connection-kind" className="w-48">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {(Object.keys(KIND_LABELS) as ConnectionKind[]).map((kind) => (
                                    <SelectItem key={kind} value={kind}>
                                        {KIND_LABELS[kind]}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    }
                />
                {draft.kind === "s3" ? (
                    <S3Fields draft={draft} set={set} />
                ) : (
                    <DatabaseFields draft={draft} set={set} />
                )}
                <SecretRow draft={draft} saved={Boolean(editing?.secret_set)} onChange={set} />
            </SettingsGroup>
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    variant="outline"
                    disabled={test.isPending}
                    onClick={() => test.mutate()}
                >
                    {test.isPending ? "Testing…" : "Test connection"}
                </Button>
                <Button type="submit" disabled={save.isPending || !draft.name.trim()}>
                    {save.isPending ? "Saving…" : editing ? "Save" : "Add connection"}
                </Button>
                <Button type="button" variant="ghost" onClick={onDone}>
                    Cancel
                </Button>
            </div>
            {test.data && <CheckLine ok={test.data.ok} message={test.data.message} />}
            <ErrorLine error={test.error ?? save.error} />
        </form>
    );
}

function CheckLine({ ok, message }: { ok: boolean; message: string }) {
    return (
        <p className="text-sm">
            <StatusText tone={ok ? "success" : "destructive"}>
                {ok ? "Connected" : "Could not connect"}
            </StatusText>
            <span className="ml-2 text-muted-foreground">{message}</span>
        </p>
    );
}

function used(connection: ConnectionInfo): string {
    const count = connection.sources.length;
    return count === 0 ? "No sources" : `${count} source${count === 1 ? "" : "s"}`;
}

function ConnectionRow({
    connection,
    onEdit,
}: {
    connection: ConnectionInfo;
    onEdit: () => void;
}) {
    const refresh = useRefresh();
    const path = { params: { path: { connection_id: connection.id } } };
    const test = useMutation({
        mutationFn: () => unwrap(api.POST("/api/connections/{connection_id}/test", path)),
    });
    const remove = useMutation({
        mutationFn: () => succeed(api.DELETE("/api/connections/{connection_id}", path)),
        onSuccess: refresh,
    });
    const deleteBlocked = connection.locked
        ? "Set in minibrain.yaml: remove it there"
        : connection.sources.length
          ? `Used by ${connection.sources.map((source) => source.name).join(", ")}: delete those sources first`
          : null;
    return (
        <li className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{connection.name}</span>
                        <Badge variant="neutral">{KIND_LABELS[connection.kind]}</Badge>
                        {connection.locked && (
                            <Badge variant="outline">Set in minibrain.yaml</Badge>
                        )}
                    </span>
                    <span className="font-mono text-sm break-all text-muted-foreground">
                        {connection.summary}
                    </span>
                    <span className="text-sm text-muted-foreground">
                        {connection.secret_source
                            ? `${used(connection)} · secret from the ${connection.secret_source}`
                            : used(connection)}
                    </span>
                    {connection.problem ? (
                        <StatusText tone="destructive" className="whitespace-normal">
                            {connection.problem}
                        </StatusText>
                    ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button
                        variant="outline"
                        disabled={test.isPending}
                        onClick={() => test.mutate()}
                    >
                        {test.isPending ? "Testing…" : "Test"}
                    </Button>
                    {!connection.locked && (
                        <Button variant="outline" onClick={onEdit}>
                            Edit
                        </Button>
                    )}
                    {deleteBlocked ? (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span>
                                    <Button variant="outline" disabled>
                                        Delete
                                    </Button>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent>{deleteBlocked}</TooltipContent>
                        </Tooltip>
                    ) : (
                        <ConfirmDialog
                            trigger={<Button variant="outline">Delete</Button>}
                            title={`Delete ${connection.name}?`}
                            description="Its encrypted secret is removed. Model imports that used it fall back to matching another connection."
                            confirmLabel="Delete"
                            destructive
                            onConfirm={() => remove.mutateAsync().catch(() => undefined)}
                        />
                    )}
                </div>
            </div>
            {test.data && <CheckLine ok={test.data.ok} message={test.data.message} />}
            <ErrorLine error={test.error ?? remove.error} />
        </li>
    );
}

function Extensions() {
    const extensions = useExtensions();
    const data = extensions.data;
    const missing = data?.extensions.filter((item) => !item.installed) ?? [];
    return (
        <PanelSection
            icon={Puzzle}
            anchor={CONNECTIONS.extensions.anchor}
            title={CONNECTIONS.extensions.title}
            description="S3, database, Iceberg and Delta Lake sources read through DuckDB extensions. minibrain never downloads them; an admin installs them from a folder or an internal mirror."
        >
            <ErrorLine error={extensions.error} />
            {data && (
                <div className="flex flex-col gap-3">
                    <ul className="flex flex-col divide-y rounded-lg border">
                        {data.extensions.map((item) => (
                            <li
                                key={item.name}
                                className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5"
                            >
                                <span className="font-mono text-sm">{item.name}</span>
                                <span className="text-sm text-muted-foreground">
                                    {item.purpose}
                                </span>
                                <span className="ml-auto shrink-0 text-sm">
                                    <StatusText tone={item.installed ? "success" : "warning"}>
                                        {item.installed ? "Installed" : "Missing"}
                                    </StatusText>
                                </span>
                            </li>
                        ))}
                    </ul>
                    <p className="text-sm text-muted-foreground">
                        {`DuckDB ${data.version} on ${data.platform}, installed in `}
                        <span className="font-mono break-all">{data.directory}</span>
                    </p>
                    {missing.length > 0 && (
                        <div className="flex flex-col gap-1 text-sm">
                            <span>
                                On a connected machine, save them with{" "}
                                <code className="font-mono">
                                    {`minibrain extensions download --to ./duckdb-extensions --platform ${data.platform}`}
                                </code>
                                , copy the folder here, then run:
                            </span>
                            <code className="rounded-md border bg-muted px-2 py-1 font-mono break-all">
                                {data.repository
                                    ? `minibrain extensions install --from ${data.repository}`
                                    : data.command}
                            </code>
                        </div>
                    )}
                </div>
            )}
        </PanelSection>
    );
}

export function ConnectionsSettingsPage() {
    const connections = useConnections();
    const [editing, setEditing] = useState<ConnectionInfo | "new" | null>(null);
    const list = connections.data ?? [];
    const formOpen = editing !== null;
    return (
        <SettingsLayout title="Connections">
            <p className="-mt-2 text-sm text-muted-foreground">
                {
                    "Buckets and databases that data sources and model imports read from. Where minibrain keeps its own files is under "
                }
                <Link href="/settings/storage" className="text-primary hover:underline">
                    Storage
                </Link>
                .
            </p>
            <ErrorLine error={connections.error} />
            <PanelSections>
                <PanelSection
                    icon={Cable}
                    anchor={CONNECTIONS.connections.anchor}
                    title={CONNECTIONS.connections.title}
                    description="Each endpoint must be allowed by the network policy. Secrets are write-only."
                    actions={
                        !formOpen && (
                            <Button onClick={() => setEditing("new")}>
                                {CONNECTIONS.connections.settings.add.label}
                            </Button>
                        )
                    }
                    bare
                >
                    {formOpen && (
                        <div className="rounded-xl border bg-card p-4">
                            <h3 className="mb-4 text-base font-semibold">
                                {editing === "new" ? "New connection" : `Edit ${editing.name}`}
                            </h3>
                            <ConnectionForm
                                key={editing === "new" ? "new" : editing.id}
                                editing={editing === "new" ? null : editing}
                                onDone={() => setEditing(null)}
                            />
                        </div>
                    )}
                    {connections.data && list.length === 0 && !formOpen ? (
                        <EmptyState
                            variant="panel"
                            title="No connections yet"
                            className="mx-0 mt-0"
                        >
                            Add an S3-compatible bucket, a PostgreSQL or a MySQL database to read
                            data in place or import models from a bucket. Locked-down installs can
                            declare them in minibrain.yaml instead.
                        </EmptyState>
                    ) : (
                        list.length > 0 && (
                            <ul className="flex flex-col divide-y rounded-xl border bg-card">
                                {list.map((connection) => (
                                    <ConnectionRow
                                        key={connection.id}
                                        connection={connection}
                                        onEdit={() => setEditing(connection)}
                                    />
                                ))}
                            </ul>
                        )
                    )}
                </PanelSection>
                <Extensions />
            </PanelSections>
        </SettingsLayout>
    );
}
