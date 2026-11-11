import type { ColumnDef } from "@tanstack/react-table";
import { Check } from "lucide-react";
import { Button, DataGrid, Tooltip, TooltipContent, TooltipTrigger, cn } from "obp-ui";
import { useState } from "react";
import type { BaseModelDetail, ModelRow } from "~/api/client";
import { ErrorLine } from "~/components/Section";
import { FILE_STATES, type HealthAction } from "~/components/models/HealthStatus";
import { StatusText } from "~/components/models/StatusText";
import { RETRY_LABELS, REVIEW_LABEL, needsReview, retryTeardown } from "~/lib/teardown";
import { bytes, relativeTime } from "~/lib/time";

export function HealthNotice({
    row,
    run,
    shown = () => true,
}: {
    row: ModelRow;
    run?: (row: ModelRow, action: HealthAction) => void;
    shown?: (action: HealthAction) => boolean;
}) {
    const health = row.health;
    if (!health) {
        return null;
    }
    const actions = run ? health.actions.filter(shown) : [];
    return (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive-soft p-3">
            <div className="flex min-w-0 max-w-3xl flex-col gap-1">
                <StatusText tone="destructive" className="font-semibold">
                    {health.label}
                </StatusText>
                <p>{health.detail}</p>
            </div>
            {actions.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                    {actions.map((action, index) => (
                        <Button
                            key={action.kind}
                            variant={index === 0 ? "default" : "outline"}
                            onClick={() => run?.(row, action)}
                        >
                            {action.label}
                        </Button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function TeardownNotice({
    row,
    canRetry,
    onRetried,
    onReview,
}: {
    row: ModelRow;
    canRetry: boolean;
    onRetried: () => Promise<unknown>;
    onReview?: () => void;
}) {
    const teardown = row.teardown;
    const [error, setError] = useState<unknown>(null);
    if (!teardown) {
        return null;
    }
    const failed = teardown.state === "failed";
    const retry = () =>
        retryTeardown(row)
            .then(onRetried)
            .then(() => setError(null), setError);
    return (
        <div
            className={cn(
                "flex flex-wrap items-start justify-between gap-3 rounded-md border p-3",
                failed
                    ? "border-destructive/40 bg-destructive-soft"
                    : "border-info/40 bg-info-soft",
            )}
        >
            <div className="flex min-w-0 max-w-3xl flex-col gap-1">
                <StatusText tone={failed ? "destructive" : "info"} className="font-semibold">
                    {teardown.label}
                </StatusText>
                <p>{teardown.detail}</p>
                <p className="text-muted-foreground">
                    {`Started by ${teardown.started_by} ${relativeTime(teardown.started_at)}.`}
                </p>
                <ErrorLine error={error} />
            </div>
            {failed && canRetry && onReview && needsReview(teardown) ? (
                <Button onClick={onReview}>{REVIEW_LABEL}</Button>
            ) : (
                failed && canRetry && <Button onClick={retry}>{RETRY_LABELS[teardown.kind]}</Button>
            )}
        </div>
    );
}

type FileRow = {
    path: string;
    size: number;
    sha256: string | null;
    state?: BaseModelDetail["files"][number]["state"];
};

function FileHash({ file }: { file: FileRow }) {
    const state = file.state ?? "unchecked";
    const hash = (
        <span className="font-mono text-muted-foreground">
            {file.sha256 ? file.sha256.slice(0, 16) : "—"}
        </span>
    );
    if (state === "ok") {
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1.5 rounded-sm">
                        <Check aria-hidden="true" className="size-4 shrink-0 text-success" />
                        <span className="sr-only">Matches: </span>
                        {hash}
                    </span>
                </TooltipTrigger>
                <TooltipContent>Matches the SHA-256 saved at install</TooltipContent>
            </Tooltip>
        );
    }
    if (state === "unchecked") {
        return file.sha256 ? (
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="rounded-sm">{hash}</span>
                </TooltipTrigger>
                <TooltipContent className="font-mono">{file.sha256}</TooltipContent>
            </Tooltip>
        ) : (
            hash
        );
    }
    return (
        <span className="inline-flex items-center gap-2">
            <StatusText tone={FILE_STATES[state].tone}>{FILE_STATES[state].label}</StatusText>
            {hash}
        </span>
    );
}

const FILE_COLUMNS: ColumnDef<FileRow, unknown>[] = [
    {
        header: "File",
        accessorKey: "path",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
    {
        header: "Size",
        accessorKey: "size",
        cell: (info) => <span className="tabular-nums">{bytes(Number(info.getValue()))}</span>,
    },
    {
        header: "SHA-256",
        id: "sha256",
        accessorFn: (file) => `${file.state ?? "unchecked"} ${file.sha256 ?? ""}`,
        cell: ({ row }) => <FileHash file={row.original} />,
    },
];

export function FileTable({
    files,
    empty,
    loading = false,
}: {
    files: FileRow[];
    empty: string;
    loading?: boolean;
}) {
    return (
        <DataGrid
            columns={FILE_COLUMNS}
            rows={files}
            getRowId={(file) => file.path}
            loading={loading}
            empty={empty}
        />
    );
}
