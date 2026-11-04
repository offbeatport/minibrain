import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import {
    Badge,
    Button,
    ConfirmDialog,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    SettingsGroup,
    SettingsRow,
    Switch,
} from "obp-ui";
import { type FormEvent, useEffect, useState } from "react";
import { api, unwrap } from "~/api/client";
import type { components } from "~/api/schema";
import { ErrorLine, PanelSection } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { exactTime, relativeTime } from "~/lib/time";

type EncryptionStatus = components["schemas"]["EncryptionStatus"];
type EncryptionField = components["schemas"]["EncryptionField"];
type EncryptionCounts = components["schemas"]["EncryptionCounts"];
type Draft = Record<string, unknown>;

const ENCRYPTION = ["settings", "encryption"] as const;
const AUDIT = ["audit"] as const;
const POLL_MS = 2000;
const PROVIDER = "encryption";
const PREFIXES: Record<string, string> = { vault: "vault_", hsm: "hsm_", kms: "kms_" };
const PLACEHOLDERS: Record<string, string> = {
    vault_address: "https://vault.internal:8200",
    vault_ca_bundle: "/etc/minibrain/vault-ca.pem",
    hsm_library: "/usr/lib/softhsm/libsofthsm2.so",
    hsm_token: "minibrain",
    kms_key: "arn:aws:kms:us-east-1:111122223333:key/…",
    kms_region: "us-east-1",
    kms_endpoint: "https://vpce-….kms.us-east-1.vpce.amazonaws.com",
};
const TASKS: Record<string, string> = {
    encrypt: "Encrypting existing files",
    rotate: "Rotating the master key",
    check: "Checking every file",
};
const LOCK_LABEL: Record<string, string> = {
    "config file": "Set by config file",
    environment: "Set by environment",
};

function active(status: EncryptionStatus | undefined): boolean {
    const state = status?.task?.state;
    return state === "queued" || state === "running";
}

function useEncryption() {
    return useQuery({
        queryKey: ENCRYPTION,
        queryFn: () => unwrap(api.GET("/api/settings/encryption")),
        refetchInterval: (query) => (active(query.state.data) ? POLL_MS : false),
    });
}

function shown(fields: EncryptionField[], provider: string): EncryptionField[] {
    const prefix = PREFIXES[provider];
    return fields.filter(
        (field) => field.name === PROVIDER || (prefix && field.name.startsWith(prefix)),
    );
}

function draftOf(fields: EncryptionField[]): Draft {
    return Object.fromEntries(fields.map((field) => [field.name, field.value]));
}

function changes(fields: EncryptionField[], draft: Draft, provider: string): Draft {
    return Object.fromEntries(
        shown(fields, provider)
            .filter((field) => !field.locked && draft[field.name] !== field.value)
            .map((field) => [field.name, draft[field.name]]),
    );
}

function display(field: EncryptionField): string {
    if (typeof field.value === "boolean") {
        return field.value ? "On" : "Off";
    }
    const label = field.choices.find((choice) => choice.value === field.value)?.label;
    return label ?? (String(field.value ?? "") || "Not set");
}

