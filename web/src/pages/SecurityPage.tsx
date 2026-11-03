import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Box, FolderLock, Globe, History, KeyRound } from "lucide-react";
import {
    Badge,
    Button,
    Checkbox,
    DataGrid,
    Input,
    Label,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    cn,
} from "obp-ui";
import { type FormEvent, useState } from "react";
import { api, unwrap } from "~/api/client";
import type { components } from "~/api/schema";
import { ErrorLine, PanelSection, PanelSections } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import { bytes, exactTime, relativeTime } from "~/lib/time";

type PolicyInfo = components["schemas"]["PolicyInfo"];
type AuditInfo = components["schemas"]["AuditInfo"];

const POLICIES = ["policies"] as const;
const AUDIT = ["audit"] as const;

const GROUPS = [
    {
        icon: Globe,
        title: "Network",
        names: ["network", "allowed_hosts"],
    },
    {
        icon: Box,
        title: "Models",
        names: ["model_sources", "licence_mode", "safetensors_only"],
    },
    {
        icon: FolderLock,
        title: "Data",
        names: ["data_folders"],
    },
    {
        icon: KeyRound,
        title: "Request logs and API keys",
        names: ["request_logs", "log_retention_days", "key_expiry_days"],
    },
];

const SOURCE_LABEL: Record<string, string> = {
    "config file": "Set by config file",
    environment: "Set by environment",
    "built in": "Always on",
};

const LIST_PLACEHOLDERS: Record<string, string> = {
    allowed_hosts: "hf-mirror.internal, s3.internal",
    data_folders: "/srv/exports, /mnt/shared/datasets",
};

function asList(value: unknown): string[] {
    return Array.isArray(value) ? value.map(String) : [];
}

function display(policy: PolicyInfo | undefined, value: unknown): string {
    if (typeof value === "boolean") {
        return value ? "On" : "Off";
    }
    const label = (item: string) =>
        policy?.choices.find((choice) => choice.value === item)?.label ?? item;
    if (Array.isArray(value)) {
        return value.length ? value.map((item) => label(String(item))).join(", ") : "None";
    }
    return label(String(value));
}

function useChange(name: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (value: unknown) =>
            unwrap(
                api.PUT("/api/policies/{name}", { params: { path: { name } }, body: { value } }),
            ),
        onSuccess: async (policies) => {
            client.setQueryData(POLICIES, policies);
            await Promise.all([
                client.invalidateQueries({ queryKey: AUDIT }),
                client.invalidateQueries({ queryKey: ["catalog"] }),
            ]);
        },
    });
}

function TextControl({
    policy,
    onSave,
    pending,
}: {
    policy: PolicyInfo;
    onSave: (value: unknown) => void;
    pending: boolean;
}) {
    const current =
        policy.kind === "list" ? asList(policy.value).join(", ") : String(policy.value ?? "");
    const [draft, setDraft] = useState<string | null>(null);
    const value = draft ?? current;
    const submit = (event: FormEvent) => {
        event.preventDefault();
        onSave(policy.kind === "int" ? Number(value) : value);
        setDraft(null);
    };
    return (
        <form onSubmit={submit} className="flex items-center gap-2">
            <Input
                aria-label={policy.label}
                type={policy.kind === "int" ? "number" : "text"}
                min={policy.kind === "int" ? 0 : undefined}
                value={value}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={LIST_PLACEHOLDERS[policy.name]}
                className={policy.kind === "int" ? "w-24 tabular-nums" : "w-72"}
            />
            {draft !== null && draft !== current && (
                <Button type="submit" size="sm" disabled={pending}>
                    Save
                </Button>
            )}
        </form>
    );
}

