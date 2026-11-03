import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Button, DataGrid, Link, Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import { useState } from "react";
import { type DatasetSummary, api, unwrap } from "~/api/client";
import { type ChangeInfo, type SnapshotInfo, dataKeys, useSnapshots } from "~/api/dataQueries";
import { keys } from "~/api/queries";
import { ErrorLine, Section } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { bytes, exactTime, relativeTime } from "~/lib/time";
import { SnapshotDiffDialog, compareParam, parseCompare } from "./SnapshotDiff";
import { modelHref, useModelNames } from "./parts";

export function takenAt(snapshot: SnapshotInfo): string {
    return snapshot.taken_at ?? snapshot.created_at;
}

export function shortId(snapshot: SnapshotInfo): string {
    return snapshot.hash.slice(0, 12);
}

export function changeText(changed: ChangeInfo | null | undefined): string | null {
    if (!changed) {
        return null;
    }
    if (changed.dataset) {
        return "The model now uses another dataset than its last snapshot";
    }
    if (changed.data && changed.query) {
        return "Data and query changed since the last snapshot";
    }
    if (changed.data) {
        return "Data changed since the last snapshot";
    }
    return changed.query ? "The query changed since the last snapshot" : null;
}

export function ChangeNotice({
    changed,
    snapshot,
    after,
}: {
    changed: ChangeInfo | null | undefined;
    snapshot: SnapshotInfo | null | undefined;
    after?: string;
}) {
    const text = changeText(changed);
    if (!text || !snapshot) {
        return null;
    }
    return (
        <p className="text-sm">
            <StatusText tone="warning">{text}</StatusText>
            <span className="text-muted-foreground">
                {` · taken ${relativeTime(takenAt(snapshot))}. ${after ?? "The next training run takes a new one."}`}
            </span>
        </p>
    );
}

export function RowLimitNotice({ rows, limit }: { rows: number | null; limit: number }) {
    if (rows === null || limit <= 0 || rows <= limit) {
        return null;
    }
    return (
        <p className="text-sm text-destructive">
            {`${count(rows)} rows: more than the ${count(limit)} one snapshot holds, so training would be refused. Filter or sample in the query, for example `}
            <span className="font-mono">{`USING SAMPLE reservoir(${limit} ROWS) REPEATABLE (7)`}</span>
            {", or raise the limit under "}
            <Link href="/settings/data" className="text-primary hover:underline">
                Settings, Data
            </Link>
            .
        </p>
    );
}

export function useSnapshotRefresh(slug: string) {
    const client = useQueryClient();
    return () =>
        Promise.all([
            client.invalidateQueries({ queryKey: dataKeys.snapshots(slug) }),
            client.invalidateQueries({ queryKey: keys.dataset(slug) }),
            client.invalidateQueries({ queryKey: keys.datasets, exact: true }),
            client.invalidateQueries({ queryKey: ["infrastructure"] }),
        ]);
}

export function SaveSnapshot({ dataset }: { dataset: DatasetSummary }) {
    const refresh = useSnapshotRefresh(dataset.slug);
    const save = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/datasets/{slug}/snapshots", {
                    params: { path: { slug: dataset.slug } },
                }),
            ),
        onSuccess: refresh,
    });
    return (
        <div className="flex flex-col items-end gap-1">
            <Button
                variant="outline"
                onClick={() => save.mutate()}
                disabled={!dataset.mapping.sql || save.isPending}
            >
                {save.isPending ? "Saving…" : "Save snapshot now"}
            </Button>
            <ErrorLine error={save.error} />
        </div>
    );
}

function Kept({ snapshot }: { snapshot: SnapshotInfo }) {
    const nameOf = useModelNames();
    if (snapshot.versions.length > 0) {
        return (
            <span className="flex min-w-0 flex-wrap gap-x-2">
                {snapshot.versions.map((tag) => {
                    const [slug, number] = tag.split("@");
                    return (
                        <Link key={tag} href={modelHref(slug)} className="truncate text-primary">
                            {`${nameOf(slug)} v${number}`}
                        </Link>
                    );
                })}
            </span>
        );
    }
    return <span className="text-muted-foreground">{snapshot.saved ? "Saved" : "–"}</span>;
}

