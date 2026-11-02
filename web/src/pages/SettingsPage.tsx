import { useMutation, useQuery } from "@tanstack/react-query";
import { BookMarked, GraduationCap, Palette, Split } from "lucide-react";
import { Button, Label, Switch } from "obp-ui";
import { useState } from "react";
import { api, unwrap } from "~/api/client";
import { useCatalog, useInstallSettings } from "~/api/queries";
import { ErrorLine, PanelSection, PanelSections, Stat } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import { ThemeChoice } from "~/components/ThemeChoice";
import { count } from "~/lib/format";
import { relativeTime } from "~/lib/time";
import { useModelsRefresh } from "./models/dialogs";

const SPLIT_LABELS: Record<string, string> = {
    golden: "Test set (max)",
    eval: "Held-out (max)",
    shots: "Few-shot (max)",
    min_rows: "Minimum rows",
};

function Appearance() {
    return (
        <PanelSection icon={Palette} title="Appearance">
            <ThemeChoice />
        </PanelSection>
    );
}

function ModelCatalogue() {
    const refresh = useModelsRefresh();
    const catalog = useCatalog();
    const settings = useQuery({
        queryKey: ["catalog", "settings"],
        queryFn: () => unwrap(api.GET("/api/catalog/settings")),
    });
    const [dailyOn, setDailyOn] = useState<boolean | null>(null);
    const sync = useMutation({
        mutationFn: () => unwrap(api.POST("/api/catalog/sync")),
        onSuccess: refresh,
    });
    const daily = useMutation({
        mutationFn: (value: boolean) =>
            unwrap(api.PUT("/api/catalog/settings", { body: { daily_sync: value } })),
    });
    const data = catalog.data;
    const syncing = data?.sync_job && ["queued", "running"].includes(data.sync_job.status);
    return (
        <PanelSection icon={BookMarked} title="Model catalogue">
            <div className="flex flex-col gap-3 text-sm">
                <div className="flex flex-wrap items-center gap-3">
                    <span>
                        {data?.synced_at
                            ? `Checked for updates ${relativeTime(data.synced_at)}`
                            : "Using the catalogue bundled with this release"}
                        {data?.sync_job?.status === "failed" ? "; the last check failed" : ""}
                    </span>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => sync.mutate()}
                        disabled={data?.online === false || Boolean(syncing) || sync.isPending}
                    >
                        {syncing ? "Checking…" : "Check for updates"}
                    </Button>
                </div>
                <Label htmlFor="daily-sync" className="flex items-center gap-2 font-normal">
                    <Switch
                        id="daily-sync"
                        checked={dailyOn ?? settings.data?.daily_sync ?? false}
                        onCheckedChange={(checked) => {
                            setDailyOn(checked);
                            daily.mutate(checked);
                        }}
                        disabled={data?.offline_forced}
                    />
                    Check every day
                </Label>
                <ErrorLine error={sync.error ?? daily.error} />
            </div>
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
                <ModelCatalogue />
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
