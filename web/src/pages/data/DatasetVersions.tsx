import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Button, DataGrid, Link, Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import { useState } from "react";
import { type DatasetSummary, api, unwrap } from "~/api/client";
import {
    type ChangeInfo,
    type DatasetVersionInfo,
    dataKeys,
    useDatasetVersions,
} from "~/api/dataQueries";
import { keys } from "~/api/queries";
import { ErrorLine, Section } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { useCan } from "~/lib/access";
import { count } from "~/lib/format";
import { bytes, exactTime, relativeTime } from "~/lib/time";
import { VersionDiffDialog, compareParam, parseCompare, versionName } from "./VersionDiff";
import { modelHref, useModelNames } from "./parts";

export function takenAt(datasetVersion: DatasetVersionInfo): string {
    return datasetVersion.taken_at ?? datasetVersion.created_at;
}

export function shortId(datasetVersion: DatasetVersionInfo): string {
    return datasetVersion.hash.slice(0, 12);
}

function shortName(datasetVersion: DatasetVersionInfo): string {
    return datasetVersion.number === null || datasetVersion.number === undefined
        ? versionName(datasetVersion)
        : `v${datasetVersion.number}`;
}

export function changeText(
    changed: ChangeInfo | null | undefined,
    datasetVersion: DatasetVersionInfo,
): string | null {
    if (!changed) {
        return null;
    }
    const since = shortName(datasetVersion);
    if (changed.dataset) {
        return `The model now uses another dataset than ${since}`;
    }
    if (changed.data && changed.query) {
        return `Sources and query changed since ${since}`;
    }
    if (changed.data) {
        return `Sources changed since ${since}`;
    }
    return changed.query ? `Query changed since ${since}` : null;
}

export function useVersionRefresh(slug: string) {
    const client = useQueryClient();
    return () =>
        Promise.all([
            client.invalidateQueries({ queryKey: dataKeys.datasetVersions(slug) }),
            client.invalidateQueries({ queryKey: keys.dataset(slug) }),
            client.invalidateQueries({ queryKey: keys.datasets, exact: true }),
            client.invalidateQueries({ queryKey: ["model"] }),
            client.invalidateQueries({ queryKey: ["infrastructure"] }),
        ]);
}

export function UpdateVersion({ dataset, label = "Update" }: { dataset: string; label?: string }) {
    const refresh = useVersionRefresh(dataset);
    const update = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/datasets/{slug}/versions", {
                    params: { path: { slug: dataset } },
                }),
            ),
        onSuccess: refresh,
    });
    return (
        <>
            <Button
                variant="outline"
                size="sm"
                onClick={() => update.mutate()}
                disabled={update.isPending}
            >
                {update.isPending ? "Saving…" : label}
            </Button>
            <ErrorLine error={update.error} />
        </>
    );
}

export function ChangeNotice({
    changed,
    datasetVersion,
    dataset,
    after,
}: {
    changed: ChangeInfo | null | undefined;
    datasetVersion: DatasetVersionInfo | null | undefined;
    dataset?: string | null;
    after?: string;
}) {
    const can = useCan();
    const text = datasetVersion ? changeText(changed, datasetVersion) : null;
    if (!text || !datasetVersion) {
        return null;
    }
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-sm">
                <StatusText tone="warning">{text}</StatusText>
                <span className="text-muted-foreground">
                    {` · ${shortName(datasetVersion)} saved ${relativeTime(takenAt(datasetVersion))}. ${after ?? "Update to save the next version."}`}
                </span>
            </p>
            {dataset && can.build && <UpdateVersion dataset={dataset} />}
        </div>
    );
}

export function FirstVersionNotice({ dataset }: { dataset: DatasetSummary }) {
    if (dataset.dataset_version || !dataset.mapping.sql) {
        return null;
    }
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-sm">
                <StatusText tone="warning">No version yet</StatusText>
                <span className="text-muted-foreground">
                    {" · Models train and score on a saved version of the rows."}
                </span>
            </p>
            <UpdateVersion dataset={dataset.slug} label="Save version 1" />
        </div>
    );
}

export function RowLimitNotice({ rows, limit }: { rows: number | null; limit: number }) {
    if (rows === null || limit <= 0 || rows <= limit) {
        return null;
    }
    return (
        <p className="text-sm text-destructive">
            {`${count(rows)} rows: more than the ${count(limit)} one version holds, so no new version can be saved. Filter or sample in the query, for example `}
            <span className="font-mono">{`USING SAMPLE reservoir(${limit} ROWS) REPEATABLE (7)`}</span>
            {", or raise the limit under "}
            <Link href="/settings/data" className="text-primary hover:underline">
                Settings, Data
            </Link>
            .
        </p>
    );
}

