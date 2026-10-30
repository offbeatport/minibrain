import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "obp-ui";
import { useInstallSettings } from "~/api/queries";
import type { components } from "~/api/schema";
import { DataTable } from "~/components/DataTable";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, Section, Stat } from "~/components/Section";
import { count } from "~/lib/format";

type BaseModelInfo = components["schemas"]["BaseModelInfo"];

const SPLIT_LABELS: Record<string, string> = {
    golden: "Test set (max)",
    eval: "Held-out (max)",
    shots: "Few-shot (max)",
    min_rows: "Minimum rows",
};

function baseModelColumns(defaultKey: string | undefined): ColumnDef<BaseModelInfo, unknown>[] {
    return [
        {
            header: "Key",
            id: "key",
            cell: ({ row }) => (
                <span className="flex items-center gap-2">
                    <span className="font-mono">{row.original.key}</span>
                    {row.original.key === defaultKey && <Badge variant="neutral">Default</Badge>}
                </span>
            ),
        },
        {
            header: "Repository",
            accessorKey: "repo",
            cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
        },
        {
            header: "Revision",
            accessorKey: "revision",
            cell: (info) => (
                <span className="font-mono">{String(info.getValue()).slice(0, 12)}</span>
            ),
        },
        { header: "License", accessorKey: "license" },
    ];
}

function Path({ label, value }: { label: string; value: string | undefined }) {
    return (
        <div>
            <div className="text-sm text-muted-foreground">{label}</div>
            <div className="break-all font-mono text-sm">{value ?? "–"}</div>
        </div>
    );
}

export function SettingsPage() {
    const { data, error } = useInstallSettings();
    return (
        <Page>
            <PageHeader
                title="Settings"
                caption="Read-only for now. Set MINIBRAIN_HOME before starting to move the install."
            />
            <ErrorLine error={error} />
            <Section title="Install">
                <div className="flex flex-col gap-3">
                    <Path label="Data, adapters and jobs" value={data?.home} />
                    <Path label="Database" value={data?.database} />
                    <Path label="Web app" value={data?.web} />
                </div>
            </Section>
            <Section
                title="Base models"
                caption="Pinned to an exact revision; adapters record which one they were trained on."
            >
                <DataTable
                    columns={baseModelColumns(data?.default_base_model)}
                    rows={data?.base_models ?? []}
                />
            </Section>
            <Section
                title="Default training recipe"
                caption="New trained versions start from these values."
            >
                <div className="flex flex-wrap gap-8">
                    {Object.entries(data?.recipe ?? {}).map(([key, value]) => (
                        <Stat
                            key={key}
                            label={key.replaceAll("_", " ")}
                            value={<span className="font-mono">{String(value)}</span>}
                        />
                    ))}
                </div>
            </Section>
            <Section title="Dataset splits">
                <div className="flex flex-wrap gap-8">
                    {Object.entries(data?.splits ?? {}).map(([key, value]) => (
                        <Stat key={key} label={SPLIT_LABELS[key] ?? key} value={count(value)} />
                    ))}
                </div>
            </Section>
        </Page>
    );
}
