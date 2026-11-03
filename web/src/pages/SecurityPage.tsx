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
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    SettingsGroup,
    SettingsRow,
    Switch,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { type FormEvent, useState } from "react";
import { api, unwrap } from "~/api/client";
import type { components } from "~/api/schema";
import { NumberSettingRow } from "~/components/NumberSettingRow";
import { ErrorLine, PanelSection, PanelSections, errorMessage } from "~/components/Section";
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

const SOURCE_DETAIL: Record<string, string> = {
    "config file": "Set in the server's minibrain.yaml, so it can only be changed there.",
    environment: "Set by an environment variable on the server, so it can only be changed there.",
};

function LockedBadge({ policy }: { policy: PolicyInfo }) {
    const badge = (
        <Badge variant="neutral" className="w-fit">
            {SOURCE_LABEL[policy.source] ?? policy.source}
        </Badge>
    );
    const detail = SOURCE_DETAIL[policy.source];
    if (!detail) {
        return badge;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="w-fit rounded-sm">
                    {badge}
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{detail}</TooltipContent>
        </Tooltip>
    );
}

const WHOLE: Intl.NumberFormatOptions = { maximumFractionDigits: 0 };

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

function policyId(policy: PolicyInfo): string {
    return `policy-${policy.name.replaceAll("_", "-")}`;
}

function TextRow({ policy }: { policy: PolicyInfo }) {
    const change = useChange(policy.name);
    const id = policyId(policy);
    const current =
        policy.kind === "list" ? asList(policy.value).join(", ") : String(policy.value ?? "");
    const [draft, setDraft] = useState<string | null>(null);
    const value = draft ?? current;
    const submit = (event: FormEvent) => {
        event.preventDefault();
        change.mutate(value, { onSuccess: () => setDraft(null) });
    };
    return (
        <form onSubmit={submit}>
            <SettingsRow
                id={id}
                wide
                label={policy.label}
                description={policy.description}
                error={errorMessage(change.error)}
                control={
                    <>
                        <Input
                            id={id}
                            value={value}
                            aria-describedby={`${id}-description`}
                            onChange={(event) => setDraft(event.target.value)}
                            placeholder={LIST_PLACEHOLDERS[policy.name]}
                        />
                        {draft !== null && draft !== current && (
                            <Button type="submit" disabled={change.isPending}>
                                Save
                            </Button>
                        )}
                    </>
                }
            />
        </form>
    );
}

function NumberRow({ policy }: { policy: PolicyInfo }) {
    const change = useChange(policy.name);
    return (
        <NumberSettingRow
            id={policyId(policy)}
            label={policy.label}
            description={policy.description}
            value={typeof policy.value === "number" ? policy.value : undefined}
            min={0}
            format={WHOLE}
            pending={change.isPending}
            error={change.error}
            onSave={(next, saved) => change.mutate(next, { onSuccess: saved })}
        />
    );
}

function SwitchRow({ policy }: { policy: PolicyInfo }) {
    const change = useChange(policy.name);
    const id = policyId(policy);
    return (
        <SettingsRow
            id={id}
            toggle
            label={policy.label}
            description={policy.description}
            error={errorMessage(change.error)}
            control={
                <Switch
                    id={id}
                    checked={policy.value === true}
                    readOnly={change.isPending}
                    onCheckedChange={(checked) => change.mutate(checked)}
                />
            }
        />
    );
}

function ChoiceRow({ policy }: { policy: PolicyInfo }) {
    const change = useChange(policy.name);
    const id = policyId(policy);
    return (
        <SettingsRow
            id={id}
            label={policy.label}
            description={policy.description}
            error={errorMessage(change.error)}
            control={
                <Select
                    value={String(policy.value)}
                    onValueChange={(next) => change.mutate(String(next))}
                >
                    <SelectTrigger id={id} aria-describedby={`${id}-description`} className="w-60">
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
            }
        />
    );
}

function ChoiceListRow({ policy }: { policy: PolicyInfo }) {
    const change = useChange(policy.name);
    const chosen = new Set(asList(policy.value));
    const toggle = (item: string, on: boolean) =>
        change.mutate(
            policy.choices
                .map((choice) => choice.value)
                .filter((value) => (value === item ? on : chosen.has(value))),
        );
    return (
        <SettingsRow
            label={policy.label}
            description={policy.description}
            error={errorMessage(change.error)}
            control={null}
        >
            <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 pb-2.5 sm:grid-cols-2">
                {policy.choices.map((choice) => (
                    <Label key={choice.value} className="flex items-center gap-2 font-normal">
                        <Checkbox
                            checked={chosen.has(choice.value)}
                            readOnly={change.isPending}
                            onCheckedChange={(checked) => toggle(choice.value, checked === true)}
                        />
                        {choice.label}
                    </Label>
                ))}
            </div>
        </SettingsRow>
    );
}

