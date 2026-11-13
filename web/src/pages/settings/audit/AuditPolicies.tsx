import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Timer } from "lucide-react";
import {
    Badge,
    Button,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    SettingsGroup,
    SettingsRow,
} from "obp-ui";
import { type ComponentProps, type ReactNode, useMemo } from "react";
import { api, unwrap } from "~/api/client";
import type { components } from "~/api/schema";
import { PanelSection, errorMessage } from "~/components/Section";
import { count } from "~/lib/format";
import { relativeTime } from "~/lib/time";
import { AUDIT } from "~/pages/settings/settingsIndex";

type PolicyInfo = components["schemas"]["PolicyInfo"];
type ChainInfo = components["schemas"]["AuditChainInfo"];
type SiemInfo = components["schemas"]["SiemInfo"];

export const RETENTION = "audit_retention_days";
const SECURITY_PATH = "/settings/security";
const DAY_MS = 24 * 3600 * 1000;
const RETENTION_CHOICES: [number, string][] = [
    [0, "Keep forever"],
    [2555, "7 years"],
    [1095, "3 years"],
    [365, "1 year"],
    [180, "180 days"],
    [90, "90 days"],
];

function useChain() {
    return useQuery({
        queryKey: ["audit", "chain"],
        queryFn: () => unwrap(api.GET("/api/audit/chain")),
    });
}

function seqRange(first: number, last: number): string {
    return first === last ? `seq ${count(first)}` : `seq ${count(first)} to ${count(last)}`;
}

function events(total: number): string {
    return `${count(total)} ${total === 1 ? "event" : "events"}`;
}

function queued(total: number): string {
    return total === 1 ? "1 event waits" : `${count(total)} events wait`;
}

function chainText(chain: ChainInfo): string {
    if (chain.broken) {
        const intact =
            chain.events > 0 ? ` Events up to seq ${count(chain.last_seq)} are intact.` : "";
        return `Seq ${count(chain.broken.seq)}: ${chain.broken.reason}.${intact} Compare it with your SIEM's copy or an earlier export to see what changed.`;
    }
    const parts: string[] = [];
    if (chain.events > 0 && chain.first_seq !== null) {
        parts.push(
            `${events(chain.events)}, ${seqRange(chain.first_seq, chain.last_seq)}, match their hashes and link to the one before.`,
        );
    } else {
        parts.push("Each event is sealed into the chain within seconds of being recorded.");
    }
    if (chain.anchor_seq > 0) {
        parts.push(
            `The chain starts where the last prune cut it, after seq ${count(chain.anchor_seq)}.`,
        );
    }
    if (chain.pending > 0) {
        parts.push(`${events(chain.pending)} not sealed yet.`);
    }
    return parts.join(" ");
}

function ChainBadge({ chain }: { chain: ChainInfo | undefined }) {
    if (!chain) {
        return <Badge variant="neutral">Checking</Badge>;
    }
    return chain.broken ? (
        <Badge variant="destructive">{`Broken at seq ${count(chain.broken.seq)}`}</Badge>
    ) : (
        <Badge variant="success">Verified</Badge>
    );
}

function SettingsLink({ children }: { children: ReactNode }) {
    return (
        <Link href={SECURITY_PATH} className="text-primary hover:underline">
            {children}
        </Link>
    );
}

type SiemState = {
    variant: ComponentProps<typeof Badge>["variant"];
    label: string;
    detail: string;
};

function siemState(siem: SiemInfo): SiemState {
    if (!siem.target) {
        return { variant: "neutral", label: "Off", detail: "Events stay on this install." };
    }
    const when = siem.forwarded_at ? `, ${relativeTime(siem.forwarded_at)}` : "";
    const sent =
        siem.forwarded_seq > 0
            ? `Sent up to seq ${count(siem.forwarded_seq)}${when}.`
            : "Nothing sent yet.";
    if (siem.error) {
        return {
            variant: "destructive",
            label: "Failing",
            detail: `${siem.error}. ${sent} ${queued(siem.waiting)} and will go out in order once the SIEM answers.`,
        };
    }
    if (siem.waiting > 0) {
        return {
            variant: "info",
            label: "Sending",
            detail: `${sent} ${events(siem.waiting)} to go.`,
        };
    }
    return {
        variant: "success",
        label: "Up to date",
        detail: `${sent} Every sealed event is sent.`,
    };
}

const CHECKING: SiemState = { variant: "neutral", label: "Checking", detail: "" };

