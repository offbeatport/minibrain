import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ListChecks, Rows3 } from "lucide-react";
import { SettingsGroup, SettingsRow, Switch } from "obp-ui";
import { type ComponentProps, useState } from "react";
import { api, unwrap } from "~/api/client";
import { type DataSettings, dataKeys, useDataSettings } from "~/api/dataQueries";
import { NumberSettingRow } from "~/components/NumberSettingRow";
import { ErrorLine, PanelSection, PanelSections, errorMessage } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import { SourceBadge } from "~/components/SourceBadge";
import { count } from "~/lib/format";
import { DATA, type Setting } from "~/pages/settings/settingsIndex";

type NumberKey = "row_limit" | "keep_snapshots" | "min_label_rows";

const WHOLE: Intl.NumberFormatOptions = { maximumFractionDigits: 0 };
const PERCENT: Intl.NumberFormatOptions = { style: "percent", maximumFractionDigits: 0 };
type CheckName = NonNullable<DataSettings["checks_off"]>[number];

const TEXT = DATA.checks.settings;

const CHECKS: { name: CheckName; text: Setting }[] = [
    { name: "duplicates", text: TEXT.duplicates },
    { name: "conflicts", text: TEXT.conflicts },
    { name: "balance", text: TEXT.balance },
    { name: "leakage", text: TEXT.leakage },
    { name: "length", text: TEXT.length },
    { name: "personal_data", text: TEXT.personalData },
];

function useSaveSettings() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (body: Partial<DataSettings>) =>
            unwrap(api.PUT("/api/settings/data", { body })),
        onSuccess: async (saved) => {
            client.setQueryData(dataKeys.settings, saved);
            await Promise.all([
                client.invalidateQueries({ queryKey: ["datasets"] }),
                client.invalidateQueries({ queryKey: ["infrastructure"] }),
            ]);
        },
    });
}

function NumberSetting({
    id,
    field,
    value,
    ...props
}: Omit<
    ComponentProps<typeof NumberSettingRow>,
    "pending" | "error" | "onSave" | "value" | "format"
> & {
    field: NumberKey;
    value: number | undefined;
}) {
    const save = useSaveSettings();
    return (
        <NumberSettingRow
            id={id}
            value={value}
            format={WHOLE}
            pending={save.isPending}
            error={save.error}
            onSave={(next, saved) => save.mutate({ [field]: next }, { onSuccess: saved })}
            {...props}
        />
    );
}

function MajorityShare({ value, locked }: { value: number | undefined; locked?: string }) {
    const save = useSaveSettings();
    return (
        <NumberSettingRow
            id="majority-share-field"
            anchor={TEXT.majorityShare.anchor}
            label={TEXT.majorityShare.label}
            description={TEXT.majorityShare.description}
            value={value}
            min={0.5}
            max={1}
            step={0.01}
            largeStep={0.1}
            format={PERCENT}
            locked={locked}
            pending={save.isPending}
            error={save.error}
            onSave={(next, saved) => save.mutate({ majority_share: next }, { onSuccess: saved })}
        />
    );
}

function ChecksSettings({ data }: { data: DataSettings | undefined }) {
    const save = useSaveSettings();
    const [changed, setChanged] = useState<CheckName | null>(null);
    const off = new Set(data?.checks_off ?? []);
    const locked = data?.locked?.checks_off;
    const toggle = (name: CheckName, on: boolean) => {
        setChanged(name);
        const next = new Set(off);
        if (on) {
            next.delete(name);
        } else {
            next.add(name);
        }
        save.mutate({ checks_off: [...next] });
    };
    return (
        <PanelSection
            icon={ListChecks}
            anchor={DATA.checks.anchor}
            title={DATA.checks.title}
            description="Run on every dataset version. Warnings never block training; an empty dataset or a single label stops the version from being saved."
        >
            <SettingsGroup>
                {CHECKS.map((check) => (
                    <SettingsRow
                        key={check.name}
                        id={`check-${check.name}`}
                        anchor={check.text.anchor}
                        toggle
                        disabled={Boolean(locked)}
                        label={check.text.label}
                        description={check.text.description}
                        error={changed === check.name ? errorMessage(save.error) : undefined}
                        control={
                            <>
                                <Switch
                                    id={`check-${check.name}`}
                                    checked={!off.has(check.name)}
                                    disabled={!data || Boolean(locked)}
                                    readOnly={save.isPending}
                                    onCheckedChange={(checked) => toggle(check.name, checked)}
                                />
                                {locked && <SourceBadge source={locked} />}
                            </>
                        }
                    />
                ))}
                <MajorityShare value={data?.majority_share} locked={data?.locked?.majority_share} />
                <NumberSetting
                    id="min-label-rows-field"
                    anchor={TEXT.minLabelRows.anchor}
                    label={TEXT.minLabelRows.label}
                    description={TEXT.minLabelRows.description}
                    value={data?.min_label_rows}
                    field="min_label_rows"
                    locked={data?.locked?.min_label_rows}
                    min={1}
                    max={100_000}
                />
            </SettingsGroup>
        </PanelSection>
    );
}

export function DataSettingsPage() {
    const settings = useDataSettings();
    const data = settings.data;
    return (
        <SettingsLayout title="Data">
            <ErrorLine error={settings.error} />
            <PanelSections>
                <PanelSection
                    icon={Rows3}
                    anchor={DATA.versionSize.anchor}
                    title={DATA.versionSize.title}
                    description="Each dataset version copies the query's rows. A larger result is refused with a hint to filter or sample in the query."
                >
                    <SettingsGroup>
                        <NumberSetting
                            id="row-limit-field"
                            anchor={DATA.versionSize.settings.rowLimit.anchor}
                            label={DATA.versionSize.settings.rowLimit.label}
                            description={`Default ${count(200_000)}.`}
                            value={data?.row_limit}
                            field="row_limit"
                            locked={data?.locked?.row_limit}
                            min={100}
                            max={50_000_000}
                            step={1000}
                            largeStep={10_000}
                            groupClassName="w-36"
                        />
                    </SettingsGroup>
                </PanelSection>
                <PanelSection
                    icon={Archive}
                    anchor={DATA.versionRetention.anchor}
                    title={DATA.versionRetention.title}
                    description="Dataset versions a model version uses are always kept, and so is each dataset's latest. This sets how many versions no model uses stay per dataset."
                >
                    <SettingsGroup>
                        <NumberSetting
                            id="keep-snapshots-field"
                            anchor={DATA.versionRetention.settings.keepSnapshots.anchor}
                            label={DATA.versionRetention.settings.keepSnapshots.label}
                            description={`Default 5. ${DATA.versionRetention.settings.keepSnapshots.description}`}
                            value={data?.keep_snapshots}
                            field="keep_snapshots"
                            locked={data?.locked?.keep_snapshots}
                            min={0}
                            max={1000}
                        />
                    </SettingsGroup>
                </PanelSection>
                <ChecksSettings data={data} />
            </PanelSections>
        </SettingsLayout>
    );
}
