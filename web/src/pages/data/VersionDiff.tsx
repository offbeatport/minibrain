import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
    CompareTable,
    DataGrid,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    SegmentedTabs,
} from "obp-ui";
import { useState } from "react";
import { api, unwrap } from "~/api/client";
import type { components } from "~/api/schema";
import { ErrorLine, Stat } from "~/components/Section";
import { count } from "~/lib/format";
import { exactTime } from "~/lib/time";

type Schemas = components["schemas"];
type VersionDiff = Schemas["DatasetVersionDiff"];
type DiffRow = Schemas["DiffRow"];
type RelabelInfo = Schemas["RelabelInfo"];
type DatasetVersionInfo = Schemas["DatasetVersionInfo"];
type Sample = "added" | "removed" | "relabelled";

export function compareParam(before: number, after: number): string {
    return `${before}~${after}`;
}

export function parseCompare(value: unknown): [number, number] | null {
    if (typeof value !== "string") {
        return null;
    }
    const [before, after] = value.split("~").map(Number);
    return Number.isInteger(before) && Number.isInteger(after) ? [before, after] : null;
}

function signed(value: number): string {
    if (value === 0) {
        return "0";
    }
    return value > 0 ? `+${count(value)}` : `−${count(Math.abs(value))}`;
}

function Clamp({ text }: { text: string }) {
    return <span className="line-clamp-2 max-w-xl whitespace-normal">{text}</span>;
}