function LockedRow({ policy }: { policy: PolicyInfo }) {
    return (
        <SettingsRow
            label={policy.label}
            description={policy.description}
            disabled
            control={
                <>
                    <span className="text-sm">{display(policy, policy.value)}</span>
                    <LockedBadge policy={policy} />
                </>
            }
        />
    );
}

function PolicyRow({ policy }: { policy: PolicyInfo }) {
    if (policy.locked) {
        return <LockedRow policy={policy} />;
    }
    if (policy.kind === "bool") {
        return <SwitchRow policy={policy} />;
    }
    if (policy.kind === "int") {
        return <NumberRow policy={policy} />;
    }
    if (policy.kind === "choice") {
        return <ChoiceRow policy={policy} />;
    }
    if (policy.choices.length > 0) {
        return <ChoiceListRow policy={policy} />;
    }
    return <TextRow policy={policy} />;
}

function LicenceList({ policy }: { policy: PolicyInfo }) {
    const change = useChange(policy.name);
    const chosen = new Set(asList(policy.value));
    const toggle = (item: string, on: boolean) =>
        change.mutate(
            policy.choices
                .map((choice) => choice.value)
                .filter((value) => (value === item ? on : chosen.has(value))),
        );
    return (
        <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{policy.label}</legend>
            {policy.locked && <LockedBadge policy={policy} />}
            <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                {policy.choices.map((choice) => (
                    <Label key={choice.value} className="flex items-center gap-2 font-normal">
                        <Checkbox
                            checked={chosen.has(choice.value)}
                            disabled={policy.locked}
                            readOnly={change.isPending}
                            onCheckedChange={(checked) => toggle(choice.value, checked === true)}
                        />
                        {choice.label}
                    </Label>
                ))}
            </div>
            {chosen.size === 0 && (
                <p className="text-sm text-warning">
                    No licence is allowed until you tick one, so every download is refused.
                </p>
            )}
            <ErrorLine error={change.error} />
        </fieldset>
    );
}

function LicencesRow({ mode, list }: { mode: PolicyInfo; list: PolicyInfo | undefined }) {
    const change = useChange(mode.name);
    const anyLicence = mode.value === "all";
    return (
        <SettingsRow
            id="licence-any"
            toggle
            disabled={mode.locked}
            label="Allow any licence"
            description={
                anyLicence
                    ? "Includes non-commercial and custom terms we have not reviewed. Check each model's licence yourself."
                    : "Only the licences ticked below, each reviewed for commercial use."
            }
            error={errorMessage(change.error)}
            control={
                <>
                    <Switch
                        id="licence-any"
                        checked={anyLicence}
                        disabled={mode.locked}
                        readOnly={change.isPending}
                        onCheckedChange={(checked) => change.mutate(checked ? "all" : "selected")}
                    />
                    {mode.locked && <LockedBadge policy={mode} />}
                </>
            }
        >
            {!anyLicence && list && (
                <div className="pb-2.5">
                    <LicenceList policy={list} />
                </div>
            )}
        </SettingsRow>
    );
}

const MODEL_ACTIONS: Record<string, (detail: Record<string, unknown>) => string> = {
    "model.verify": (detail) => `Verify started for ${String(detail.files ?? "all")} files`,
    "model.repair": (detail) => `Repair from ${String(detail.source ?? "the model hub")}`,
    "model.reimport": (detail) => `Re-import from ${String(detail.source ?? "a copy")}`,
    "model.relocate": (detail) =>
        `Moved from ${String(detail.from ?? "—")} to ${String(detail.to ?? "—")}`,
};

function describe(event: AuditInfo, byName: Map<string, PolicyInfo>): [string, string] {
    const detail = event.detail as Record<string, unknown>;
    const repair = MODEL_ACTIONS[event.action];
    if (repair) {
        return [`Model ${String(detail.name ?? event.target)}`, repair(detail)];
    }
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
                            <SettingsGroup>
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
                            </SettingsGroup>
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
