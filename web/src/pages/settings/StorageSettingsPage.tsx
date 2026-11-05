import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import {
    Button,
    Input,
    Label,
    Link,
    RadioGroup,
    RadioGroupItem,
    SettingsGroup,
    SettingsRow,
} from "obp-ui";
import { type FormEvent, useEffect, useState } from "react";
import { api, unwrap } from "~/api/client";
import type { components } from "~/api/schema";
import { ErrorLine, PanelSection, PanelSections } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import { StatusText } from "~/components/models/StatusText";
import { STORAGE, type Setting } from "~/pages/settings/settingsIndex";

type StorageSettings = components["schemas"]["StorageSettings"];
type StorageUpdate = components["schemas"]["StorageUpdate"];

const STORAGE_KEY = ["settings", "storage"] as const;
const TEXT = STORAGE.location.settings;

type Draft = {
    kind: StorageUpdate["kind"];
    endpoint: string;
    bucket: string;
    prefix: string;
    region: string;
    access_key: string;
    secret: string;
};

function draftOf(settings: StorageSettings): Draft {
    return {
        kind: settings.kind,
        endpoint: settings.endpoint,
        bucket: settings.bucket,
        prefix: settings.prefix,
        region: settings.region,
        access_key: settings.access_key,
        secret: "",
    };
}

function bodyOf(draft: Draft): StorageUpdate {
    return { ...draft, secret: draft.secret || null };
}

function TextField({
    id,
    text,
    hint,
    value,
    placeholder,
    mono,
    type = "text",
    onChange,
}: {
    id: string;
    text: Setting;
    hint?: string;
    value: string;
    placeholder?: string;
    mono?: boolean;
    type?: string;
    onChange: (value: string) => void;
}) {
    return (
        <SettingsRow
            id={id}
            anchor={text.anchor}
            wide
            label={text.label}
            description={hint}
            control={
                <Input
                    id={id}
                    type={type}
                    value={value}
                    placeholder={placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    className={mono ? "font-mono" : undefined}
                    onChange={(event) => onChange(event.target.value)}
                />
            }
        />
    );
}

function StorageForm({ settings }: { settings: StorageSettings }) {
    const client = useQueryClient();
    const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
    useEffect(() => setDraft(draftOf(settings)), [settings]);
    const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
    const test = useMutation({
        mutationFn: () => unwrap(api.POST("/api/settings/storage/test", { body: bodyOf(draft) })),
    });
    const save = useMutation({
        mutationFn: () => unwrap(api.PUT("/api/settings/storage", { body: bodyOf(draft) })),
        onSuccess: async (saved) => {
            client.setQueryData(STORAGE_KEY, saved);
            test.reset();
            await client.invalidateQueries({ queryKey: ["infrastructure"] });
        },
    });
    const submit = (event: FormEvent) => {
        event.preventDefault();
        save.mutate();
    };
    const s3 = draft.kind === "s3";
    return (
        <form onSubmit={submit} className="flex flex-col gap-field">
            <RadioGroup
                value={draft.kind}
                onValueChange={(next) => set({ kind: next === "s3" ? "s3" : "local" })}
                className="flex flex-col gap-3"
            >
                <Label className="flex items-start gap-2 font-normal">
                    <RadioGroupItem value="local" className="mt-0.5" />
                    <span className="flex flex-col">
                        <span>Local folder</span>
                        <span className="text-sm text-muted-foreground">
                            Under this install's home folder, on this server's disk.
                        </span>
                    </span>
                </Label>
                <Label className="flex items-start gap-2 font-normal">
                    <RadioGroupItem value="s3" className="mt-0.5" />
                    <span className="flex flex-col">
                        <span>S3-compatible bucket</span>
                        <span className="text-sm text-muted-foreground">
                            AWS S3, MinIO, Ceph or any store that speaks the S3 API.
                        </span>
                    </span>
                </Label>
            </RadioGroup>
            {s3 && (
                <SettingsGroup className="mt-0 border-t">
                    <TextField
                        id="s3-endpoint"
                        text={TEXT.endpoint}
                        hint={TEXT.endpoint.description}
                        value={draft.endpoint}
                        placeholder="https://minio.internal:9000"
                        mono
                        onChange={(endpoint) => set({ endpoint })}
                    />
                    <TextField
                        id="s3-bucket"
                        text={TEXT.bucket}
                        value={draft.bucket}
                        placeholder="ml-artifacts"
                        mono
                        onChange={(bucket) => set({ bucket })}
                    />
                    <TextField
                        id="s3-prefix"
                        text={TEXT.prefix}
                        hint={TEXT.prefix.description}
                        value={draft.prefix}
                        mono
                        onChange={(prefix) => set({ prefix })}
                    />
                    <TextField
                        id="s3-region"
                        text={TEXT.region}
                        hint={TEXT.region.description}
                        value={draft.region}
                        placeholder="us-east-1"
                        mono
                        onChange={(region) => set({ region })}
                    />
                    <TextField
                        id="s3-access-key"
                        text={TEXT.accessKey}
                        value={draft.access_key}
                        mono
                        onChange={(access_key) => set({ access_key })}
                    />
                    <TextField
                        id="s3-secret"
                        text={TEXT.secret}
                        type="password"
                        hint={
                            settings.secret_from_environment
                                ? "Set by the MINIBRAIN_STORAGE_S3_SECRET environment variable."
                                : TEXT.secret.description
                        }
                        value={draft.secret}
                        placeholder={settings.secret_set ? "Saved; leave empty to keep it" : ""}
                        onChange={(secret) => set({ secret })}
                    />
                </SettingsGroup>
            )}
            <div className="flex flex-wrap items-center gap-2">
                {s3 && (
                    <Button
                        type="button"
                        variant="outline"
                        disabled={test.isPending}
                        onClick={() => test.mutate()}
                    >
                        {test.isPending ? "Testing…" : "Test connection"}
                    </Button>
                )}
                <Button type="submit" disabled={save.isPending}>
                    {save.isPending ? "Saving…" : "Save"}
                </Button>
            </div>
            {test.data && (
                <p className="text-sm">
                    <StatusText tone={test.data.ok ? "success" : "destructive"}>
                        {test.data.ok ? "Connected" : "Could not connect"}
                    </StatusText>
                    <span className="ml-2 text-muted-foreground">{test.data.message}</span>
                </p>
            )}
            <ErrorLine error={test.error ?? save.error} />
        </form>
    );
}

export function StorageSettingsPage() {
    const settings = useQuery({
        queryKey: STORAGE_KEY,
        queryFn: () => unwrap(api.GET("/api/settings/storage")),
    });
    return (
        <SettingsLayout title="Storage">
            <ErrorLine error={settings.error} />
            <PanelSections>
                <PanelSection
                    icon={HardDrive}
                    anchor={STORAGE.location.anchor}
                    title={STORAGE.location.title}
                    description="Uploads, dataset versions, adapters and logs. New ones go to the place chosen here; ones already stored stay readable where they are."
                >
                    {settings.data && (
                        <div className="flex flex-col gap-field">
                            <p className="text-sm">
                                <span className="text-muted-foreground">Now: </span>
                                <span className="font-mono break-all">
                                    {settings.data.location}
                                </span>
                            </p>
                            <StorageForm settings={settings.data} />
                            <p className="text-sm text-muted-foreground">
                                {"Usage per kind is under "}
                                <Link
                                    href="/infrastructure/storage"
                                    className="text-primary hover:underline"
                                >
                                    Infrastructure, Storage
                                </Link>
                                .
                            </p>
                        </div>
                    )}
                </PanelSection>
            </PanelSections>
        </SettingsLayout>
    );
}