const ROW_COLUMNS: ColumnDef<DiffRow, unknown>[] = [
    {
        header: "Input",
        accessorKey: "input",
        cell: (info) => <Clamp text={String(info.getValue())} />,
    },
    {
        header: "Label",
        accessorKey: "label",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
];

const RELABEL_COLUMNS: ColumnDef<RelabelInfo, unknown>[] = [
    {
        header: "Input",
        accessorKey: "input",
        cell: (info) => <Clamp text={String(info.getValue())} />,
    },
    {
        header: "Was",
        accessorKey: "before",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
    {
        header: "Now",
        accessorKey: "after",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
];

export function versionName(datasetVersion: DatasetVersionInfo): string {
    if (datasetVersion.number !== null && datasetVersion.number !== undefined) {
        return `Version ${datasetVersion.number}`;
    }
    if (datasetVersion.base_number !== null && datasetVersion.base_number !== undefined) {
        return `Version ${datasetVersion.base_number} with feedback`;
    }
    return "Earlier data";
}

function heading(datasetVersion: DatasetVersionInfo, role: string) {
    return (
        <span className="flex flex-col">
            <span className="font-semibold">{`${role}: ${versionName(datasetVersion)}`}</span>
            <span className="text-sm font-normal text-muted-foreground tabular-nums">
                {exactTime(datasetVersion.taken_at ?? datasetVersion.created_at)}
            </span>
            <span className="font-mono text-sm font-normal text-muted-foreground">
                {datasetVersion.hash.slice(0, 12)}
            </span>
        </span>
    );
}

function Shift({ before, after }: { before: number; after: number }) {
    return (
        <span className="tabular-nums">
            {count(after)}
            {after !== before && (
                <span className="ml-2 text-muted-foreground">{signed(after - before)}</span>
            )}
        </span>
    );
}

function DiffBody({ diff }: { diff: VersionDiff }) {
    const [sample, setSample] = useState<Sample>("added");
    const totalBefore = diff.labels.reduce((sum, item) => sum + item.before, 0);
    const totalAfter = diff.labels.reduce((sum, item) => sum + item.after, 0);
    const share = (value: number, total: number) =>
        total ? `${((value / total) * 100).toFixed(1)}%` : "–";
    const sections = [
        {
            id: "size",
            rows: [
                {
                    id: "rows",
                    label: "Rows",
                    cells: [
                        <span key="b" className="tabular-nums">
                            {count(diff.before.rows)}
                        </span>,
                        <Shift key="a" before={diff.before.rows} after={diff.after.rows} />,
                    ],
                    differs: diff.before.rows !== diff.after.rows,
                },
                {
                    id: "labels",
                    label: "Labels",
                    cells: [
                        <span key="b" className="tabular-nums">
                            {count(diff.before.labels.length)}
                        </span>,
                        <Shift
                            key="a"
                            before={diff.before.labels.length}
                            after={diff.after.labels.length}
                        />,
                    ],
                    differs: diff.before.labels.length !== diff.after.labels.length,
                },
            ],
        },
        {
            id: "balance",
            title: "Share of rows per label",
            rows: diff.labels.map((item) => ({
                id: item.label,
                label: <span className="font-mono">{item.label}</span>,
                cells: [
                    <span key="b" className="tabular-nums">
                        {`${share(item.before, totalBefore)} · ${count(item.before)}`}
                    </span>,
                    <span key="a" className="tabular-nums">
                        {`${share(item.after, totalAfter)} · ${count(item.after)}`}
                    </span>,
                ],
                differs:
                    share(item.before, totalBefore) !== share(item.after, totalAfter) ||
                    item.before !== item.after,
            })),
        },
    ];
    const tabs = [
        { key: "added", label: "Added", badge: diff.added },
        { key: "removed", label: "Removed", badge: diff.removed },
        { key: "relabelled", label: "Relabelled", badge: diff.relabelled },
    ];
    const shown = { added: diff.added_rows, removed: diff.removed_rows }[
        sample as "added" | "removed"
    ];
    const totals = { added: diff.added, removed: diff.removed, relabelled: diff.relabelled };
    return (
        <div className="flex min-w-0 flex-col gap-5">
            <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat label="Added" value={count(diff.added)} />
                <Stat label="Removed" value={count(diff.removed)} />
                <Stat label="Relabelled" value={count(diff.relabelled)} />
                <Stat label="Unchanged" value={count(diff.unchanged)} />
            </div>
            <p className="text-sm text-muted-foreground">
                Rows match by their input after trimming spaces; empty rows are left out. A
                relabelled row has the same input and a new label.
            </p>
            <CompareTable
                label="Version comparison"
                columns={[
                    { id: "before", header: heading(diff.before, "Before") },
                    { id: "after", header: heading(diff.after, "After") },
                ]}
                sections={sections}
                labelWidth="12rem"
                columnWidth="14rem"
            />
            <div className="flex min-w-0 flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <SegmentedTabs
                        tabs={tabs}
                        active={sample}
                        onSelect={(key) => setSample(key as Sample)}
                    />
                    <span className="text-sm text-muted-foreground tabular-nums">
                        {totals[sample] > 20 ? `First 20 of ${count(totals[sample])}` : ""}
                    </span>
                </div>
                {sample === "relabelled" ? (
                    <DataGrid
                        columns={RELABEL_COLUMNS}
                        rows={diff.relabelled_rows}
                        maxHeight="280px"
                        empty="No row changed its label."
                    />
                ) : (
                    <DataGrid
                        columns={ROW_COLUMNS}
                        rows={shown ?? []}
                        maxHeight="280px"
                        empty={sample === "added" ? "No rows were added." : "No rows were removed."}
                    />
                )}
            </div>
        </div>
    );
}

export function VersionDiffDialog({
    pair,
    onClose,
}: {
    pair: [number, number] | null;
    onClose: () => void;
}) {
    const [before, after] = pair ?? [0, 0];
    const diff = useQuery({
        queryKey: ["dataset-versions", "diff", before, after] as const,
        queryFn: () =>
            unwrap(
                api.GET("/api/dataset-versions/{dataset_version_id}/diff/{other_id}", {
                    params: { path: { dataset_version_id: before, other_id: after } },
                }),
            ),
        enabled: pair !== null,
        retry: false,
    });
    return (
        <Dialog open={pair !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-4xl">
                <DialogHeader>
                    <DialogTitle>Compare versions</DialogTitle>
                    <DialogDescription>
                        What changed in the rows a model trains on between two versions.
                    </DialogDescription>
                </DialogHeader>
                <ErrorLine error={diff.error} />
                {diff.isLoading && <p className="text-sm text-muted-foreground">Comparing…</p>}
                {diff.data && <DiffBody diff={diff.data} />}
            </DialogContent>
        </Dialog>
    );
}
