import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ListChecks, Rows3 } from "lucide-react";
import { SettingsGroup, SettingsRow, Switch } from "obp-ui";
import { type ComponentProps, useState } from "react";
import { api, unwrap } from "~/api/client";
import { type DataSettings, dataKeys, useDataSettings } from "~/api/dataQueries";
import { NumberSettingRow } from "~/components/NumberSettingRow";
import { ErrorLine, PanelSection, PanelSections, errorMessage } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import { count } from "~/lib/format";

type NumberKey = "row_limit" | "keep_snapshots" | "min_label_rows";

const WHOLE: Intl.NumberFormatOptions = { maximumFractionDigits: 0 };
const PERCENT: Intl.NumberFormatOptions = { style: "percent", maximumFractionDigits: 0 };
type CheckName = NonNullable<DataSettings["checks_off"]>[number];

const CHECKS: { name: CheckName; label: string; description: string }[] = [
    {
        name: "duplicates",
        label: "Repeated inputs",
        description: "Rows whose input repeats an earlier one.",
    },
    {
        name: "conflicts",
        label: "Conflicting labels",
        description: "The same input with different labels.",
    },
    {
        name: "balance",
        label: "Label balance",
        description: "One label holding most rows, or labels with very few rows.",
    },
    {
        name: "leakage",
        label: "Train and test overlap",
        description: "Test or held-out inputs that also appear in training.",
    },
    {
        name: "length",
        label: "Empty or long inputs",
        description: "Inputs left empty, or longer than a training example holds (estimated).",
    },
    {
        name: "personal_data",
        label: "Personal data",
        description:
            "Emails, phone numbers, card numbers and IBANs, found by pattern. It can miss names and addresses.",
    },
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

function MajorityShare({ value }: { value: number | undefined }) {
    const save = useSaveSettings();
    return (
        <NumberSettingRow
            id="majority-share"
            label="Warn when one label holds more than"
            description="Default 90%."
            value={value}
            min={0.5}
            max={1}
            step={0.01}
            largeStep={0.1}
            format={PERCENT}
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
            title="Snapshot checks"
            description="Run on every snapshot. Warnings never block training; an empty dataset or a single label always does."
        >
            <SettingsGroup>
                {CHECKS.map((check) => (
                    <SettingsRow
                        key={check.name}
                        id={`check-${check.name}`}
                        toggle
                        label={check.label}
                        description={check.description}
                        error={changed === check.name ? errorMessage(save.error) : undefined}
                        control={
                            <Switch
                                id={`check-${check.name}`}
                                checked={!off.has(check.name)}
                                disabled={!data}
                                readOnly={save.isPending}
                                onCheckedChange={(checked) => toggle(check.name, checked)}
                            />
                        }
                    />
                ))}
                <MajorityShare value={data?.majority_share} />
                <NumberSetting
                    id="min-label-rows"
                    label="Warn when a label has fewer rows than"
                    description="Default 10."
                    value={data?.min_label_rows}
                    field="min_label_rows"
                    min={1}
                    max={100_000}
                    unit="rows"
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
                    title="Snapshot size"
                    description="Training copies a dataset's rows into a snapshot. Larger datasets are refused with a hint to filter or sample in the query."
                >
                    <SettingsGroup>
                        <NumberSetting
                            id="row-limit"
                            label="Most rows in one snapshot"
                            description={`Default ${count(200_000)}.`}
                            value={data?.row_limit}
                            field="row_limit"
                            min={100}
                            max={50_000_000}
                            step={1000}
                            largeStep={10_000}
                            unit="rows"
                            groupClassName="w-36"
                        />
                    </SettingsGroup>
                </PanelSection>
                <PanelSection
                    icon={Archive}
                    title="Snapshot retention"
                    description="Snapshots a version uses are always kept, and those of deleted versions are removed. This sets how many saved snapshots no version uses stay per dataset."
                >
                    <SettingsGroup>
                        <NumberSetting
                            id="keep-snapshots"
                            label="Keep the last saved snapshots per dataset"
                            description="Default 5. Older ones are removed with their files."
                            value={data?.keep_snapshots}
                            field="keep_snapshots"
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