function SiemRow({ siem }: { siem: SiemInfo | undefined }) {
    const state = siem ? siemState(siem) : CHECKING;
    return (
        <SettingsRow
            anchor={AUDIT.integrity.settings.siem.anchor}
            label={AUDIT.integrity.settings.siem.label}
            description={
                <>
                    {siem?.target && (
                        <>
                            <span className="font-mono break-all">{siem.target}</span>
                            {". "}
                        </>
                    )}
                    {state.detail}{" "}
                    <SettingsLink>
                        {siem?.target ? "Change it in Security" : "Set it up in Security"}
                    </SettingsLink>
                    {"."}
                </>
            }
            control={<Badge variant={state.variant}>{state.label}</Badge>}
        />
    );
}

export function Integrity() {
    const chain = useChain();
    return (
        <PanelSection
            icon={ShieldCheck}
            anchor={AUDIT.integrity.anchor}
            title={AUDIT.integrity.title}
            description="Every event carries a SHA-256 hash of its fields and of the event before it, so an edit or a deletion breaks the chain."
            actions={
                <Button
                    variant="outline"
                    disabled={chain.isFetching}
                    onClick={() => void chain.refetch()}
                >
                    {chain.isFetching ? "Verifying…" : "Verify again"}
                </Button>
            }
        >
            <SettingsGroup>
                <SettingsRow
                    anchor={AUDIT.integrity.settings.hashChain.anchor}
                    label={AUDIT.integrity.settings.hashChain.label}
                    description={chain.data ? chainText(chain.data) : "Checking every event…"}
                    error={errorMessage(chain.error)}
                    control={<ChainBadge chain={chain.data} />}
                />
                <SiemRow siem={chain.data?.siem} />
            </SettingsGroup>
        </PanelSection>
    );
}

function retentionChoices(days: number): [number, string][] {
    return RETENTION_CHOICES.some(([value]) => value === days)
        ? RETENTION_CHOICES
        : [...RETENTION_CHOICES, [days, `${days.toLocaleString()} days`]];
}

function retentionText(days: number): string {
    return retentionChoices(days).find(([value]) => value === days)?.[1] ?? `${days} days`;
}

function usePrunable(days: number) {
    const until = useMemo(() => new Date(Date.now() - days * DAY_MS).toISOString(), [days]);
    return useQuery({
        queryKey: ["audit", "prunable", days],
        queryFn: () => unwrap(api.GET("/api/audit", { params: { query: { until, limit: 1 } } })),
        enabled: days > 0,
    });
}

export function Retention({ policy }: { policy: PolicyInfo }) {
    const client = useQueryClient();
    const days = typeof policy.value === "number" ? policy.value : 0;
    const prunable = usePrunable(days);
    const change = useMutation({
        mutationFn: (value: number) =>
            unwrap(
                api.PUT("/api/policies/{name}", {
                    params: { path: { name: RETENTION } },
                    body: { value },
                }),
            ),
        onSuccess: async (policies) => {
            client.setQueryData(["policies"], policies);
            await client.invalidateQueries({ queryKey: ["audit"] });
        },
    });
    const older = prunable.data?.total ?? 0;
    const control = policy.locked ? (
        <>
            <span>{retentionText(days)}</span>
            <Badge variant="neutral">
                {policy.source === "environment" ? "Set by environment" : "Set by config file"}
            </Badge>
        </>
    ) : (
        <Select value={String(days)} onValueChange={(next) => change.mutate(Number(next))}>
            <SelectTrigger
                id="audit-retention"
                aria-describedby="audit-retention-description"
                className="w-44"
            >
                <SelectValue>{retentionText(days)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
                {retentionChoices(days).map(([value, label]) => (
                    <SelectItem key={value} value={String(value)}>
                        {label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
    return (
        <PanelSection icon={Timer} anchor={AUDIT.retention.anchor} title={AUDIT.retention.title}>
            <SettingsGroup>
                <SettingsRow
                    id={policy.locked ? undefined : "audit-retention"}
                    anchor={AUDIT.retention.settings.keep.anchor}
                    label={AUDIT.retention.settings.keep.label}
                    description={
                        days === 0
                            ? "Every event is kept. Pick a period to delete older events for good."
                            : `Events older than ${retentionText(days).toLowerCase()} are deleted for good, checked every hour. Each deletion is itself recorded here.`
                    }
                    error={errorMessage(change.error)}
                    disabled={policy.locked}
                    control={control}
                >
                    {days > 0 && (
                        <p className="pb-2.5 text-warning">
                            {older > 0
                                ? `${count(older)} ${older === 1 ? "event is" : "events are"} older than that and will be deleted within the hour. Export them first if you need a copy.`
                                : "Deleted events cannot be restored. Export the log first if you need a copy."}
                        </p>
                    )}
                </SettingsRow>
            </SettingsGroup>
        </PanelSection>
    );
}
