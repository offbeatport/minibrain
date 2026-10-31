import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
    Badge,
    Button,
    Checkbox,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
} from "obp-ui";
import { type FormEvent, useState } from "react";
import { api, unwrap } from "~/api/client";
import type { components } from "~/api/schema";
import { DataTable } from "~/components/DataTable";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, Section } from "~/components/Section";
import { SettingsTabs } from "~/components/SettingsTabs";
import { exactTime, relativeTime } from "~/lib/time";

type PolicyInfo = components["schemas"]["PolicyInfo"];
type AuditInfo = components["schemas"]["AuditInfo"];

const POLICIES = ["policies"] as const;
const AUDIT = ["audit"] as const;

const GROUPS = [
    {
        title: "Network",
        caption:
            "Downloads, imports from buckets, catalogue sync and Add from Hugging Face all obey this.",
        names: ["network", "allowed_hosts"],
    },
    {
        title: "Models",
        caption: "Checked when a model is added or downloaded, and again on retry.",
        names: ["model_sources", "licences", "allow_unreviewed_licences", "safetensors_only"],
    },
    {
        title: "Request logs and API keys",
        caption: "Logs never leave this install. Expiry applies to keys created after the change.",
        names: ["request_logs", "log_retention_days", "key_expiry_days"],
    },
];

const SOURCE_LABEL: Record<string, string> = {
    "config file": "Set by config file",
    environment: "Set by environment",
    "built in": "Always on",
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
                placeholder={policy.kind === "list" ? "hf-mirror.internal, s3.internal" : undefined}
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
            header: "Setting",
            id: "target",
            cell: ({ row }) => byName.get(row.original.target)?.label ?? row.original.target,
        },
        {
            header: "Change",
            id: "change",
            cell: ({ row }) => {
                const policy = byName.get(row.original.target);
                return (
                    <span className="whitespace-normal">
                        {`${display(policy, row.original.detail.from)} → ${display(policy, row.original.detail.to)}`}
                    </span>
                );
            },
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
        <Page>
            <PageHeader
                title="Settings"
                caption="Values from minibrain.yaml or MINIBRAIN_POLICY_* variables are locked here. Every change is recorded."
            />
            <SettingsTabs active="/settings/security" />
            <ErrorLine error={policies.error} />
            {policies.data &&
                GROUPS.map((group) => (
                    <Section key={group.title} title={group.title} caption={group.caption}>
                        <div className="divide-y">
                            {group.names.map((name) => {
                                const policy = byName.get(name);
                                return policy ? <PolicyRow key={name} policy={policy} /> : null;
                            })}
                        </div>
                    </Section>
                ))}
            <Section title="Recent changes">
                <ErrorLine error={audit.error} />
                <DataTable
                    columns={auditColumns(byName)}
                    rows={audit.data ?? []}
                    empty="No changes yet."
                />
            </Section>
        </Page>
    );
}
