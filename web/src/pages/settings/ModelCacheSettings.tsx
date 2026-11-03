import { Package } from "lucide-react";
import { Link, SettingsGroup, SettingsRow, Switch } from "obp-ui";
import { useCacheSettings, useModelCache, useSaveCacheSettings } from "~/api/cacheQueries";
import { NumberSettingRow } from "~/components/NumberSettingRow";
import { ErrorLine, PanelSection, errorMessage } from "~/components/Section";
import { bytes } from "~/lib/time";

const GIGABYTES: Intl.NumberFormatOptions = { maximumFractionDigits: 1 };

function UsageLine() {
    const cache = useModelCache();
    const data = cache.data;
    if (!data) {
        return null;
    }
    return (
        <p className="text-sm text-muted-foreground">
            {`Base models use ${bytes(data.used_bytes)} now; ${bytes(data.evictable_bytes)} of that is unused and can be removed. `}
            <Link href="/infrastructure/storage" className="text-primary hover:underline">
                See which
            </Link>
        </p>
    );
}

export function ModelCacheSettings() {
    const settings = useCacheSettings();
    const save = useSaveCacheSettings();
    const data = settings.data;
    return (
        <PanelSection
            icon={Package}
            title="Base model cache"
            description="A removed base keeps its record and keys, and comes back with Download again or Re-import. Offline, that needs a folder or S3 copy of its files."
        >
            <div className="flex flex-col gap-3">
                <SettingsGroup>
                    <SettingsRow
                        id="model-cache-enabled"
                        toggle
                        disabled={!data}
                        label="Base model cache budget"
                        description="Over the budget, the least recently used bases that no model, version, deployment or job uses are removed, after each download and every hour. Pinned bases stay."
                        error={data?.enabled ? undefined : errorMessage(save.error)}
                        control={
                            <Switch
                                id="model-cache-enabled"
                                checked={data?.enabled ?? false}
                                disabled={!data}
                                readOnly={save.isPending}
                                onCheckedChange={(enabled) =>
                                    data && save.mutate({ enabled, budget_gb: data.budget_gb })
                                }
                            />
                        }
                    />
                    {data?.enabled && (
                        <NumberSettingRow
                            id="model-cache-budget"
                            label="Budget"
                            description="The most disk base models may use before unused ones are removed."
                            value={data.budget_gb}
                            min={1}
                            max={100_000}
                            step={10}
                            largeStep={100}
                            format={GIGABYTES}
                            unit="GB"
                            pending={save.isPending}
                            error={save.error}
                            onSave={(budget_gb, saved) =>
                                save.mutate({ enabled: true, budget_gb }, { onSuccess: saved })
                            }
                        />
                    )}
                </SettingsGroup>
                <UsageLine />
                <ErrorLine error={settings.error} />
            </div>
        </PanelSection>
    );
}
