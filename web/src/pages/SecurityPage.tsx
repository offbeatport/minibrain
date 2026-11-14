import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    Box,
    FolderLock,
    Globe,
    KeyRound,
    LogIn,
    type LucideIcon,
    Radar,
    ScrollText,
    ShieldCheck,
    Timer,
} from "lucide-react";
import {
    Button,
    Checkbox,
    Input,
    Label,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    SettingsGroup,
    SettingsRow,
    Switch,
} from "obp-ui";
import { type FormEvent, Fragment, type ReactNode, useState } from "react";
import { api, unwrap } from "~/api/client";
import type { components } from "~/api/schema";
import { NumberSettingRow } from "~/components/NumberSettingRow";
import { ErrorLine, PanelSection, PanelSections, errorMessage } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import { SourceBadge } from "~/components/SourceBadge";
import { StatusText } from "~/components/models/StatusText";
import { AUDIT_PATH, auditHref } from "~/lib/audit";
import { AuditIntegrity, AuditRetention, RETENTION } from "~/pages/settings/AuditSettings";
import { EncryptionSettings } from "~/pages/settings/EncryptionSettings";
import { SECURITY, type SettingsSection, policyAnchor } from "~/pages/settings/settingsIndex";

type PolicyInfo = components["schemas"]["PolicyInfo"];

const POLICIES = ["policies"] as const;
const AUDIT = ["audit"] as const;
const POLICY_CHANGES = auditHref({ action: "policy.update" });
const INSTALL_PATH = "/settings/install";

type Policies = Map<string, PolicyInfo>;

type Group = {
    icon: LucideIcon;
    section: SettingsSection;
    description?: ReactNode;
    own?: (policies: Policies) => ReactNode;
};

const NESTED = new Set(["licences"]);

const GROUPS: Group[] = [
    { icon: Globe, section: SECURITY.network },
    { icon: Box, section: SECURITY.models },
    { icon: FolderLock, section: SECURITY.data },
    { icon: LogIn, section: SECURITY.signIn, description: "Applies when accounts are on." },
    {
        icon: KeyRound,
        section: SECURITY.requestLogs,
        description:
            "Every /v1 call's time, model, version, key, status, latency, tokens and response ID are always logged; they hold no content.",
    },
    {
        icon: ScrollText,
        section: SECURITY.auditExport,
        description: (
            <>
                {"Sealed events go to your SIEM as RFC 5424 syslog. Browse them in the "}
                <Link href={AUDIT_PATH} className="text-primary hover:underline">
                    audit log
                </Link>
                {"."}
            </>
        ),
    },
    { icon: ShieldCheck, section: SECURITY.auditIntegrity, own: () => <AuditIntegrity /> },
    {
        icon: Timer,
        section: SECURITY.auditRetention,
        own: (policies) => {
            const policy = policies.get(RETENTION);
            return policy ? <AuditRetention policy={policy} /> : null;
        },
    },
    {
        icon: Radar,
        section: SECURITY.otel,
        description: (
            <>
                {"Prometheus scraping and JSON logs are set in minibrain.yaml; "}
                <Link href={INSTALL_PATH} className="text-primary hover:underline">
                    This install
                </Link>
                {" shows what is on."}
            </>
        ),
    },
];

function policyNames(section: SettingsSection): string[] {
    return Object.values(section.settings).flatMap((item) =>
        item.policy && !NESTED.has(item.policy) ? [item.policy] : [],
    );
}

function LockedBadge({ policy }: { policy: PolicyInfo }) {
    return <SourceBadge source={policy.source} />;
}

const WHOLE: Intl.NumberFormatOptions = { maximumFractionDigits: 0 };
const FORMATS: Record<string, Intl.NumberFormatOptions> = {
    siem_port: { maximumFractionDigits: 0, useGrouping: false },
};

