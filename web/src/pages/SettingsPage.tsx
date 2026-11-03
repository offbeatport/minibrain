import { useMutation, useQuery } from "@tanstack/react-query";
import { BookMarked, GraduationCap, Palette, Split } from "lucide-react";
import { Button, SettingsGroup, SettingsRow, Switch } from "obp-ui";
import { useState } from "react";
import { api, unwrap } from "~/api/client";
import { useCatalog, useInstallSettings } from "~/api/queries";
import { ErrorLine, PanelSection, PanelSections, Stat, errorMessage } from "~/components/Section";
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
    const checked = data?.synced_at
        ? `Checked for updates ${relativeTime(data.synced_at)}`
        : "Using the catalogue bundled with this release";
    return (
        <PanelSection icon={BookMarked} title="Model catalogue">
            <SettingsGroup>
                <SettingsRow
                    label="Catalogue updates"
                    description={`${checked}${data?.sync_job?.status === "failed" ? "; the last check failed" : ""}.`}
                    error={errorMessage(sync.error)}
                    control={
                        <Button
                            variant="outline"
                            onClick={() => sync.mutate()}
                            disabled={data?.online === false || Boolean(syncing) || sync.isPending}
                        >
                            {syncing ? "Checking…" : "Check for updates"}
                        </Button>
                    }
                />
                <SettingsRow
                    id="daily-sync"
                    toggle
                    disabled={data?.offline_forced}
                    label="Check every day"
                    description={
                        data?.offline_forced
                            ? "Off while this install cannot reach the model hub."
                            : "Looks for a newer catalogue once a day."
                    }
                    error={errorMessage(daily.error)}
                    control={
                        <Switch
                            id="daily-sync"
                            checked={dailyOn ?? settings.data?.daily_sync ?? false}
                            disabled={data?.offline_forced}
                            readOnly={daily.isPending}
                            onCheckedChange={(next) => {
                                setDailyOn(next);
                                daily.mutate(next);
                            }}
                        />
                    }
                />
            </SettingsGroup>
        </PanelSection>
    );
}

export function SettingsPage() {
    const { data, error } = useInstallSettings();
    return (
        <SettingsLayout title="General">
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
