import { useMutation } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Button, DataGrid } from "obp-ui";
import { useState } from "react";
import { type VersionInfo, api, unwrap } from "~/api/client";
import { useVersions } from "~/api/queries";
import { ScopedPage } from "~/components/PageHeader";
import { Section } from "~/components/Section";
import { VersionStatus } from "~/components/StatusBadge";
import { count, errorText, milliseconds, percent } from "~/lib/format";
import { useInvalidate } from "~/lib/jobs";

function PromoteButton({ slug, version }: { slug: string; version: VersionInfo }) {
    const invalidate = useInvalidate(slug);
    const promote = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/minibrains/{slug}/versions/{number}/promote", {
                    params: { path: { slug, number: version.number } },
                }),
            ),
        onSuccess: () => invalidate(),
    });
    if (version.current || version.status !== "ready") {
        return null;
    }
    return (
        <div className="flex flex-col items-start gap-1">
            <Button size="xs" onClick={() => promote.mutate()} disabled={promote.isPending}>
                Deploy
            </Button>
            {promote.error && (
                <span className="max-w-56 text-sm text-destructive">
                    {errorText(promote.error)}
                </span>
            )}
        </div>
    );
}

function versionColumns(
    slug: string,
    onSelect: (number: number) => void,
): ColumnDef<VersionInfo, unknown>[] {
    return [
        {
            header: "Version",
            id: "version",
            cell: ({ row }) => (
                <button
                    type="button"
                    className="font-mono text-primary"
                    onClick={() => onSelect(row.original.number)}
                >
                    v{row.original.number}
                </button>
            ),
        },
        {
            header: "Kind",
            id: "kind",
            cell: ({ row }) => (row.original.kind === "lora" ? "Trained" : "Prompt-only"),
        },
        {
            header: "Status",
            id: "status",
            cell: ({ row }) => <VersionStatus version={row.original} />,
        },
        {
            header: "Test set",
            id: "golden",
            cell: ({ row }) => percent(row.original.golden?.accuracy),
        },
        {
            header: "Held-out",
            id: "held",
            cell: ({ row }) => percent(row.original.held_out?.accuracy),
        },
        {
            header: "Macro F1",
            id: "f1",
            cell: ({ row }) => row.original.held_out?.macro_f1.toFixed(3) ?? "–",
        },
        {
            header: "Invalid",
            id: "invalid",
            cell: ({ row }) => percent(row.original.held_out?.invalid_rate),
        },
        { header: "p50", id: "p50", cell: ({ row }) => milliseconds(row.original.latency_p50_ms) },
        {
            header: "Prompt tokens",
            id: "tokens",
            cell: ({ row }) => count(row.original.prompt_tokens),
        },
        {
            header: "",
            id: "promote",
            cell: ({ row }) => <PromoteButton slug={slug} version={row.original} />,
        },
    ];
}

type Mistake = VersionInfo["mistakes"][number];

const MISTAKE_COLUMNS: ColumnDef<Mistake, unknown>[] = [
    { header: "Input", accessorKey: "input" },
    {
        header: "Expected",
        accessorKey: "gold",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
    {
        header: "Got",
        accessorKey: "output",
        cell: (info) => (
            <span className="font-mono text-destructive">{String(info.getValue())}</span>
        ),
    },
];

function Evaluations({ slug }: { slug: string }) {
    const { data: versions } = useVersions(slug);
    const [selected, setSelected] = useState<number | null>(null);
    const shown = versions?.find((version) => version.number === selected) ?? versions?.[0];
    return (
        <>
            <Section
                title="Versions"
                caption="Every version is scored on the same test set and held-out rows. Promotion is blocked when a version scores below the current one on held-out rows."
            >
                <DataGrid
                    columns={versionColumns(slug, setSelected)}
                    rows={versions ?? []}
                    empty="No versions yet. Score or train one on the Training page."
                />
            </Section>
            {shown && shown.mistakes.length > 0 && (
                <Section
                    title={`Mistakes in v${shown.number}`}
                    caption="Up to 20 held-out rows it got wrong."
                >
                    <DataGrid columns={MISTAKE_COLUMNS} rows={shown.mistakes} />
                </Section>
            )}
        </>
    );
}

export function EvaluationsPage() {
    return (
        <ScopedPage
            title="Evaluations"
            caption="Compare versions on the same examples and promote the best one."
        >
            {(slug) => <Evaluations slug={slug} />}
        </ScopedPage>
    );
}