const SNAPSHOT_COLUMNS: ColumnDef<SnapshotInfo, unknown>[] = [
    {
        id: "taken",
        header: "Taken",
        accessorFn: (snapshot) => takenAt(snapshot),
        cell: ({ row }) => (
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="tabular-nums">{relativeTime(takenAt(row.original))}</span>
                </TooltipTrigger>
                <TooltipContent>{exactTime(takenAt(row.original))}</TooltipContent>
            </Tooltip>
        ),
    },
    {
        id: "rows",
        header: "Rows",
        accessorFn: (snapshot) => snapshot.rows,
        cell: ({ row }) => <span className="tabular-nums">{count(row.original.rows)}</span>,
    },
    {
        id: "labels",
        header: "Labels",
        accessorFn: (snapshot) => snapshot.labels.length,
        cell: ({ row }) => (
            <span className="tabular-nums">{count(row.original.labels.length)}</span>
        ),
    },
    {
        id: "size",
        header: "Size",
        accessorFn: (snapshot) => snapshot.size,
        cell: ({ row }) => <span className="tabular-nums">{bytes(row.original.size)}</span>,
    },
    {
        id: "kept",
        header: "Kept for",
        enableSorting: false,
        cell: ({ row }) => <Kept snapshot={row.original} />,
    },
    {
        id: "id",
        header: "Snapshot",
        accessorFn: (snapshot) => snapshot.hash,
        cell: ({ row }) => (
            <span className="font-mono text-muted-foreground">{shortId(row.original)}</span>
        ),
    },
];

function ordered(pair: string[], snapshots: SnapshotInfo[]): [number, number] | null {
    const picked = snapshots.filter((snapshot) => pair.includes(String(snapshot.id)));
    if (picked.length !== 2) {
        return null;
    }
    const [older, newer] = picked.sort((left, right) =>
        takenAt(left).localeCompare(takenAt(right)),
    );
    return [older.id, newer.id];
}

export function SnapshotsSection({ dataset }: { dataset: DatasetSummary }) {
    const snapshots = useSnapshots(dataset.slug);
    const router = useRouter();
    const requested = useRouterState({
        select: (state) => parseCompare((state.location.search as { compare?: unknown }).compare),
    });
    const [selected, setSelected] = useState<string[]>([]);
    const rows = snapshots.data ?? [];
    const pair = ordered(selected, rows);
    const close = () => {
        const params = new URLSearchParams(window.location.search);
        params.delete("compare");
        router.history.replace(`/data?${params.toString()}`);
    };
    return (
        <Section
            title="Snapshots"
            caption="Frozen copies of the query's rows. Training and scoring read only a snapshot; a new one is taken when a run starts, and identical rows are stored once. Tick two to compare them."
            actions={
                <Button
                    variant="outline"
                    size="sm"
                    disabled={pair === null}
                    onClick={() => {
                        if (pair) {
                            const params = new URLSearchParams(window.location.search);
                            params.set("compare", compareParam(pair[0], pair[1]));
                            router.history.replace(`/data?${params.toString()}`);
                        }
                    }}
                >
                    Compare
                </Button>
            }
            flush
        >
            <ErrorLine error={snapshots.error} />
            <DataGrid
                columns={SNAPSHOT_COLUMNS}
                rows={rows}
                getRowId={(snapshot) => String(snapshot.id)}
                selectedIds={selected}
                onSelectedIdsChange={(ids) => setSelected(ids.slice(-2))}
                loading={snapshots.isLoading}
                loadingRows={2}
                maxHeight="320px"
                storageKey="minibrain.data.snapshots"
                empty="No snapshot yet. One is taken when a model trains on this dataset, or with Save snapshot now."
            />
            <SnapshotDiffDialog pair={requested} onClose={close} />
        </Section>
    );
}
