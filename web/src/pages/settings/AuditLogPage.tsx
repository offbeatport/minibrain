import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
    Bot,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Download,
    KeyRound,
    type LucideIcon,
    SquareTerminal,
    User,
    X,
} from "lucide-react";
import {
    Badge,
    Button,
    CheckboxSelect,
    DataGrid,
    DataGridDetail,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Input,
    Label,
    Link,
    SearchInput,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "obp-ui";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { api, unwrap } from "~/api/client";
import type { components } from "~/api/schema";
import { Facts } from "~/components/Facts";
import { ErrorLine, PanelSections } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import {
    AUDIT_KEYS,
    AUDIT_PATH,
    type AuditEvent,
    type AuditQuery,
    CUSTOM_RANGE,
    RANGES,
    actionLabel,
    actorLabel,
    actorOf,
    auditQuery,
    categoryLabel,
    changesOf,
    exportHref,
    keyLabel,
    otherFields,
    plainValue,
    resultOf,
    summaryOf,
    targetHref,
    targetLabel,
    utcTime,
} from "~/lib/audit";
import { count } from "~/lib/format";
import { splitList, useListSearch } from "~/lib/listSearch";
import { exactTime, relativeTime } from "~/lib/time";
import { Integrity, RETENTION, Retention } from "~/pages/settings/audit/AuditPolicies";

type PolicyInfo = components["schemas"]["PolicyInfo"];
type Policies = Map<string, PolicyInfo>;
type AuditSearchKey = (typeof AUDIT_KEYS)[number];

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 300;
const ALL_TIME = "all";

const ACTOR_ICONS: Record<AuditEvent["actor_kind"], LucideIcon> = {
    user: User,
    api_key: KeyRound,
    command_line: SquareTerminal,
    system: Bot,
};

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

function ActorCell({ event }: { event: AuditEvent }) {
    const Icon = ACTOR_ICONS[event.actor_kind];
    return (
        <span className="flex min-w-0 items-center gap-2">
            <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{actorOf(event)}</span>
        </span>
    );
}

function TargetCell({ event, policies }: { event: AuditEvent; policies: Policies }) {
    const label = targetLabel(event, policies);
    const href = targetHref(event);
    if (href) {
        return (
            <Link
                href={href}
                onClick={(click) => click.stopPropagation()}
                className="block min-w-0 truncate text-primary hover:underline"
            >
                {label}
            </Link>
        );
    }
    return (
        <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate">{label}</span>
            {event.target_ref && !event.target_ref.live && (
                <span className="shrink-0 text-sm text-muted-foreground">deleted</span>
            )}
        </span>
    );
}

function ResultCell({ event }: { event: AuditEvent }) {
    const result = resultOf(event);
    return result.failed ? (
        <Badge variant="destructive">{result.label}</Badge>
    ) : (
        <span className="text-muted-foreground">{result.label}</span>
    );
}

function auditColumns(policies: Policies): ColumnDef<AuditEvent, unknown>[] {
    return [
        {
            id: "at",
            header: "Time",
            cell: ({ row }) => (
                <span title={utcTime(row.original.at)} className="whitespace-nowrap tabular-nums">
                    {relativeTime(row.original.at)}
                </span>
            ),
        },
        {
            id: "actor",
            header: "Actor",
            cell: ({ row }) => <ActorCell event={row.original} />,
        },
        {
            id: "action",
            header: "Action",
            cell: ({ row }) => (
                <div className="flex min-w-0 flex-col">
                    <span>{actionLabel(row.original.action)}</span>
                    <DataGridDetail className="line-clamp-1 whitespace-normal break-words text-muted-foreground">
                        {summaryOf(row.original, policies)}
                    </DataGridDetail>
                </div>
            ),
        },
        {
            id: "target",
            header: "Target",
            cell: ({ row }) => <TargetCell event={row.original} policies={policies} />,
        },
        {
            id: "result",
            header: "Result",
            cell: ({ row }) => <ResultCell event={row.original} />,
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

function RangeSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    return (
        <Select value={value} onValueChange={(next) => next && onChange(String(next))}>
            <SelectTrigger aria-label="Time range" className="w-40">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value={ALL_TIME}>All time</SelectItem>
                {RANGES.map(([range, label]) => (
                    <SelectItem key={range} value={range}>
                        {label}
                    </SelectItem>
                ))}
                <SelectItem value={CUSTOM_RANGE}>Custom dates</SelectItem>
            </SelectContent>
        </Select>
    );
}

function ExportMenu({ query }: { query: AuditQuery }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline">
                    <Download />
                    Export
                    <ChevronDown aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                    <a href={exportHref(query, "csv")} download>
                        CSV
                    </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                    <a href={exportHref(query, "jsonl")} download>
                        JSONL
                    </a>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
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
                    : `${count(first)}–${count(last)} of ${count(page.total)}`}
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
            <h3 className="font-medium">Change</h3>
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
        ["Actor", actorOf(event)],
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
                    <h3 className="font-medium">Details</h3>
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

function EventSheet({
    id,
    loaded,
    policies,
    onClose,
    onTarget,
}: {
    id: number | null;
    loaded: AuditEvent | undefined;
    policies: Policies;
    onClose: () => void;
    onTarget: (target: string) => void;
}) {
    const fetched = useQuery({
        queryKey: ["audit", "event", id],
        queryFn: () =>
            unwrap(api.GET("/api/audit/{event_id}", { params: { path: { event_id: id ?? 0 } } })),
        enabled: id !== null && loaded === undefined,
    });
    const event = loaded ?? fetched.data;
    const href = event ? targetHref(event) : undefined;
    return (
        <Sheet open={id !== null} onOpenChange={(open) => !open && onClose()}>
            <SheetContent className="flex flex-col gap-6 overflow-y-auto sm:max-w-xl">
                <SheetHeader>
                    <SheetTitle>{event ? actionLabel(event.action) : `Event ${id}`}</SheetTitle>
                    <SheetDescription>
                        {event
                            ? `${targetLabel(event, policies)} · ${actorOf(event)} · ${relativeTime(event.at)}`
                            : "Loading…"}
                    </SheetDescription>
                </SheetHeader>
                <ErrorLine error={fetched.error} />
                {event && (
                    <div className="flex flex-wrap gap-2">
                        {href && (
                            <Button variant="outline" asChild>
                                <Link href={href}>Open target</Link>
                            </Button>
                        )}
                        {event.target_ref && (
                            <Button
                                variant="outline"
                                onClick={() => event.target_ref && onTarget(event.target_ref.key)}
                            >
                                All events for this target
                            </Button>
                        )}
                    </div>
                )}
                {event && (
                    <div className="pb-panel">
                        <EventBody event={event} policies={policies} />
                    </div>
                )}
            </SheetContent>
        </Sheet>
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
    const filter = (patch: Partial<Record<AuditSearchKey, string>>) =>
        update({ ...patch, before: "", after: "" });
    const [draft, setDraft] = useDebounced(search.q ?? "", (q) => filter({ q }));
    const categories = splitList(search.category);
    const actors = splitList(search.actor);
    const range = search.range || ALL_TIME;
    const filtering = Boolean(
        search.q ||
            search.category ||
            search.action ||
            search.actor ||
            search.target ||
            search.range,
    );
    const clear = () =>
        filter({
            q: "",
            category: "",
            action: "",
            actor: "",
            target: "",
            range: "",
            from: "",
            to: "",
        });
    const eventId =
        search.event && Number.isInteger(Number(search.event)) ? Number(search.event) : null;
    const loaded = page.data?.events.find((event) => event.id === eventId);
    const retention = policies.get(RETENTION);
    return (
        <SettingsLayout title="Audit log" actions={<ExportMenu query={query} />}>
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
                        label="Area"
                        allLabel="All areas"
                        noun="areas"
                        options={(facets.data?.categories ?? []).map((item) => ({
                            value: item.value,
                            label: categoryLabel(item.value),
                            count: item.count,
                        }))}
                        value={categories}
                        onValueChange={(next) => filter({ category: next.join(","), action: "" })}
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
                    <RangeSelect
                        value={range}
                        onChange={(next) =>
                            filter({ range: next === ALL_TIME ? "" : next, from: "", to: "" })
                        }
                    />
                    {range === CUSTOM_RANGE && (
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
                    )}
                    {search.target && (
                        <Button variant="outline" onClick={() => filter({ target: "" })}>
                            <span className="text-muted-foreground">Target</span>
                            <span className="font-mono">{search.target}</span>
                            <X aria-hidden />
                        </Button>
                    )}
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
                    storageKey="minibrain.audit.columns.v2"
                    onOpen={(event) => update({ event: String(event.id) })}
                    rowLabel={(event) =>
                        `${actionLabel(event.action)}, ${targetLabel(event, policies)}, ${exactTime(event.at)}`
                    }
                    minWidth="min-w-[760px]"
                    empty={
                        filtering ? (
                            <div className="flex flex-wrap items-center gap-2">
                                <p className="text-muted-foreground">No events match.</p>
                                <Button variant="outline" onClick={clear}>
                                    Clear filters
                                </Button>
                            </div>
                        ) : (
                            <p className="text-muted-foreground">No events yet.</p>
                        )
                    }
                />
                {page.data && page.data.total > 0 && (
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
            <EventSheet
                id={eventId}
                loaded={loaded}
                policies={policies}
                onClose={() => update({ event: "" })}
                onTarget={(target) => filter({ target, event: "" })}
            />
        </SettingsLayout>
    );
}
