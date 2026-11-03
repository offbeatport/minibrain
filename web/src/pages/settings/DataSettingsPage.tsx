import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, Rows3 } from "lucide-react";
import { Button, Field, Input } from "obp-ui";
import { type FormEvent, useState } from "react";
import { api, unwrap } from "~/api/client";
import { type DataSettings, dataKeys, useDataSettings } from "~/api/dataQueries";
import { ErrorLine, PanelSection, PanelSections } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import { count } from "~/lib/format";

type NumberKey = "row_limit" | "keep_snapshots";

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
            </PanelSections>
        </SettingsLayout>
    );
}
