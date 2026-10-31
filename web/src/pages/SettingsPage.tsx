import type { ColumnDef } from "@tanstack/react-table";
import { Badge, SegmentedTabs, type ThemePref, getThemePref, setThemePref } from "obp-ui";
import { type ReactNode, useState } from "react";
import { useInstallSettings } from "~/api/queries";
import type { components } from "~/api/schema";
import { DataTable } from "~/components/DataTable";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, Section, Stat } from "~/components/Section";
import { SettingsTabs } from "~/components/SettingsTabs";
import { count } from "~/lib/format";

type BaseModelInfo = components["schemas"]["BaseModelInfo"];

const MODES: { key: ThemePref; label: string }[] = [
    { key: "light", label: "Light" },
    { key: "dark", label: "Dark" },
    { key: "system", label: "System" },
];

function isThemePref(value: string): value is ThemePref {
    return MODES.some((mode) => mode.key === value);
}

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

function Group({ title, caption }: { title: string; caption: ReactNode }) {
    return (
        <div className="pt-2">
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="text-sm text-muted-foreground">{caption}</p>
        </div>
    );
}

function Appearance() {
    const [mode, setMode] = useState<ThemePref>(getThemePref());
    const choose = (key: string) => {
        if (isThemePref(key)) {
            setThemePref(key);
            setMode(key);
        }
    };
    return (
        <Section title="Appearance" caption="Pick light, dark or follow the system.">
            <SegmentedTabs tabs={MODES} active={mode} onSelect={choose} />
        </Section>
    );
}

export function SettingsPage() {
    const { data, error } = useInstallSettings();
    return (
        <Page>
            <PageHeader title="Settings" />
            <SettingsTabs active="/settings" />
            <Group title="You" caption="Stored in this browser." />
            <Appearance />
            <Group
                title="This install"
                caption="Read-only for now. Set MINIBRAIN_HOME before starting to move the install."
            />
            <ErrorLine error={error} />
            <Section title="Paths">
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