function FieldRow({
    field,
    value,
    onChange,
}: {
    field: EncryptionField;
    value: unknown;
    onChange: (value: unknown) => void;
}) {
    const id = `encryption-${field.name.replaceAll("_", "-")}`;
    if (field.locked) {
        return (
            <SettingsRow
                label={field.label}
                description={field.description}
                disabled
                control={
                    <>
                        <span className="text-sm">{display(field)}</span>
                        <Badge variant="neutral" className="w-fit">
                            {LOCK_LABEL[field.source] ?? field.source}
                        </Badge>
                    </>
                }
            />
        );
    }
    if (field.kind === "bool") {
        return (
            <SettingsRow
                id={id}
                toggle
                label={field.label}
                description={field.description}
                control={
                    <Switch
                        id={id}
                        checked={value === true}
                        onCheckedChange={(on) => onChange(on === true)}
                    />
                }
            />
        );
    }
    if (field.kind === "choice") {
        return (
            <SettingsRow
                id={id}
                label={field.label}
                description={field.description}
                control={
                    <Select value={String(value)} onValueChange={(next) => onChange(String(next))}>
                        <SelectTrigger
                            id={id}
                            aria-describedby={`${id}-description`}
                            className="w-60"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {field.choices.map((choice) => (
                                <SelectItem key={choice.value} value={choice.value}>
                                    {choice.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                }
            />
        );
    }
    return (
        <SettingsRow
            id={id}
            wide
            label={field.label}
            description={field.description}
            control={
                <Input
                    id={id}
                    value={String(value ?? "")}
                    placeholder={PLACEHOLDERS[field.name]}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    aria-describedby={`${id}-description`}
                    onChange={(event) => onChange(event.target.value)}
                />
            }
        />
    );
}

function ProviderForm({ status }: { status: EncryptionStatus }) {
    const client = useQueryClient();
    const [draft, setDraft] = useState<Draft>(() => draftOf(status.fields));
    useEffect(() => setDraft(draftOf(status.fields)), [status.fields]);
    const provider = String(draft[PROVIDER] ?? status.provider);
    const pending = changes(status.fields, draft, provider);
    const dirty = Object.keys(pending).length > 0;
    const test = useMutation({
        mutationFn: () =>
            unwrap(api.POST("/api/settings/encryption/test", { body: { values: pending } })),
    });
    const save = useMutation({
        mutationFn: () =>
            unwrap(api.PUT("/api/settings/encryption", { body: { values: pending } })),
        onSuccess: async (saved) => {
            client.setQueryData(ENCRYPTION, saved);
            test.reset();
            await client.invalidateQueries({ queryKey: AUDIT });
        },
    });
    const submit = (event: FormEvent) => {
        event.preventDefault();
        save.mutate();
    };
    return (
        <form onSubmit={submit} className="flex flex-col gap-field">
            <SettingsGroup>
                {shown(status.fields, provider).map((field) => (
                    <FieldRow
                        key={field.name}
                        field={field}
                        value={draft[field.name]}
                        onChange={(value) =>
                            setDraft((current) => ({ ...current, [field.name]: value }))
                        }
                    />
                ))}
            </SettingsGroup>
            {dirty && (
                <div className="flex flex-wrap items-center gap-2">
                    {provider !== "off" && (
                        <Button
                            type="button"
                            variant="outline"
                            disabled={test.isPending}
                            onClick={() => test.mutate()}
                        >
                            {test.isPending ? "Testing…" : "Test key"}
                        </Button>
                    )}
                    <Button type="submit" disabled={save.isPending}>
                        {save.isPending ? "Saving…" : "Save"}
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setDraft(draftOf(status.fields))}
                    >
                        Cancel
                    </Button>
                </div>
            )}
            {test.data && (
                <p className="text-sm">
                    <StatusText tone={test.data.ok ? "success" : "destructive"}>
                        {test.data.ok ? "Key works" : "Key failed"}
                    </StatusText>
                    <span className="ml-2 text-muted-foreground">{test.data.message}</span>
                </p>
            )}
            <ErrorLine error={test.error ?? save.error} />
        </form>
    );
}

function countsText(counts: EncryptionCounts): string {
    const parts = [
        `${counts.current} under the current key`,
        `${counts.older} under older keys`,
        `${counts.plain} not encrypted`,
    ];
    if (counts.damaged) {
        parts.push(`${counts.damaged} unreadable`);
    }
    return `${counts.files} files: ${parts.join(", ")}. ${counts.secrets} secrets, ${counts.secrets_older} under older keys.`;
}

function CurrentKey({ status }: { status: EncryptionStatus }) {
    if (status.provider === "off") {
        return (
            <p className="text-sm">
                <StatusText tone="warning">Off</StatusText>
                <span className="ml-2 text-muted-foreground">
                    New files are written unencrypted.
                </span>
            </p>
        );
    }
    if (status.problem) {
        return (
            <p className="text-sm">
                <StatusText tone="destructive">{status.provider_label} unavailable</StatusText>
                <span className="ml-2 text-muted-foreground">{status.problem}</span>
            </p>
        );
    }
    return (
        <p className="flex flex-wrap items-center gap-x-2 text-sm">
            <StatusText tone="success">{status.provider_label}</StatusText>
            <span className="font-mono break-all">{status.key}</span>
            <span className="text-muted-foreground break-all">{status.where}</span>
        </p>
    );
}

function Files({ status }: { status: EncryptionStatus }) {
    const client = useQueryClient();
    const start = useMutation({
        mutationFn: (kind: string) =>
            unwrap(api.POST("/api/settings/encryption/tasks", { body: { kind } })),
        onSuccess: async (saved) => {
            client.setQueryData(ENCRYPTION, saved);
            await client.invalidateQueries({ queryKey: AUDIT });
        },
    });
    const task = status.task;
    const running = active(status);
    const last = status.last;
    const sealing = status.provider !== "off";
    return (
        <div className="flex flex-col gap-2">
            {running && task ? (
                <p className="text-sm">
                    <StatusText tone="info">{TASKS[task.kind] ?? task.kind}</StatusText>
                    {task.progress && (
                        <span className="ml-2 text-muted-foreground tabular-nums">
                            {task.progress.files} files seen, {task.progress.encrypted} encrypted,{" "}
                            {task.progress.rewrapped} re-wrapped
                        </span>
                    )}
                </p>
            ) : last ? (
                <p className="text-sm tabular-nums">
                    {countsText(last.counts)}
                    {last.finished_at && (
                        <span
                            className="ml-1 text-muted-foreground"
                            title={exactTime(last.finished_at)}
                        >
                            Checked {relativeTime(last.finished_at)}.
                        </span>
                    )}
                </p>
            ) : (
                <p className="text-sm text-muted-foreground">No files have been checked yet.</p>
            )}
            {task?.state === "failed" && !running && (
                <p className="text-sm text-destructive">
                    {task.error ??
                        `${last?.counts.damaged ?? 0} files could not be read or changed.`}
                </p>
            )}
            {(last?.counts.problems?.length ?? 0) > 0 && (
                <ul className="list-inside list-disc text-sm text-muted-foreground">
                    {(last?.counts.problems ?? []).map((problem) => (
                        <li key={problem} className="font-mono break-all">
                            {problem}
                        </li>
                    ))}
                </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    variant="outline"
                    disabled={running || start.isPending}
                    onClick={() => start.mutate("check")}
                >
                    Check now
                </Button>
                {sealing && (
                    <Button
                        variant="outline"
                        disabled={running || start.isPending}
                        onClick={() => start.mutate("encrypt")}
                    >
                        Encrypt existing files
                    </Button>
                )}
                {sealing && (
                    <ConfirmDialog
                        trigger={
                            <Button variant="outline" disabled={running || start.isPending}>
                                Rotate master key
                            </Button>
                        }
                        title="Rotate the master key?"
                        description="minibrain makes a new master key version and re-wraps every file's data key under it. File contents are not re-encrypted. Older versions stay readable for an hour, then go once no file uses them."
                        confirmLabel="Rotate"
                        onConfirm={() => start.mutateAsync("rotate").catch(() => undefined)}
                    />
                )}
            </div>
            <ErrorLine error={start.error} />
        </div>
    );
}

function Keys({ status }: { status: EncryptionStatus }) {
    if (status.keys.length === 0) {
        return null;
    }
    return (
        <ul className="divide-y border-y text-sm">
            {status.keys.map((key) => (
                <li
                    key={`${key.provider}:${key.key}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
                >
                    <span className="flex min-w-0 items-baseline gap-2">
                        <span className="font-mono break-all">
                            {key.provider}:{key.key}
                        </span>
                        {key.current && <Badge variant="success">Current</Badge>}
                        {key.retired_at && <Badge variant="neutral">Retired</Badge>}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                        {key.files !== null && key.files !== undefined && `${key.files} files · `}
                        {key.created_at && (
                            <span title={exactTime(key.created_at)}>
                                made {relativeTime(key.created_at)}
                            </span>
                        )}
                    </span>
                </li>
            ))}
        </ul>
    );
}

export function EncryptionSettings() {
    const status = useEncryption();
    return (
        <PanelSection
            icon={Lock}
            title="Encryption at rest"
            description="Each stored file has its own data key; the master key here wraps it. Uploads, dataset versions, adapters, logs and staging copies are encrypted."
        >
            <ErrorLine error={status.error} />
            {status.data && (
                <div className="flex flex-col gap-field">
                    <CurrentKey status={status.data} />
                    <ProviderForm status={status.data} />
                    <Files status={status.data} />
                    <Keys status={status.data} />
                </div>
            )}
        </PanelSection>
    );
}
