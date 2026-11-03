import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ListChecks, Rows3 } from "lucide-react";
import { Button, Field, Input, Label, Switch } from "obp-ui";
import { type FormEvent, useState } from "react";
import { api, unwrap } from "~/api/client";
import { type DataSettings, dataKeys, useDataSettings } from "~/api/dataQueries";
import { ErrorLine, PanelSection, PanelSections } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import { count } from "~/lib/format";

type NumberKey = "row_limit" | "keep_snapshots" | "min_label_rows";
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

export function NumberSetting({
    id,
    label,
    hint,
    value,
    field,
    min,
}: {
    id: string;
    label: string;
    hint: string;
    value: number | undefined;
    field: NumberKey;
    min: number;
}) {
    const save = useSaveSettings();
    const [draft, setDraft] = useState<string | null>(null);
    const shown = draft ?? (value === undefined ? "" : String(value));
    const submit = (event: FormEvent) => {
        event.preventDefault();
        save.mutate({ [field]: Number(shown) }, { onSuccess: () => setDraft(null) });
    };
    return (
        <form onSubmit={submit} className="flex flex-col gap-1">
            <Field id={id} label={label} hint={hint}>
                <div className="flex items-center gap-2">
                    <Input
                        id={id}
                        type="number"
                        min={min}
                        inputMode="numeric"
                        className="w-40 tabular-nums"
                        value={shown}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    {draft !== null && draft !== String(value) && (
                        <Button type="submit" size="sm" disabled={save.isPending || !draft}>
                            Save
                        </Button>
                    )}
                </div>
            </Field>
            <ErrorLine error={save.error} />
        </form>
    );
}

function CheckSwitches({ data }: { data: DataSettings }) {
    const save = useSaveSettings();
    const off = new Set(data.checks_off ?? []);
    const toggle = (name: CheckName, on: boolean) => {
        const next = new Set(off);
        if (on) {
            next.delete(name);
        } else {
            next.add(name);
        }
        save.mutate({ checks_off: [...next] });
    };
    return (
        <div className="flex flex-col gap-1">
            <ul className="flex flex-col divide-y">
                {CHECKS.map((check) => (
                    <li
                        key={check.name}
                        className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
                    >
                        <Label
                            htmlFor={`check-${check.name}`}
                            className="flex flex-col items-start gap-0.5 font-normal"
                        >
                            <span className="font-medium">{check.label}</span>
                            <span className="text-sm text-muted-foreground">
                                {check.description}
                            </span>
                        </Label>
                        <Switch
                            id={`check-${check.name}`}
                            checked={!off.has(check.name)}
                            disabled={save.isPending}
                            onCheckedChange={(checked) => toggle(check.name, checked)}
                        />
                    </li>
                ))}
            </ul>
            <ErrorLine error={save.error} />
        </div>
    );
}

function MajorityShare({ value }: { value: number | undefined }) {
    const save = useSaveSettings();
    const [draft, setDraft] = useState<string | null>(null);
    const current = value === undefined ? "" : String(Math.round(value * 100));
    const shown = draft ?? current;
    const submit = (event: FormEvent) => {
        event.preventDefault();
        save.mutate({ majority_share: Number(shown) / 100 }, { onSuccess: () => setDraft(null) });
    };
    return (
        <form onSubmit={submit} className="flex flex-col gap-1">
            <Field
                id="majority-share"
                label="Warn when one label holds more than (%)"
                hint="Default 90."
            >
                <div className="flex items-center gap-2">
                    <Input
                        id="majority-share"
                        type="number"
                        min={50}
                        max={100}
                        inputMode="numeric"
                        className="w-40 tabular-nums"
                        value={shown}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    {draft !== null && draft !== current && (
                        <Button type="submit" size="sm" disabled={save.isPending || !draft}>
                            Save
                        </Button>
                    )}
                </div>
            </Field>
            <ErrorLine error={save.error} />
        </form>
    );
}

function ChecksSettings({ data }: { data: DataSettings | undefined }) {
    return (
        <PanelSection
            icon={ListChecks}
            title="Snapshot checks"
            description="Run on every snapshot. Warnings never block training; an empty dataset or a single label always does."
        >
            <div className="flex flex-col gap-6">
                {data && <CheckSwitches data={data} />}
                <div className="flex flex-wrap gap-6 border-t pt-5">
                    <MajorityShare value={data?.majority_share} />
                    <NumberSetting
                        id="min-label-rows"
                        label="Warn when a label has fewer rows than"
                        hint="Default 10."
                        value={data?.min_label_rows}
                        field="min_label_rows"
                        min={1}
                    />
                </div>
            </div>
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
                    <NumberSetting
                        id="row-limit"
                        label="Most rows in one snapshot"
                        hint={`Default ${count(200_000)}.`}
                        value={data?.row_limit}
                        field="row_limit"
                        min={100}
                    />
                </PanelSection>
                <PanelSection
                    icon={Archive}
                    title="Snapshot retention"
                    description="Snapshots a version uses are always kept, and those of deleted versions are removed. This sets how many saved snapshots no version uses stay per dataset."
                >
                    <NumberSetting
                        id="keep-snapshots"
                        label="Keep the last saved snapshots per dataset"
                        hint="Default 5. Older ones are removed with their files."
                        value={data?.keep_snapshots}
                        field="keep_snapshots"
                        min={0}
                    />
                </PanelSection>
                <ChecksSettings data={data} />
            </PanelSections>
        </SettingsLayout>
    );
}
