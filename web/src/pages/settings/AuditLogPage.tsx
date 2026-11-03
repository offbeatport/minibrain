import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, ShieldCheck, Timer } from "lucide-react";
import {
    Badge,
    Button,
    CheckboxSelect,
    DataGrid,
    DataGridDetail,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Label,
    Link,
    SearchInput,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    SettingsGroup,
    SettingsRow,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "obp-ui";
import { type ComponentProps, type ReactNode, useEffect, useMemo, useState } from "react";
import { api, unwrap } from "~/api/client";
import type { components } from "~/api/schema";
import { Facts } from "~/components/Facts";
import { ErrorLine, PanelSection, PanelSections, errorMessage } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import {
    AUDIT_KEYS,
    AUDIT_PATH,
    type AuditEvent,
    type AuditQuery,
    actionLabel,
    actorLabel,
    auditQuery,
    changesOf,
    exportHref,
    keyLabel,
    otherFields,
    plainValue,
    summaryOf,
    targetLabel,
} from "~/lib/audit";
import { count } from "~/lib/format";
import { splitList, useListSearch } from "~/lib/listSearch";
import { exactTime, relativeTime } from "~/lib/time";

type PolicyInfo = components["schemas"]["PolicyInfo"];
type Policies = Map<string, PolicyInfo>;
type ChainInfo = components["schemas"]["AuditChainInfo"];
type SiemInfo = components["schemas"]["SiemInfo"];

const PAGE_SIZE = 50;
const SECURITY_PATH = "/settings/security";
const SEARCH_DELAY_MS = 300;
const RETENTION = "audit_retention_days";
const DAY_MS = 24 * 3600 * 1000;
const RETENTION_CHOICES: [number, string][] = [
    [0, "Keep forever"],
    [2555, "7 years"],
    [1095, "3 years"],
    [365, "1 year"],
    [180, "180 days"],
    [90, "90 days"],
];

function usePolicies() {
    return useQuery({ queryKey: ["policies"], queryFn: () => unwrap(api.GET("/api/policies")) });
}

function useAuditPage(query: AuditQuery, before?: string, after?: string) {
    return useQuery({
        queryKey: ["audit", "page", query, before ?? "", after ?? ""],
        queryFn: () =>
            unwrap(
                api.GET("/api/audit", {
                    params: {
                        query: {
                            ...query,
                            before: before ? Number(before) : undefined,
                            after: after ? Number(after) : undefined,
                            limit: PAGE_SIZE,
                        },
                    },
                }),
            ),
        placeholderData: keepPreviousData,
    });
}

function TimeCell({ at }: { at: string }) {
    return (
        <div className="flex flex-col">
            <span className="tabular-nums">{exactTime(at)}</span>
            <DataGridDetail className="text-muted-foreground">{relativeTime(at)}</DataGridDetail>
        </div>
    );
}

function auditColumns(policies: Policies): ColumnDef<AuditEvent, unknown>[] {
    return [
        {
            id: "at",
            header: "Time",
            cell: ({ row }) => <TimeCell at={row.original.at} />,
        },
        {
            id: "actor",
            header: "Actor",
            cell: ({ row }) => (
                <div className="flex flex-col">
                    <span>{actorLabel(row.original.actor)}</span>
                    {row.original.ip && (
                        <DataGridDetail className="tabular-nums text-muted-foreground">
                            {row.original.ip}
                        </DataGridDetail>
                    )}
                </div>
            ),
        },
        {
            id: "action",
            header: "Action",
            cell: ({ row }) => (
                <div className="flex flex-col">
                    <span>{actionLabel(row.original.action)}</span>
                    <DataGridDetail className="font-mono text-muted-foreground">
                        {row.original.action}
                    </DataGridDetail>
                </div>
            ),
        },
        {
            id: "target",
            header: "Target",
            cell: ({ row }) => (
                <span className="block min-w-36 whitespace-normal break-words">
                    {targetLabel(row.original, policies)}
                </span>
            ),
        },
        {
            id: "details",
            header: "Details",
            cell: ({ row }) => (
                <span className="line-clamp-2 whitespace-normal break-words">
                    {summaryOf(row.original, policies)}
                </span>
            ),
        },
    ];
}

function useDebounced(value: string, onSettle: (value: string) => void) {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    useEffect(() => {
        if (draft === value) {
            return;
        }
        const timer = window.setTimeout(() => onSettle(draft), SEARCH_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [draft, value, onSettle]);
    return [draft, setDraft] as const;
}

function DateFilter({
    label,
    value,
    min,
    max,
    onChange,
}: {
    label: string;
    value: string;
    min?: string;
    max?: string;
    onChange: (value: string) => void;
}) {
    return (
        <Label className="flex items-center gap-2 font-normal">
            <span className="text-muted-foreground">{label}</span>
            <Input
                type="date"
                value={value}
                min={min}
                max={max}
                onChange={(event) => onChange(event.target.value)}
                className="w-40 tabular-nums"
            />
        </Label>
    );
}

function Pager({
    page,
    onNewer,
    onOlder,
}: {
    page: components["schemas"]["AuditPage"];
    onNewer: () => void;
    onOlder: () => void;
}) {
    const first = page.newer + 1;
    const last = page.newer + page.events.length;
    return (
        <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground tabular-nums">
                {page.total === 0
                    ? "No events"
                    : `${count(first)}–${count(last)} of ${count(page.total)} events, newest first`}
            </p>
            <div className="flex items-center gap-2">
                <Button variant="outline" disabled={page.newer_cursor === null} onClick={onNewer}>
                    <ChevronLeft />
                    Newer
                </Button>
                <Button variant="outline" disabled={page.older_cursor === null} onClick={onOlder}>
                    Older
                    <ChevronRight />
                </Button>
            </div>
        </div>
    );
}

function ChangeTable({ event, policies }: { event: AuditEvent; policies: Policies }) {
    const changes = changesOf(event, policies);
    if (changes.length === 0) {
        return null;
    }
    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Change</h3>
            <div className="overflow-x-auto rounded-md border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Field</TableHead>
                            <TableHead>Before</TableHead>
                            <TableHead>After</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {changes.map((change) => (
                            <TableRow key={change.field}>
                                <TableCell className="text-muted-foreground">
                                    {change.field}
                                </TableCell>
                                <TableCell className="whitespace-normal break-words">
                                    {change.before}
                                </TableCell>
                                <TableCell className="whitespace-normal break-words">
                                    {change.after}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </section>
    );
}

function Hash({ value }: { value: string | null | undefined }) {
    return value ? (
        <span className="font-mono break-all">{value}</span>
    ) : (
        <span className="text-muted-foreground">Not sealed yet</span>
    );
}

function EventBody({ event, policies }: { event: AuditEvent; policies: Policies }) {
    const target = targetLabel(event, policies);
    const facts: [string, ReactNode][] = [
        [
            "Time",
            <span key="at" className="tabular-nums">
                {`${exactTime(event.at)} (${relativeTime(event.at)})`}
            </span>,
        ],
        ["Actor", actorLabel(event.actor)],
        [
            "IP address",
            <span key="ip" className={event.ip ? "tabular-nums" : "text-muted-foreground"}>
                {event.ip ?? "Not recorded"}
            </span>,
        ],
        [
            "Action",
            <span key="action" className="font-mono">
                {event.action}
            </span>,
        ],
        ["Target", target],
    ];
    if (target !== event.target) {
        facts.push([
            "Target id",
            <span key="target" className="font-mono break-all">
                {event.target}
            </span>,
        ]);
    }
    facts.push(
        [
            "Sequence",
            event.seq === null ? (
                <span key="seq" className="text-muted-foreground">
                    Not sealed yet
                </span>
            ) : (
                <span key="seq" className="tabular-nums">
                    {count(event.seq)}
                </span>
            ),
        ],
        ["Hash", <Hash key="hash" value={event.hash} />],
        ["Previous hash", <Hash key="prev" value={event.prev_hash} />],
    );
    const fields = otherFields(event).filter(
        ([name]) => name !== "name" || target !== event.detail.name,
    );
    return (
        <div className="flex min-w-0 flex-col gap-6">
            <Facts items={facts} />
            <ChangeTable event={event} policies={policies} />
            {fields.length > 0 && (
                <section className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium">Details</h3>
                    <Facts
                        items={fields.map(([name, value]) => [
                            keyLabel(name),
                            <span key={name} className="whitespace-pre-wrap break-words">
                                {plainValue(value, undefined, name)}
                            </span>,
                        ])}
                    />
                </section>
            )}
        </div>
    );
}

function EventDialog({
    id,
    loaded,
    policies,
    onClose,
}: {
    id: number | null;
    loaded: AuditEvent | undefined;
    policies: Policies;
    onClose: () => void;
}) {
    const fetched = useQuery({
        queryKey: ["audit", "event", id],
        queryFn: () =>
            unwrap(api.GET("/api/audit/{event_id}", { params: { path: { event_id: id ?? 0 } } })),
        enabled: id !== null && loaded === undefined,
    });
    const event = loaded ?? fetched.data;
    return (
        <Dialog open={id !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{event ? actionLabel(event.action) : `Event ${id}`}</DialogTitle>
                    <DialogDescription>
                        {event
                            ? `${targetLabel(event, policies)}, by ${actorLabel(event.actor)}`
                            : "Loading…"}
                    </DialogDescription>
                </DialogHeader>
                <ErrorLine error={fetched.error} />
                {event && <EventBody event={event} policies={policies} />}
            </DialogContent>
        </Dialog>
    );
}

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
            label="SIEM export"
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

function Integrity() {
    const chain = useChain();
    return (
        <PanelSection
            icon={ShieldCheck}
            title="Integrity"
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
                    label="Hash chain"
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

function Retention({ policy }: { policy: PolicyInfo }) {
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
            <span className="text-sm">{retentionText(days)}</span>
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
        <PanelSection icon={Timer} title="Retention">
            <SettingsGroup>
                <SettingsRow
                    id={policy.locked ? undefined : "audit-retention"}
                    label="Keep audit events"
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
                        <p className="pb-2.5 text-sm text-warning">
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

export function AuditLogPage() {
    const { search, update } = useListSearch(AUDIT_PATH, AUDIT_KEYS);
    const query = useMemo(() => auditQuery(search), [search]);
    const page = useAuditPage(query, search.before, search.after);
    const policiesQuery = usePolicies();
    const facets = useQuery({
        queryKey: ["audit", "facets"],
        queryFn: () => unwrap(api.GET("/api/audit/facets")),
    });
    const policies: Policies = useMemo(
        () => new Map((policiesQuery.data ?? []).map((policy) => [policy.name, policy])),
        [policiesQuery.data],
    );
    const columns = useMemo(() => auditColumns(policies), [policies]);
    const filter = (patch: Partial<Record<(typeof AUDIT_KEYS)[number], string>>) =>
        update({ ...patch, before: "", after: "" });
    const [draft, setDraft] = useDebounced(search.q ?? "", (q) => filter({ q }));
    const actions = splitList(search.action);
    const actors = splitList(search.actor);
    const filtering = Boolean(
        search.q || search.action || search.actor || search.from || search.to,
    );
    const clear = () => filter({ q: "", action: "", actor: "", from: "", to: "" });
    const eventId =
        search.event && Number.isInteger(Number(search.event)) ? Number(search.event) : null;
    const loaded = page.data?.events.find((event) => event.id === eventId);
    const retention = policies.get(RETENTION);
    return (
        <SettingsLayout
            title="Audit log"
            actions={
                <>
                    <Button variant="outline" asChild>
                        <a href={exportHref(query, "csv")} download>
                            Export CSV
                        </a>
                    </Button>
                    <Button variant="outline" asChild>
                        <a href={exportHref(query, "jsonl")} download>
                            Export JSONL
                        </a>
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <SearchInput
                        aria-label="Search the audit log"
                        placeholder="Search"
                        value={draft}
                        onValueChange={setDraft}
                        className="w-56"
                    />
                    <CheckboxSelect
                        label="Action"
                        allLabel="All actions"
                        noun="actions"
                        options={(facets.data?.actions ?? []).map((item) => ({
                            value: item.value,
                            label: actionLabel(item.value),
                            count: item.count,
                        }))}
                        value={actions}
                        onValueChange={(next) => filter({ action: next.join(",") })}
                    />
                    <CheckboxSelect
                        label="Actor"
                        allLabel="All actors"
                        noun="actors"
                        options={(facets.data?.actors ?? []).map((item) => ({
                            value: item.value,
                            label: actorLabel(item.value),
                            count: item.count,
                        }))}
                        value={actors}
                        onValueChange={(next) => filter({ actor: next.join(",") })}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                        <DateFilter
                            label="From"
                            value={search.from ?? ""}
                            max={search.to}
                            onChange={(from) => filter({ from })}
                        />
                        <DateFilter
                            label="To"
                            value={search.to ?? ""}
                            min={search.from}
                            onChange={(to) => filter({ to })}
                        />
                    </div>
                    {filtering && (
                        <Button variant="ghost" onClick={clear}>
                            Clear filters
                        </Button>
                    )}
                </div>
                <ErrorLine error={page.error ?? facets.error} />
                <DataGrid
                    columns={columns}
                    rows={page.data?.events ?? []}
                    getRowId={(event) => String(event.id)}
                    loading={page.isLoading}
                    sortable={false}
                    storageKey="minibrain.audit.columns"
                    onOpen={(event) => update({ event: String(event.id) })}
                    rowLabel={(event) =>
                        `${actionLabel(event.action)}, ${targetLabel(event, policies)}, ${exactTime(event.at)}`
                    }
                    minWidth="min-w-[880px]"
                    empty={
                        filtering ? (
                            <div className="flex flex-wrap items-center gap-2">
                                <p className="text-muted-foreground">
                                    No events match these filters.
                                </p>
                                <Button variant="outline" onClick={clear}>
                                    Clear filters
                                </Button>
                            </div>
                        ) : (
                            <p className="text-muted-foreground">
                                No events yet. Changes to policies, keys, models and storage show up
                                here.
                            </p>
                        )
                    }
                />
                {page.data && (
                    <Pager
                        page={page.data}
                        onNewer={() =>
                            update({ before: "", after: String(page.data?.newer_cursor ?? "") })
                        }
                        onOlder={() =>
                            update({ after: "", before: String(page.data?.older_cursor ?? "") })
                        }
                    />
                )}
            </div>
            <PanelSections>
                <Integrity />
                {retention && <Retention policy={retention} />}
            </PanelSections>
            <EventDialog
                id={eventId}
                loaded={loaded}
                policies={policies}
                onClose={() => update({ event: "" })}
            />
        </SettingsLayout>
    );
}