const PLACEHOLDERS: Record<string, string> = {
    allowed_hosts: "hf-mirror.internal, s3.internal",
    data_folders: "/srv/exports, /mnt/shared/datasets",
    siem_host: "siem.internal",
    siem_ca_bundle: "/etc/minibrain/siem-ca.pem",
    otel_endpoint: "https://otel-collector.internal:4318",
    otel_headers: "Authorization=Bearer <token>, X-Scope-OrgID=acme",
    otel_service_name: "minibrain",
    otel_ca_bundle: "/etc/minibrain/collector-ca.pem",
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
    if (value === "" || value === null || value === undefined) {
        return "Not set";
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
                anchor={policyAnchor(policy.name)}
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
                            placeholder={PLACEHOLDERS[policy.name]}
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

function HeadersRow({ policy }: { policy: PolicyInfo }) {
    const change = useChange(policy.name);
    const id = policyId(policy);
    const names = asList(policy.value);
    const [draft, setDraft] = useState<string | null>(null);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        change.mutate(draft ?? "", { onSuccess: () => setDraft(null) });
    };
    if (names.length > 0 && draft === null) {
        return (
            <SettingsRow
                id={id}
                anchor={policyAnchor(policy.name)}
                label={policy.label}
                description={
                    <>
                        {policy.description}
                        <StatusText tone="success" className="mt-1 flex w-fit">
                            {`Set: ${names.join(", ")}`}
                        </StatusText>
                    </>
                }
                error={errorMessage(change.error)}
                control={
                    <>
                        <Button variant="outline" onClick={() => setDraft("")}>
                            Replace
                        </Button>
                        <Button
                            variant="ghost"
                            disabled={change.isPending}
                            onClick={() => change.mutate("")}
                        >
                            Clear
                        </Button>
                    </>
                }
            />
        );
    }
    return (
        <form onSubmit={submit}>
            <SettingsRow
                id={id}
                anchor={policyAnchor(policy.name)}
                wide
                label={policy.label}
                description={policy.description}
                error={errorMessage(change.error)}
                control={
                    <>
                        <Input
                            id={id}
                            type="password"
                            autoComplete="off"
                            value={draft ?? ""}
                            aria-describedby={`${id}-description`}
                            onChange={(event) => setDraft(event.target.value)}
                            placeholder={PLACEHOLDERS[policy.name]}
                        />
                        {draft && (
                            <Button type="submit" disabled={change.isPending}>
                                Save
                            </Button>
                        )}
                        {draft !== null && names.length > 0 && (
                            <Button variant="ghost" onClick={() => setDraft(null)}>
                                Cancel
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
            anchor={policyAnchor(policy.name)}
            label={policy.label}
            description={policy.description}
            value={typeof policy.value === "number" ? policy.value : undefined}
            min={0}
            max={policy.maximum ?? undefined}
            format={FORMATS[policy.name] ?? WHOLE}
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
            anchor={policyAnchor(policy.name)}
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
            anchor={policyAnchor(policy.name)}
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
            anchor={policyAnchor(policy.name)}
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
            anchor={policyAnchor(policy.name)}
            label={policy.label}
            description={policy.description}
            disabled
            control={
                <>
                    <span>{display(policy, policy.value)}</span>
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
    if (policy.kind === "headers") {
        return <HeadersRow policy={policy} />;
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
                <p className="text-warning">
                    No licence is allowed until you tick one, so every download is refused.
                </p>
            )}
            <ErrorLine error={change.error} />
        </fieldset>
    );
}

function LicencesRow({ mode, list }: { mode: PolicyInfo; list: PolicyInfo | undefined }) {
    const change = useChange(mode.name);
    const listChange = useChange("licences");
    const anyLicence = mode.value === "all";
    const switchTo = (any: boolean) =>
        change.mutate(any ? "all" : "selected", {
            onSuccess: () => {
                const empty = Array.isArray(list?.value) && list.value.length === 0;
                if (!any && list && empty && !list.locked) {
                    listChange.mutate(
                        list.choices
                            .filter((choice) => choice.use === "commercial")
                            .map((choice) => choice.value),
                    );
                }
            },
        });
    return (
        <SettingsRow
            id="licence-any"
            anchor={SECURITY.models.settings.licenceMode.anchor}
            toggle
            disabled={mode.locked}
            label={SECURITY.models.settings.licenceMode.label}
            description={
                anyLicence
                    ? "Includes non-commercial and custom terms we have not reviewed. Check each model's licence yourself."
                    : SECURITY.models.settings.licenceMode.description
            }
            error={errorMessage(change.error ?? listChange.error)}
            control={
                <>
                    <Switch
                        id="licence-any"
                        checked={anyLicence}
                        disabled={mode.locked}
                        readOnly={change.isPending}
                        onCheckedChange={(checked) => switchTo(checked === true)}
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

export function SecurityPage() {
    const policies = useQuery({
        queryKey: POLICIES,
        queryFn: () => unwrap(api.GET("/api/policies")),
    });
    const byName: Policies = new Map((policies.data ?? []).map((policy) => [policy.name, policy]));
    return (
        <SettingsLayout
            title="Security"
            caption="Install-wide policies: network, sign-in, request logs, the audit log, exports and encryption."
        >
            <ErrorLine error={policies.error} onRetry={policies.refetch} />
            <PanelSections>
                {policies.data &&
                    GROUPS.map((group) =>
                        group.own ? (
                            <Fragment key={group.section.anchor}>{group.own(byName)}</Fragment>
                        ) : (
                            <PanelSection
                                key={group.section.anchor}
                                icon={group.icon}
                                anchor={group.section.anchor}
                                title={group.section.title}
                                description={group.description}
                            >
                                <SettingsGroup>
                                    {policyNames(group.section).map((name) => {
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
                        ),
                    )}
                {policies.data && <EncryptionSettings />}
                <p className="text-sm text-muted-foreground">
                    {"Every change on this page is recorded in the "}
                    <Link href={POLICY_CHANGES} className="text-primary hover:underline">
                        audit log
                    </Link>
                    {", with who made it and when."}
                </p>
            </PanelSections>
        </SettingsLayout>
    );
}
