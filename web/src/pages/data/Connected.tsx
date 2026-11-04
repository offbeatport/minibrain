import { useMutation } from "@tanstack/react-query";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Field,
    FieldGroup,
    Input,
    Label,
    Link,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import { type DatasetSummary, type SourceSummary, api, unwrap } from "~/api/client";
import {
    type ConnectionInfo,
    EXTENSIONS_FOR,
    KIND_LABELS,
    missingExtensions,
    useConnectionTables,
    useConnections,
    useExtensions,
} from "~/api/connectionQueries";
import { ErrorLine, Stat } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { bytes } from "~/lib/time";
import { FORMAT_LABELS } from "./Folders";
import { usesSource } from "./catalogue";
import { useDataRefresh } from "./parts";

export type ConnectedKind = "s3" | "database";

const CONNECTION_KINDS: Record<ConnectedKind, ConnectionInfo["kind"][]> = {
    s3: ["s3"],
    database: ["postgres", "mysql"],
};

const GROUPS: Record<ConnectedKind, { title: string; body: string; add: string; noun: string }> = {
    s3: {
        title: "S3",
        body: "Objects in a bucket, read in place as one table: every Parquet, CSV or JSON file a path or pattern matches. Changes are tracked by each object's ETag and size.",
        add: "Add S3 path",
        noun: "path",
    },
    database: {
        title: "Databases",
        body: "A PostgreSQL or MySQL table, or one read-only query, read in place through a connection. Nothing is ever written back.",
        add: "Add table or query",
        noun: "table",
    },
};

const S3_FORMATS = [
    { value: "auto", label: "From the path, or the most common" },
    { value: ".parquet", label: "Parquet" },
    { value: ".csv", label: "CSV" },
    { value: ".tsv", label: "TSV" },
    { value: ".json", label: "JSON" },
    { value: ".jsonl", label: "JSON Lines" },
] as const;

type S3Format = Exclude<(typeof S3_FORMATS)[number]["value"], "auto">;

export function usable(
    connections: ConnectionInfo[] | undefined,
    kind: ConnectedKind,
): ConnectionInfo[] {
    return (connections ?? []).filter((item) => CONNECTION_KINDS[kind].includes(item.kind));
}