function UsedBy({ datasetVersion }: { datasetVersion: DatasetVersionInfo }) {
    const nameOf = useModelNames();
    if (datasetVersion.versions.length === 0) {
        return <span className="text-muted-foreground">–</span>;
    }
    return (
        <span className="flex min-w-0 flex-wrap gap-x-2">
            {datasetVersion.versions.map((tag) => {
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

function ChecksSummary({ datasetVersion }: { datasetVersion: DatasetVersionInfo }) {
    const checks = datasetVersion.checks ?? [];
    if (checks.length === 0) {
        return <span className="text-muted-foreground">Not run</span>;
    }
    const open = checks.filter((check) => check.status === "warning" && !check.dismissed);
    return open.length === 0 ? (
        <StatusText tone="success">Passed</StatusText>
    ) : (
        <StatusText tone="warning">
            {open.length === 1 ? "1 warning" : `${count(open.length)} warnings`}
        </StatusText>
    );
}

const VERSION_COLUMNS: ColumnDef<DatasetVersionInfo, unknown>[] = [
    {
        id: "version",
        header: "Version",
        accessorFn: (datasetVersion) => datasetVersion.number ?? 0,
        cell: ({ row }) => (
            <span className="font-semibold tabular-nums">{`Version ${row.original.number}`}</span>
        ),
    },
    {
        id: "taken",
        header: "Saved",
        accessorFn: (datasetVersion) => takenAt(datasetVersion),
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
        accessorFn: (datasetVersion) => datasetVersion.rows,
        cell: ({ row }) => <span className="tabular-nums">{count(row.original.rows)}</span>,
    },
    {
        id: "labels",
        header: "Labels",
        accessorFn: (datasetVersion) => datasetVersion.labels.length,
        cell: ({ row }) => (
            <span className="tabular-nums">{count(row.original.labels.length)}</span>
        ),
    },
    {
        id: "checks",
        header: "Checks",
        enableSorting: false,
        cell: ({ row }) => <ChecksSummary datasetVersion={row.original} />,
    },
    {
        id: "used",
        header: "Used by",
        enableSorting: false,
        cell: ({ row }) => <UsedBy datasetVersion={row.original} />,
    },
    {
        id: "size",
        header: "Size",
        accessorFn: (datasetVersion) => datasetVersion.size,
        cell: ({ row }) => <span className="tabular-nums">{bytes(row.original.size)}</span>,
    },
    {
        id: "id",
        header: "SHA-256",
        accessorFn: (datasetVersion) => datasetVersion.hash,
        cell: ({ row }) => (
            <span className="font-mono text-muted-foreground">{shortId(row.original)}</span>
        ),
    },
];

function ordered(pair: string[], datasetVersions: DatasetVersionInfo[]): [number, number] | null {
    const picked = datasetVersions.filter((datasetVersion) =>
        pair.includes(String(datasetVersion.id)),
    );
    if (picked.length !== 2) {
        return null;
    }
    const [older, newer] = picked.sort((left, right) => (left.number ?? 0) - (right.number ?? 0));
    return [older.id, newer.id];
}

export function VersionsSection({ dataset }: { dataset: DatasetSummary }) {
    const datasetVersions = useDatasetVersions(dataset.slug);
    const router = useRouter();
    const requested = useRouterState({
        select: (state) => parseCompare((state.location.search as { compare?: unknown }).compare),
    });
    const [selected, setSelected] = useState<string[]>([]);
    const rows = datasetVersions.data ?? [];
    const pair = ordered(selected, rows);
    const close = () => {
        const params = new URLSearchParams(window.location.search);
        params.delete("compare");
        router.history.replace(`/data?${params.toString()}`);
    };
    return (
        <Section
            title="Versions"
            caption="Saved copies of the query's rows, newest first. Models train and score on a version: saving the query or Update makes the next one, and identical rows are stored once. Tick two to compare them."
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
            <ErrorLine error={datasetVersions.error} />
            <DataGrid
                columns={VERSION_COLUMNS}
                rows={rows}
                getRowId={(datasetVersion) => String(datasetVersion.id)}
                selectedIds={selected}
                onSelectedIdsChange={(ids) => setSelected(ids.slice(-2))}
                loading={datasetVersions.isLoading}
                loadingRows={2}
                maxHeight="320px"
                storageKey="minibrain.data.versions"
                empty="No version yet. Pick the input and label columns and save them to make version 1."
            />
            <VersionDiffDialog pair={requested} onClose={close} />
        </Section>
    );
}
