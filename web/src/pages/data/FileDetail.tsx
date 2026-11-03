import { useMutation } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge, Button, DataGrid, FileName, FileTypeIcon, Link } from "obp-ui";
import { useState } from "react";
import {
    type ColumnStats,
    type DatasetSummary,
    type QueryResponse,
    type SourceSummary,
    api,
    succeed,
    unwrap,
} from "~/api/client";
import { useSourceRows, useSourceStats } from "~/api/queries";
import { ErrorLine, Section, Stat } from "~/components/Section";
import { count } from "~/lib/format";
import { bytes, relativeTime } from "~/lib/time";
import { ConnectedFacts } from "./Connected";
import { CreateDataset } from "./DatasetDetail";
import { FORMAT_LABELS } from "./Folders";
import { type ItemRef, itemHref, kindLabel, plural } from "./catalogue";
import {
    About,
    DeleteAction,
    EditDialog,
    ItemHeader,
    Trail,
    modelHref,
    useDataRefresh,
    useModelNames,
} from "./parts";

const TEXT_TYPES = new Set(["VARCHAR", "BLOB", "JSON"]);
const CONNECTED = new Set(["s3", "database", "iceberg"]);
const CONNECTED_LABELS: Record<string, string> = {
    s3: "S3 path",
    database: "Database",
    iceberg: "Iceberg table",
};

function share(part: number, whole: number): string {
    if (whole === 0) {
        return "–";
    }
    const value = (part / whole) * 100;
    return part > 0 && value < 1 ? "<1%" : `${Math.round(value)}%`;
}

function statColumns(sampled: number, withRange: boolean): ColumnDef<ColumnStats, unknown>[] {
    const columns: ColumnDef<ColumnStats, unknown>[] = [
        {
            id: "name",
            header: "Column",
            accessorFn: (column) => column.name.toLowerCase(),
            cell: ({ row }) => <span className="font-mono">{row.original.name}</span>,
        },
        {
            id: "type",
            header: "Type",
            accessorFn: (column) => column.type.toLowerCase(),
            cell: ({ row }) => (
                <span className="text-muted-foreground">{row.original.type.toLowerCase()}</span>
            ),
        },
        {
            id: "empty",
            header: "Empty",
            accessorFn: (column) => column.nulls,
            cell: ({ row }) => (
                <span className="tabular-nums">{share(row.original.nulls, sampled)}</span>
            ),
        },
        {
            id: "distinct",
            header: "Distinct",
            accessorFn: (column) => column.distinct,
            cell: ({ row }) => (
                <span className="tabular-nums">{`≈ ${count(row.original.distinct)}`}</span>
            ),
        },
    ];
    if (!withRange) {
        return columns;
    }
    return [
        ...columns,
        {
            id: "range",
            header: "Range",
            enableSorting: false,
            cell: ({ row }) =>
                row.original.min === null || TEXT_TYPES.has(row.original.type) ? (
                    <span className="text-muted-foreground">–</span>
                ) : (
                    <span className="block truncate text-muted-foreground">
                        {row.original.min === row.original.max
                            ? row.original.min
                            : `${row.original.min} … ${row.original.max}`}
                    </span>
                ),
        },
    ];
}

function rowColumns(result: QueryResponse): ColumnDef<(string | null)[], unknown>[] {
    return result.columns.map((name, index) => ({
        id: `${index}:${name}`,
        header: () => <span className="font-mono">{name}</span>,
        accessorFn: (row) => row[index] ?? "",
        cell: (info) => {
            const value = info.getValue() as string;
            return value === "" ? (
                <span className="text-muted-foreground">–</span>
            ) : (
                <span className="line-clamp-2 max-w-sm whitespace-normal">{value}</span>
            );
        },
    }));
}

function Columns({ source }: { source: SourceSummary }) {
    const stats = useSourceStats(source.id);
    const sampled = stats.data?.sampled ?? 0;
    const origin =
        source.kind === "upload" ? "Types from the staged table" : "Types read from the source";
    const caption =
        stats.data && stats.data.sampled < stats.data.rows
            ? `${origin}; empty and distinct counts from the first ${count(sampled)} rows.`
            : `${origin}; empty and distinct counts over every row.`;
    return (
        <Section title="Columns" caption={caption} flush>
            <ErrorLine error={stats.error} />
            <DataGrid
                columns={statColumns(
                    sampled,
                    (stats.data?.columns ?? []).some((column) => !TEXT_TYPES.has(column.type)),
                )}
                rows={stats.data?.columns ?? []}
                loading={stats.isLoading}
                loadingRows={Math.min(source.columns.length, 6)}
                storageKey="minibrain.data.columns"
                maxHeight="360px"
            />
        </Section>
    );
}

function Preview({ source }: { source: SourceSummary }) {
    const rows = useSourceRows(source.id);
    return (
        <Section
            title="Preview"
            caption={`The first ${count(rows.data?.rows.length ?? 50)} rows as stored.`}
            flush
        >
            <ErrorLine error={rows.error} />
            <DataGrid
                columns={rows.data ? rowColumns(rows.data) : []}
                rows={rows.data?.rows ?? []}
                loading={rows.isLoading}
                maxHeight="420px"
                minWidth={rows.data && rows.data.columns.length > 4 ? "min-w-[960px]" : undefined}
            />
        </Section>
    );
}

