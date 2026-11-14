import type { ColumnDef } from "@tanstack/react-table";
import { DataGrid, EmptyState, Link } from "obp-ui";
import type { DatasetSummary, SourceSummary } from "~/api/client";
import { Stat } from "~/components/Section";
import { count } from "~/lib/format";
import { bytes } from "~/lib/time";
import {
    type ItemRef,
    SOURCE_GROUPS,
    type SourceGroupId,
    inGroup,
    itemHref,
    plural,
    usesSource,
} from "./catalogue";

type KindRow = {
    kind: SourceGroupId;
    label: string;
    noun: string;
    sources: number;
    datasets: number;
};

const KIND_COLUMNS: ColumnDef<KindRow, unknown>[] = [
    {
        id: "kind",
        header: "Kind",
        accessorKey: "label",
        cell: ({ row }) => (
            <Link href={itemHref({ kind: "group", id: row.original.kind })}>
                {row.original.label}
            </Link>
        ),
    },
    {
        id: "sources",
        header: "Sources",
        accessorKey: "sources",
        cell: ({ row }) => (
            <span className="tabular-nums">{plural(row.original.sources, row.original.noun)}</span>
        ),
    },
    {
        id: "datasets",
        header: "Datasets reading them",
        accessorKey: "datasets",
        cell: ({ row }) => <span className="tabular-nums">{count(row.original.datasets)}</span>,
    },
];

export function SourcesOverview({
    sources,
    datasets,
    onSelect,
}: {
    sources: SourceSummary[];
    datasets: DatasetSummary[];
    onSelect: (item: ItemRef) => void;
}) {
    const rows = SOURCE_GROUPS.map((group) => {
        const members = sources.filter((source) => inGroup(source, group));
        return {
            kind: group.id,
            label: group.label,
            noun: group.noun,
            sources: members.length,
            datasets: datasets.filter((dataset) =>
                members.some((source) => usesSource(dataset, source.id)),
            ).length,
        };
    });
    const reading = datasets.filter((dataset) => dataset.sources.length > 0).length;
    const stored = sources
        .filter((source) => source.kind === "upload")
        .reduce((sum, source) => sum + source.size, 0);
    return (
        <div className="flex flex-col gap-6">
            <header className="flex min-w-0 flex-col gap-0.5">
                <h2 className="text-2xl font-semibold">Sources</h2>
                <p className="text-muted-foreground">
                    Files, folders, buckets and tables minibrain reads. Each one is a table that
                    dataset SQL reads by name.
                </p>
            </header>
            {sources.length === 0 ? (
                <EmptyState variant="panel" title="No sources yet" className="mx-0 mt-0">
                    Use Add to upload a CSV, TSV, JSON or Parquet file, read a folder, an S3 bucket
                    or a database, or start from demo data.
                </EmptyState>
            ) : (
                <>
                    <div className="flex flex-wrap gap-x-8 gap-y-3">
                        <Stat label="Sources" value={count(sources.length)} />
                        <Stat label="Datasets reading them" value={count(reading)} />
                        <Stat label="Uploads stored" value={bytes(stored)} />
                    </div>
                    <DataGrid
                        columns={KIND_COLUMNS}
                        rows={rows}
                        getRowId={(row) => row.kind}
                        sortable={false}
                        onOpen={(row) => onSelect({ kind: "group", id: row.kind })}
                        rowLabel={(row) => `${row.label}, ${plural(row.sources, row.noun)}`}
                    />
                </>
            )}
        </div>
    );
}
