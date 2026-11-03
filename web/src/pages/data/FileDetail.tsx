import { useMutation } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Button, DataGrid, Field, Input } from "obp-ui";
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
import { MappingSection } from "../DataPage";
import { type ItemRef, itemHref, kindLabel, plural, stem } from "./catalogue";
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

const EMPTY_MAPPING = { input_column: null, label_column: null, sql: null };
const TEXT_TYPES = new Set(["VARCHAR", "BLOB", "JSON"]);

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
    const caption =
        stats.data && stats.data.sampled < stats.data.rows
            ? `Types from the staged table; empty and distinct counts from the first ${count(sampled)} rows.`
            : "Types from the staged table; empty and distinct counts over every row.";
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

function CreateDataset({
    source,
    onCreated,
    onCancel,
}: {
    source: SourceSummary;
    onCreated: (dataset: DatasetSummary) => Promise<void>;
    onCancel: () => void;
}) {
    const [name, setName] = useState(stem(source.name) || "New dataset");
    const sourcePath = { params: { path: { source_id: source.id } } };
    return (
        <MappingSection
            title="New dataset"
            saveLabel="Create dataset"
            columns={source.columns.map((column) => column.name)}
            mapping={EMPTY_MAPPING}
            extraActions={
                <Button variant="ghost" size="sm" onClick={onCancel}>
                    Cancel
                </Button>
            }
            before={
                <Field id="new-dataset-name" label="Name" className="mb-4 max-w-sm">
                    <Input
                        id="new-dataset-name"
                        value={name}
                        maxLength={80}
                        onChange={(event) => setName(event.target.value)}
                    />
                </Field>
            }
            onSave={async (body) => {
                const created = await unwrap(
                    api.POST("/api/datasets", {
                        body: {
                            name: name.trim() || stem(source.name),
                            source_id: source.id,
                            ...body,
                        },
                    }),
                );
                await onCreated(created);
            }}
            onRun={(sql) =>
                unwrap(api.POST("/api/sources/{source_id}/query", { ...sourcePath, body: { sql } }))
            }
        />
    );
}

export function FileDetail({
    source,
    datasets,
    creating,
    onCreating,
    onSelect,
}: {
    source: SourceSummary;
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
                title={source.name}
                detail={
                    <>
                        {`${kindLabel(source.kind)} · `}
                        <span className="font-mono">{source.filename}</span>
                        {` · added ${relativeTime(source.created_at)}`}
                    </>
                }
                trail={
                    <Trail
                        current="source"
                        source={{
                            label: source.name,
                            href: itemHref({ kind: "source", id: source.id }),
                        }}
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
                            description="The stored copy and its staged table go. This cannot be undone."
                            onConfirm={() => remove.mutateAsync().catch(() => undefined)}
                        />
                    </>
                }
                about={<About item={source} onEdit={() => setEditing(true)} />}
            />
            <ErrorLine error={remove.error} />
            <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat label="Rows" value={count(source.rows)} />
                <Stat label="Columns" value={count(source.columns.length)} />
                <Stat label="Size" value={bytes(source.size)} />
                <Stat label="Datasets" value={count(datasets.length)} />
            </div>
            {creating && (
                <CreateDataset
                    source={source}
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