function Datasets({ datasets }: { datasets: DatasetSummary[] }) {
    return (
        <Section
            title="Used by datasets"
            caption="Datasets whose query reads this source. A source in use cannot be deleted."
        >
            {datasets.length === 0 ? (
                <p className="text-sm text-muted-foreground">No dataset reads it yet.</p>
            ) : (
                <ul className="flex flex-col divide-y rounded-lg border">
                    {datasets.map((dataset) => (
                        <li key={dataset.slug} className="flex h-9 items-center gap-3 px-3">
                            <Link
                                href={itemHref({ kind: "dataset", id: dataset.slug })}
                                className="min-w-0 truncate text-primary"
                            >
                                {dataset.name}
                            </Link>
                            <Badge variant="neutral">
                                {dataset.mode === "sql" ? "SQL" : "Columns"}
                            </Badge>
                            <span className="ml-auto shrink-0 text-sm text-muted-foreground tabular-nums">
                                {dataset.rows === null ? "–" : plural(dataset.rows, "row")}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </Section>
    );
}

export function FileDetail({
    source,
    sources,
    datasets,
    creating,
    onCreating,
    onSelect,
}: {
    source: SourceSummary;
    sources: SourceSummary[];
    datasets: DatasetSummary[];
    creating: boolean;
    onCreating: (creating: boolean) => void;
    onSelect: (item: ItemRef) => void;
}) {
    const refresh = useDataRefresh();
    const nameOf = useModelNames();
    const [editing, setEditing] = useState(false);
    const path = { params: { path: { source_id: source.id } } };
    const remove = useMutation({
        mutationFn: () => succeed(api.DELETE("/api/sources/{source_id}", path)),
        onSuccess: async () => {
            onSelect({ kind: "group", id: source.kind });
            await refresh();
        },
    });
    const models = [...new Set(datasets.flatMap((dataset) => dataset.models))];
    return (
        <div className="flex flex-col gap-6">
            <ItemHeader
                title={source.kind === "upload" ? <FileName name={source.name} /> : source.name}
                icon={
                    source.kind === "upload" ? (
                        <FileTypeIcon name={source.filename || source.name} />
                    ) : undefined
                }
                detail={
                    CONNECTED.has(source.kind) ? (
                        <>
                            {`${CONNECTED_LABELS[source.kind] ?? kindLabel(source.kind)} · ${source.connection ?? "no connection"} · table `}
                            <span className="font-mono">{source.table}</span>
                            {` · added ${relativeTime(source.created_at)}`}
                        </>
                    ) : source.kind === "folder" ? (
                        <>
                            {"Folder · "}
                            <span className="font-mono">{source.path}</span>
                            {" · table "}
                            <span className="font-mono">{source.table}</span>
                            {` · added ${relativeTime(source.created_at)}`}
                        </>
                    ) : (
                        <>
                            {`${kindLabel(source.kind)} · `}
                            <span className="font-mono">{source.filename}</span>
                            {" · table "}
                            <span className="font-mono">{source.table}</span>
                            {` · added ${relativeTime(source.created_at)}`}
                        </>
                    )
                }
                trail={
                    <Trail
                        current="source"
                        sources={[
                            {
                                label: source.name,
                                href: itemHref({ kind: "source", id: source.id }),
                            },
                        ]}
                        datasets={datasets.map((dataset) => ({
                            label: dataset.name,
                            href: itemHref({ kind: "dataset", id: dataset.slug }),
                        }))}
                        models={models.map((slug) => ({
                            label: nameOf(slug),
                            href: modelHref(slug),
                        }))}
                    />
                }
                actions={
                    <>
                        <Button onClick={() => onCreating(true)} disabled={creating}>
                            Create dataset
                        </Button>
                        <Button variant="outline" onClick={() => setEditing(true)}>
                            Edit
                        </Button>
                        <DeleteAction
                            blocked={
                                datasets.length
                                    ? `Used by ${plural(datasets.length, "dataset")}: delete those first`
                                    : null
                            }
                            title={`Delete ${source.name}?`}
                            description={
                                source.kind === "upload"
                                    ? "The stored copy and its staged table go. This cannot be undone."
                                    : "minibrain stops reading it; the data stays where it is."
                            }
                            onConfirm={() => remove.mutateAsync().catch(() => undefined)}
                        />
                    </>
                }
                about={<About item={source} onEdit={() => setEditing(true)} />}
            />
            <ErrorLine error={remove.error} />
            {source.error && <p className="text-sm text-destructive">{source.error}</p>}
            <ConnectedFacts source={source} />
            <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat label="Rows" value={count(source.rows)} />
                <Stat label="Columns" value={count(source.columns.length)} />
                {(source.kind === "folder" || source.kind === "s3") && (
                    <>
                        <Stat
                            label={source.kind === "s3" ? "Objects" : "Files"}
                            value={`${count(source.files)} ${FORMAT_LABELS[source.format ?? ""] ?? ""}`}
                        />
                        <Stat
                            label="Last change"
                            value={source.modified_at ? relativeTime(source.modified_at) : "–"}
                        />
                    </>
                )}
                {(source.kind === "upload" || source.kind === "folder" || source.kind === "s3") && (
                    <Stat label="Size" value={bytes(source.size)} />
                )}
                <Stat label="Datasets" value={count(datasets.length)} />
            </div>
            {creating && (
                <CreateDataset
                    source={source}
                    sources={sources}
                    onCancel={() => onCreating(false)}
                    onCreated={async (dataset) => {
                        await refresh();
                        onCreating(false);
                        onSelect({ kind: "dataset", id: dataset.slug });
                    }}
                />
            )}
            <Columns source={source} />
            <Preview source={source} />
            <Datasets datasets={datasets} />
            <EditDialog
                item={source}
                noun="file"
                open={editing}
                onOpenChange={setEditing}
                onSave={(body) =>
                    unwrap(api.PATCH("/api/sources/{source_id}", { ...path, body })).then(refresh)
                }
            />
        </div>
    );
}