function Control({ policy }: { policy: PolicyInfo }) {
    const change = useChange(policy.name);
    const save = (value: unknown) => change.mutate(value);
    if (policy.locked) {
        return (
            <div className="flex flex-wrap items-center justify-end gap-2">
                <span className="text-sm">{display(policy, policy.value)}</span>
                <Badge variant="neutral">{SOURCE_LABEL[policy.source] ?? policy.source}</Badge>
            </div>
        );
    }
    let control = <TextControl policy={policy} onSave={save} pending={change.isPending} />;
    if (policy.kind === "bool") {
        control = (
            <Switch
                aria-label={policy.label}
                checked={policy.value === true}
                disabled={change.isPending}
                onCheckedChange={(checked) => save(checked)}
            />
        );
    } else if (policy.kind === "choice") {
        control = (
            <Select value={String(policy.value)} onValueChange={(next) => save(String(next))}>
                <SelectTrigger aria-label={policy.label} className="w-60">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {policy.choices.map((choice) => (
                        <SelectItem key={choice.value} value={choice.value}>
                            {choice.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        );
    } else if (policy.kind === "list" && policy.choices.length > 0) {
        const chosen = new Set(asList(policy.value));
        const toggle = (item: string, on: boolean) =>
            save(
                policy.choices
                    .map((choice) => choice.value)
                    .filter((value) => (value === item ? on : chosen.has(value))),
            );
        control = (
            <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                {policy.choices.map((choice) => (
                    <Label key={choice.value} className="flex items-center gap-2 font-normal">
                        <Checkbox
                            checked={chosen.has(choice.value)}
                            disabled={change.isPending}
                            onCheckedChange={(checked) => toggle(choice.value, checked === true)}
                        />
                        {choice.label}
                    </Label>
                ))}
            </div>
        );
    }
    return (
        <div className="flex flex-col items-end gap-1">
            {control}
            <ErrorLine error={change.error} />
        </div>
    );
}

function LicenceList({ policy, disabled }: { policy: PolicyInfo; disabled: boolean }) {
    const change = useChange(policy.name);
    const chosen = new Set(asList(policy.value));
    const toggle = (item: string, on: boolean) =>
        change.mutate(
            policy.choices
                .map((choice) => choice.value)
                .filter((value) => (value === item ? on : chosen.has(value))),
        );
    return (
        <div className="flex flex-col gap-1">
            <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {policy.choices.map((choice) => (
                    <Label
                        key={choice.value}
                        className={cn(
                            "flex items-center gap-2 font-normal",
                            disabled && "text-muted-foreground",
                        )}
                    >
                        <Checkbox
                            checked={chosen.has(choice.value)}
                            disabled={disabled || policy.locked || change.isPending}
                            onCheckedChange={(checked) => toggle(choice.value, checked === true)}
                        />
                        {choice.label}
                    </Label>
                ))}
            </div>
            {policy.locked && (
                <Badge variant="neutral" className="w-fit">
                    {SOURCE_LABEL[policy.source] ?? policy.source}
                </Badge>
            )}
            <ErrorLine error={change.error} />
        </div>
    );
}

function LicencesRow({ mode, list }: { mode: PolicyInfo; list: PolicyInfo | undefined }) {
    const change = useChange(mode.name);
    const value = String(mode.value);
    return (
        <div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 max-w-md">
                    <div className="text-sm font-medium">{mode.label}</div>
                    <p className="text-sm text-muted-foreground">{mode.description}</p>
                </div>
                {mode.locked && (
                    <Badge variant="neutral">{SOURCE_LABEL[mode.source] ?? mode.source}</Badge>
                )}
            </div>
            <RadioGroup
                value={value}
                onValueChange={(next) => change.mutate(String(next))}
                disabled={mode.locked || change.isPending}
                className="flex flex-col gap-3"
            >
                <div className="flex flex-col gap-3">
                    <Label className="flex items-center gap-2 font-normal">
                        <RadioGroupItem value="selected" />
                        Only selected licences
                    </Label>
                    {list && (
                        <div className="pl-6">
                            <LicenceList policy={list} disabled={value !== "selected"} />
                        </div>
                    )}
                </div>
                <div className="flex flex-col gap-0.5">
                    <Label className="flex items-center gap-2 font-normal">
                        <RadioGroupItem value="all" />
                        Any licence
                    </Label>
                    <p className="pl-6 text-sm text-muted-foreground">
                        Includes non-commercial and custom terms we have not reviewed. Check each
                        model's licence yourself.
                    </p>
                </div>
            </RadioGroup>
            <ErrorLine error={change.error} />
        </div>
    );
}

function PolicyRow({ policy }: { policy: PolicyInfo }) {
    return (
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0 max-w-md">
                <div className="text-sm font-medium">{policy.label}</div>
                <p className="text-sm text-muted-foreground">{policy.description}</p>
            </div>
            <Control policy={policy} />
        </div>
    );
}

function describe(event: AuditInfo, byName: Map<string, PolicyInfo>): [string, string] {
    const detail = event.detail as Record<string, unknown>;
    if (event.action === "model.delete") {
        const size =
            typeof detail.size_bytes === "number" ? ` · freed ${bytes(detail.size_bytes)}` : "";
        return [`Model ${String(detail.name ?? event.target)}`, `Deleted${size}`];
    }
    const policy = byName.get(event.target);
    const label = policy?.label ?? event.target;
    if (Array.isArray(detail.from) && Array.isArray(detail.to)) {
        const before: unknown[] = detail.from;
        const after: unknown[] = detail.to;
        const added = after.filter((item) => !before.includes(item));
        const removed = before.filter((item) => !after.includes(item));
        const parts = [
            added.length > 0 ? `Added ${display(policy, added)}` : "",
            removed.length > 0 ? `Removed ${display(policy, removed)}` : "",
        ].filter(Boolean);
        return [label, parts.join("; ") || "No change"];
    }
    return [label, `${display(policy, detail.from)} → ${display(policy, detail.to)}`];
}

function auditColumns(byName: Map<string, PolicyInfo>): ColumnDef<AuditInfo, unknown>[] {
    return [
        {
            header: "When",
            id: "at",
            cell: ({ row }) => (
                <span className="tabular-nums" title={exactTime(row.original.at)}>
                    {relativeTime(row.original.at)}
                </span>
            ),
        },
        { header: "Who", accessorKey: "actor" },
        {
            header: "What",
            id: "target",
            cell: ({ row }) => describe(row.original, byName)[0],
        },
        {
            header: "Change",
            id: "change",
            cell: ({ row }) => (
                <span className="whitespace-normal">{describe(row.original, byName)[1]}</span>
            ),
        },
    ];
}

export function SecurityPage() {
    const policies = useQuery({
        queryKey: POLICIES,
        queryFn: () => unwrap(api.GET("/api/policies")),
    });
    const audit = useQuery({
        queryKey: AUDIT,
        queryFn: () => unwrap(api.GET("/api/audit", { params: { query: { limit: 50 } } })),
    });
    const byName = new Map((policies.data ?? []).map((policy) => [policy.name, policy]));
    return (
        <SettingsLayout title="Security">
            <ErrorLine error={policies.error} />
            <PanelSections>
                {policies.data &&
                    GROUPS.map((group) => (
                        <PanelSection key={group.title} icon={group.icon} title={group.title}>
                            <div className="divide-y">
                                {group.names.map((name) => {
                                    const policy = byName.get(name);
                                    if (!policy) {
                                        return null;
                                    }
                                    return name === "licence_mode" ? (
                                        <LicencesRow
                                            key={name}
                                            mode={policy}
                                            list={byName.get("licences")}
                                        />
                                    ) : (
                                        <PolicyRow key={name} policy={policy} />
                                    );
                                })}
                            </div>
                        </PanelSection>
                    ))}
                <PanelSection icon={History} title="Audit log" bare>
                    <ErrorLine error={audit.error} />
                    <DataGrid
                        columns={auditColumns(byName)}
                        rows={audit.data ?? []}
                        empty="No changes yet."
                    />
                </PanelSection>
            </PanelSections>
        </SettingsLayout>
    );
}