export function ConnectionPicker({
    id,
    options,
    value,
    onChange,
}: {
    id: string;
    options: ConnectionInfo[];
    value: number | null;
    onChange: (value: number) => void;
}) {
    const chosen = options.find((item) => item.id === value);
    return (
        <Field id={id} label="Connection">
            <Select
                value={value === null ? "" : String(value)}
                onValueChange={(next) => onChange(Number(next))}
            >
                <SelectTrigger id={id} className="w-full">
                    <SelectValue placeholder="Pick a connection" />
                </SelectTrigger>
                <SelectContent>
                    {options.map((item) => (
                        <SelectItem
                            key={item.id}
                            value={String(item.id)}
                            description={`${KIND_LABELS[item.kind]} · ${item.summary}`}
                        >
                            {item.name}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {chosen?.problem && (
                <StatusText tone="destructive" className="mt-1 whitespace-normal">
                    {chosen.problem}
                </StatusText>
            )}
        </Field>
    );
}

export function ExtensionWarning({ needed }: { needed: string[] }) {
    const extensions = useExtensions();
    const missing = missingExtensions(extensions.data, needed);
    if (missing.length === 0) {
        return null;
    }
    return (
        <StatusText tone="warning" className="whitespace-normal">
            <span>
                {`The DuckDB ${missing.join(", ")} extension${missing.length === 1 ? " is" : "s are"} not installed on this server. An admin installs ${missing.length === 1 ? "it" : "them"} offline; see `}
                <Link href="/settings/connections" className="text-primary hover:underline">
                    Settings, Connections
                </Link>
                .
            </span>
        </StatusText>
    );
}

export function AddDialog({
    open,
    title,
    description,
    pending,
    ready,
    submitLabel,
    error,
    onOpenChange,
    onSubmit,
    children,
}: {
    open: boolean;
    title: string;
    description: string;
    pending: boolean;
    ready: boolean;
    submitLabel: string;
    error: unknown;
    onOpenChange: (open: boolean) => void;
    onSubmit: () => void;
    children: ReactNode;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <form
                    className="contents"
                    onSubmit={(event) => {
                        event.preventDefault();
                        onSubmit();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                        <DialogDescription>{description}</DialogDescription>
                    </DialogHeader>
                    <FieldGroup>{children}</FieldGroup>
                    <ErrorLine error={error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!ready || pending}>
                            {pending ? "Reading…" : submitLabel}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function useAddSource(
    request: () => Promise<SourceSummary>,
    onAdded: (source: SourceSummary) => void,
    onOpenChange: (open: boolean) => void,
) {
    const refresh = useDataRefresh();
    return useMutation({
        mutationFn: request,
        onSuccess: async (source: SourceSummary) => {
            await refresh();
            onOpenChange(false);
            onAdded(source);
        },
    });
}

export function NameField({
    value,
    onChange,
}: { value: string; onChange: (value: string) => void }) {
    return (
        <Field id="connected-name" label="Name" hint="Taken from the path or table if empty.">
            <Input
                id="connected-name"
                value={value}
                maxLength={120}
                onChange={(event) => onChange(event.target.value)}
            />
        </Field>
    );
}

export function firstId(options: ConnectionInfo[]): number | null {
    return options[0]?.id ?? null;
}

export function AddS3Dialog({
    open,
    onOpenChange,
    onAdded,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAdded: (source: SourceSummary) => void;
}) {
    const connections = useConnections();
    const options = usable(connections.data, "s3");
    const [connection, setConnection] = useState<number | null>(null);
    const [path, setPath] = useState("");
    const [format, setFormat] = useState<S3Format | "auto">("auto");
    const [name, setName] = useState("");
    const chosen = connection ?? firstId(options);
    const bucket = options.find((item) => item.id === chosen)?.bucket;
    const add = useAddSource(
        () =>
            unwrap(
                api.POST("/api/sources/s3", {
                    body: {
                        connection_id: chosen ?? 0,
                        path: path.trim(),
                        format: format === "auto" ? null : format,
                        name: name.trim() || null,
                    },
                }),
            ),
        onAdded,
        onOpenChange,
    );
    return (
        <AddDialog
            open={open}
            title="Add an S3 path"
            description="minibrain lists the matching objects and reads them in place as one table each time a query runs. Nothing is copied until a snapshot is taken."
            pending={add.isPending}
            ready={chosen !== null && path.trim().startsWith("s3://")}
            submitLabel="Add S3 path"
            error={add.error}
            onOpenChange={onOpenChange}
            onSubmit={() => add.mutate()}
        >
            <ConnectionPicker
                id="s3-connection"
                options={options}
                value={chosen}
                onChange={setConnection}
            />
            <Field
                id="s3-path"
                label="Path or pattern"
                hint="A prefix reads every file of one format under it; * and ** match names."
            >
                <Input
                    id="s3-path"
                    value={path}
                    className="font-mono"
                    placeholder={`s3://${bucket || "bucket"}/exports/*.parquet`}
                    onChange={(event) => setPath(event.target.value)}
                />
            </Field>
            <Field id="s3-format" label="Files to read">
                <Select
                    value={format}
                    onValueChange={(next) => setFormat((next ?? "auto") as S3Format | "auto")}
                >
                    <SelectTrigger id="s3-format" className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {S3_FORMATS.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                                {item.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Field>
            <NameField value={name} onChange={setName} />
            <ExtensionWarning needed={EXTENSIONS_FOR.s3} />
        </AddDialog>
    );
}

export function AddDatabaseDialog({
    open,
    onOpenChange,
    onAdded,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onAdded: (source: SourceSummary) => void;
}) {
    const connections = useConnections();
    const options = usable(connections.data, "database");
    const [connection, setConnection] = useState<number | null>(null);
    const [mode, setMode] = useState<"table" | "query">("table");
    const [table, setTable] = useState("");
    const [query, setQuery] = useState("");
    const [changeColumn, setChangeColumn] = useState("");
    const [name, setName] = useState("");
    const chosen = connection ?? firstId(options);
    const picked = options.find((item) => item.id === chosen);
    const tables = useConnectionTables(
        open && mode === "table" && !picked?.problem ? chosen : null,
    );
    const add = useAddSource(
        () =>
            unwrap(
                api.POST("/api/sources/database", {
                    body: {
                        connection_id: chosen ?? 0,
                        table: mode === "table" ? table.trim() : null,
                        query: mode === "query" ? query : null,
                        change_column: changeColumn.trim() || null,
                        name: name.trim() || null,
                    },
                }),
            ),
        onAdded,
        onOpenChange,
    );
    const ready =
        chosen !== null && (mode === "table" ? Boolean(table.trim()) : Boolean(query.trim()));
    return (
        <AddDialog
            open={open}
            title="Add a database table or query"
            description="Read in place through the connection, with read-only access and the 30 second query limit. Nothing is ever written to the database."
            pending={add.isPending}
            ready={ready}
            submitLabel="Add source"
            error={add.error}
            onOpenChange={onOpenChange}
            onSubmit={() => add.mutate()}
        >
            <ConnectionPicker
                id="database-connection"
                options={options}
                value={chosen}
                onChange={setConnection}
            />
            <RadioGroup
                value={mode}
                onValueChange={(next) => setMode(next === "query" ? "query" : "table")}
                className="flex flex-wrap gap-4"
                aria-label="Read"
            >
                <Label className="flex items-center gap-2 font-normal">
                    <RadioGroupItem value="table" />A table
                </Label>
                <Label className="flex items-center gap-2 font-normal">
                    <RadioGroupItem value="query" />A query
                </Label>
            </RadioGroup>
            {mode === "table" ? (
                <Field
                    id="database-table"
                    label="Table"
                    hint={
                        tables.data
                            ? `${count(tables.data.tables.length)} tables and views visible to this user.`
                            : "name or schema.name"
                    }
                >
                    <Input
                        id="database-table"
                        value={table}
                        list="database-tables"
                        className="font-mono"
                        placeholder="public.tickets"
                        onChange={(event) => setTable(event.target.value)}
                    />
                    <datalist id="database-tables">
                        {(tables.data?.tables ?? []).map((item) => (
                            <option key={item} value={item} />
                        ))}
                    </datalist>
                    <ErrorLine error={tables.error} />
                </Field>
            ) : (
                <Field
                    id="database-query"
                    label="Query"
                    hint="One SELECT or WITH query in the database's own SQL."
                >
                    <Textarea
                        id="database-query"
                        value={query}
                        rows={5}
                        className="font-mono"
                        placeholder="SELECT subject, body, category FROM tickets WHERE closed"
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </Field>
            )}
            <Field
                id="database-change-column"
                label="Updated-at column"
                hint="Optional. With it, minibrain tells when the data changed; without it, every read counts as new data."
            >
                <Input
                    id="database-change-column"
                    value={changeColumn}
                    className="font-mono"
                    placeholder="updated_at"
                    onChange={(event) => setChangeColumn(event.target.value)}
                />
            </Field>
            <NameField value={name} onChange={setName} />
            <ExtensionWarning
                needed={picked?.kind === "mysql" ? EXTENSIONS_FOR.mysql : EXTENSIONS_FOR.postgres}
            />
        </AddDialog>
    );
}

export function ConnectedGroup({
    kind,
    sources,
    datasets,
    onAdd,
}: {
    kind: ConnectedKind;
    sources: SourceSummary[];
    datasets: DatasetSummary[];
    onAdd: () => void;
}) {
    const connections = useConnections();
    const options = usable(connections.data, kind);
    const members = sources.filter((source) => source.kind === kind);
    const built = datasets.filter((dataset) =>
        members.some((source) => usesSource(dataset, source.id)),
    );
    const group = GROUPS[kind];
    const needed =
        kind === "database"
            ? options.some((item) => item.kind === "mysql")
                ? EXTENSIONS_FOR.database
                : EXTENSIONS_FOR.postgres
            : EXTENSIONS_FOR[kind];
    return (
        <div className="flex flex-col gap-6">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 className="text-2xl font-semibold">{group.title}</h2>
                    <p className="text-sm text-muted-foreground">{group.body}</p>
                </div>
                {options.length > 0 && <Button onClick={onAdd}>{group.add}</Button>}
            </header>
            <ErrorLine error={connections.error} />
            <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat label="Sources" value={count(members.length)} />
                <Stat label="Datasets" value={count(built.length)} />
                <Stat label="Connections" value={count(options.length)} />
                {kind === "s3" && members.length > 0 && (
                    <Stat
                        label="Size"
                        value={bytes(members.reduce((sum, source) => sum + source.size, 0))}
                    />
                )}
            </div>
            <ExtensionWarning needed={needed} />
            {connections.data && options.length === 0 ? (
                <EmptyState
                    variant="panel"
                    title={
                        kind === "database"
                            ? "No database connections yet"
                            : "No S3 connections yet"
                    }
                    className="mx-0 mt-0"
                    action={
                        <Button asChild variant="outline" className="mt-3">
                            <Link href="/settings/connections">Open connections</Link>
                        </Button>
                    }
                >
                    {kind === "database"
                        ? "Add a PostgreSQL or MySQL connection under Settings, Connections, then pick a table or write a query here."
                        : "Add an S3-compatible connection under Settings, Connections: endpoint, keys and, if you like, a bucket."}
                </EmptyState>
            ) : (
                <p className="text-sm text-muted-foreground">
                    {members.length === 0
                        ? `No ${group.noun}s yet. Each one becomes a table in dataset SQL.`
                        : "Pick a source to see its columns, rows and how its changes are tracked."}
                </p>
            )}
        </div>
    );
}

export function ConnectedFacts({ source }: { source: SourceSummary }) {
    if (source.kind !== "s3" && source.kind !== "database") {
        return null;
    }
    return (
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
            <dt className="text-muted-foreground">Connection</dt>
            <dd>
                <Link href="/settings/connections" className="text-primary hover:underline">
                    {source.connection ?? "Missing"}
                </Link>
            </dd>
            {source.query ? (
                <>
                    <dt className="text-muted-foreground">Query</dt>
                    <dd>
                        <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-sm whitespace-pre-wrap">
                            {source.query}
                        </pre>
                    </dd>
                </>
            ) : (
                <>
                    <dt className="text-muted-foreground">
                        {source.kind === "database" ? "Table" : "Path"}
                    </dt>
                    <dd className="font-mono break-all">{source.path}</dd>
                </>
            )}
            {source.kind === "s3" && source.format && (
                <>
                    <dt className="text-muted-foreground">Format</dt>
                    <dd>{FORMAT_LABELS[source.format] ?? source.format}</dd>
                </>
            )}
            {source.change_column && (
                <>
                    <dt className="text-muted-foreground">Updated-at column</dt>
                    <dd className="font-mono">{source.change_column}</dd>
                </>
            )}
            <dt className="text-muted-foreground">Changes</dt>
            <dd>{source.fingerprint_detail ?? "Not read yet"}</dd>
            {source.fingerprint && (
                <>
                    <dt className="text-muted-foreground">Fingerprint</dt>
                    <dd className="font-mono break-all text-muted-foreground">
                        {source.fingerprint.slice(0, 16)}
                    </dd>
                </>
            )}
        </dl>
    );
}
