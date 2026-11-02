import type { ColumnDef } from "@tanstack/react-table";
import { Box, FolderOpen, GraduationCap, Palette, Split } from "lucide-react";
import { Badge, SegmentedTabs, type ThemePref, getThemePref, setThemePref } from "obp-ui";
import { useState } from "react";
import { useInstallSettings } from "~/api/queries";
import type { components } from "~/api/schema";
import { DataTable } from "~/components/DataTable";
import { ErrorLine, PanelSection, PanelSections, Stat } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
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

function Appearance() {
    const [mode, setMode] = useState<ThemePref>(getThemePref());
    const choose = (key: string) => {
        if (isThemePref(key)) {
            setThemePref(key);
            setMode(key);
        }
    };
    return (
        <PanelSection icon={Palette} title="Appearance">
            <SegmentedTabs tabs={MODES} active={mode} onSelect={choose} />
        </PanelSection>
    );
}

export function SettingsPage() {
    const { data, error } = useInstallSettings();
    return (
        <SettingsLayout>
            <ErrorLine error={error} />
            <PanelSections>
                <Appearance />
                <PanelSection icon={FolderOpen} title="Paths">
                    <div className="flex flex-col gap-3">
                        <Path label="Data, adapters and jobs" value={data?.home} />
                        <Path label="Database" value={data?.database} />
                        <Path label="Web app" value={data?.web} />
                        <p className="border-t pt-3 text-sm text-muted-foreground">
                            To move the install, set{" "}
                            <span className="font-mono text-foreground">MINIBRAIN_HOME</span> before
                            starting minibrain.
                        </p>
                    </div>
                </PanelSection>
                <PanelSection icon={Box} title="Base models">
                    <DataTable
                        columns={baseModelColumns(data?.default_base_model)}
                        rows={data?.base_models ?? []}
                    />
                </PanelSection>
                <PanelSection icon={GraduationCap} title="Default training recipe">
                    <div className="flex flex-wrap gap-8">
                        {Object.entries(data?.recipe ?? {}).map(([key, value]) => (
                            <Stat
                                key={key}
                                label={key.replaceAll("_", " ")}
                                value={<span className="font-mono">{String(value)}</span>}
                            />
                        ))}
                    </div>
                </PanelSection>
                <PanelSection icon={Split} title="Dataset splits">
                    <div className="flex flex-wrap gap-8">
                        {Object.entries(data?.splits ?? {}).map(([key, value]) => (
                            <Stat key={key} label={SPLIT_LABELS[key] ?? key} value={count(value)} />
                        ))}
                    </div>
                </PanelSection>
            </PanelSections>
        </SettingsLayout>
    );
}
