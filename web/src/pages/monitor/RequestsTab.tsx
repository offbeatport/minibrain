import type { ColumnDef } from "@tanstack/react-table";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import {
    Button,
    Card,
    CardContent,
    CheckboxSelect,
    DataGrid,
    EmptyState,
    Link,
    SearchInput,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
    type RequestFilter,
    type RequestRow,
    type RequestSummary,
    useRequestFacets,
    useRequestList,
    useRequestSummary,
} from "~/api/requestQueries";
import { ModelName, withDeleted } from "~/components/ModelName";
import { modelOption } from "~/components/PublisherLogo";
import { ErrorLine, Stat } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { count, milliseconds, percent } from "~/lib/format";
import { splitList, useListSearch } from "~/lib/listSearch";
import {
    DEFAULT_RANGE,
    RANGES,
    REQUESTS_PATH,
    REQUEST_KEYS,
    STATUS_CLASSES,
    STATUS_TONES,
    type StatusClass,
    clockTime,
    modelLabel,
    rangeOf,
} from "~/lib/requests";
import { exactTime, relativeTime } from "~/lib/time";
import { RequestDialog } from "./RequestDetail";

const SEARCH_DELAY_MS = 300;

type FacetOption = {
    value: string;
    label: string;
    count: number;
    publisher?: string | null;
    deleted?: boolean;
};

function versionOption(option: FacetOption) {
    return {
        ...option,
        label: <ModelName name={option.label} deleted={option.deleted} />,
        text: withDeleted(option.label, option.deleted),
    };
}

function Muted({ children }: { children: ReactNode }) {
    return <span className="text-muted-foreground">{children}</span>;
}

function TimeCell({ at }: { at: string }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="whitespace-nowrap rounded-sm tabular-nums">
                    <time dateTime={at}>{clockTime(at)}</time>
                </button>
            </TooltipTrigger>
            <TooltipContent>{`${exactTime(at)}, ${relativeTime(at)}`}</TooltipContent>
        </Tooltip>
    );
}

function FeedbackMark({ row }: { row: RequestRow }) {
    if (row.feedback_down === 0 && row.feedback_up === 0) {
        return null;
    }
    return (
        <span className="flex items-center gap-2 tabular-nums">
            {row.feedback_down > 0 && (
                <span className="flex items-center gap-1 text-warning">
                    <ThumbsDown aria-hidden="true" className="size-3.5" />
                    <span className="sr-only">Marked wrong</span>
                    {row.feedback_down > 1 && row.feedback_down}
                </span>
            )}
            {row.feedback_up > 0 && (
                <span className="flex items-center gap-1 text-success">
                    <ThumbsUp aria-hidden="true" className="size-3.5" />
                    <span className="sr-only">Marked right</span>
                    {row.feedback_up > 1 && row.feedback_up}
                </span>
            )}
        </span>
    );
}

const COLUMNS: ColumnDef<RequestRow, unknown>[] = [
    {
        id: "at",
        header: "Time",
        enableHiding: false,
        cell: ({ row }) => <TimeCell at={row.original.at} />,
    },
    {
        id: "model",
        header: "Model",
        cell: ({ row }) => (
            <ModelName
                name={modelLabel(row.original)}
                deleted={row.original.deleted}
                className="block max-w-48 truncate"
            />
        ),
    },
    {
        id: "key",
        header: "Key",
        cell: ({ row }) =>
            row.original.key_name ? (
                <span className="block max-w-40 truncate">{row.original.key_name}</span>
            ) : (
                <Muted>Deleted key</Muted>
            ),
    },
    {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
            <StatusText tone={STATUS_TONES[row.original.status_class]}>
                <span className="tabular-nums">{row.original.status}</span>
            </StatusText>
        ),
    },
    {
        id: "latency",
        header: "Latency",
        cell: ({ row }) => (
            <span className="tabular-nums">{milliseconds(row.original.latency_ms)}</span>
        ),
    },
    {
        id: "tokens",
        header: "Tokens in / out",
        cell: ({ row }) => (
            <span className="tabular-nums">
                {`${count(row.original.prompt_tokens)} / ${count(row.original.completion_tokens)}`}
            </span>
        ),
    },
    {
        id: "finish",
        header: "Finish",
        cell: ({ row }) =>
            row.original.finish_reason ? row.original.finish_reason : <Muted>–</Muted>,
    },
    {
        id: "response",
        header: "Response ID",
        cell: ({ row }) =>
            row.original.response_id ? (
                <span className="block max-w-52 truncate font-mono text-muted-foreground">
                    {row.original.response_id}
                </span>
            ) : (
                <Muted>–</Muted>
            ),
    },
    {
        id: "feedback",
        header: "Feedback",
        cell: ({ row }) => <FeedbackMark row={row.original} />,
    },
];

function withChosen(options: FacetOption[], chosen: string[]): FacetOption[] {
    const known = new Set(options.map((option) => option.value));
    return [
        ...options,
        ...chosen
            .filter((value) => !known.has(value))
            .map((value) => ({ value, label: value, count: 0 })),
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

export function LiveControl({ paused, onToggle }: { paused: boolean; onToggle: () => void }) {
    return (
        <div className="flex items-center gap-3">
            <StatusText tone={paused ? "neutral" : "info"}>{paused ? "Paused" : "Live"}</StatusText>
            <Button variant="outline" onClick={onToggle} aria-pressed={paused}>
                {paused ? "Resume" : "Pause"}
            </Button>
        </div>
    );
}

export function SummaryStrip({
    summary,
    range,
    onRange,
}: {
    summary: RequestSummary | undefined;
    range: string;
    onRange: (range: string) => void;
}) {
    const errors = summary?.errors ?? 0;
    return (
        <Card>
            <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-4">
                <Select value={range} onValueChange={(next) => onRange(String(next))}>
                    <SelectTrigger aria-label="Time range" className="w-44">
                        <SelectValue>{rangeOf(range).label}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                        {RANGES.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                                {item.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Stat label="Requests" value={count(summary?.requests)} />
                <Stat
                    label="Error rate"
                    value={
                        <>
                            {percent(summary?.error_rate)}
                            {errors > 0 && (
                                <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                                    {`${count(errors)} ${errors === 1 ? "error" : "errors"}`}
                                </span>
                            )}
                        </>
                    }
                />
                <Stat label="Latency p50" value={milliseconds(summary?.p50_ms)} />
                <Stat label="Latency p95" value={milliseconds(summary?.p95_ms)} />
                <Stat label="Tokens in" value={count(summary?.prompt_tokens)} />
                <Stat label="Tokens out" value={count(summary?.completion_tokens)} />
            </CardContent>
        </Card>
    );
}

export function NothingYet({ summary, range }: { summary: RequestSummary; range: string }) {
    if (summary.last_at) {
        return (
            <EmptyState title={`No requests ${rangeOf(range).phrase}`}>
                {`The last one came ${relativeTime(summary.last_at)}. Pick a longer time range to see it.`}
            </EmptyState>
        );
    }
    return (
        <EmptyState title="No requests yet">
            Calls to <span className="font-mono">/v1/chat/completions</span> show up here within a
            few seconds. Create an API key for a model on{" "}
            <Link href="/deployments" className="text-primary hover:underline">
                Deployments
            </Link>{" "}
            to start.
        </EmptyState>
    );
}

function requestId(value: string | undefined): number | null {
    const id = Number(value);
    return value && Number.isInteger(id) && id > 0 ? id : null;
}

export function RequestsTab({ paused }: { paused: boolean }) {
    const { search, update } = useListSearch(REQUESTS_PATH, REQUEST_KEYS);
    const range = rangeOf(search.range ?? DEFAULT_RANGE).value;
    const filter: RequestFilter = useMemo(
        () => ({
            model: splitList(search.model),
            version: splitList(search.version),
            key: splitList(search.key),
            status: splitList(search.status).filter((value): value is StatusClass =>
                STATUS_CLASSES.some((item) => item.value === value),
            ),
            q: search.q ?? "",
            range,
        }),
        [search, range],
    );
    const list = useRequestList(filter, paused);
    const facets = useRequestFacets(filter, paused);
    const summary = useRequestSummary(filter, paused);
    const [draft, setDraft] = useDebounced(search.q ?? "", (q) => update({ q }));
    const filtering =
        filter.model.length + filter.version.length + filter.key.length + filter.status.length >
            0 || Boolean(filter.q);
    const clear = () => update({ model: "", version: "", key: "", status: "", q: "" });
    const selected = requestId(search.request);
    const loaded = list.rows.find((row) => row.id === selected);
    const statuses = facets.data?.statuses ?? {};
    const empty = filtering ? (
        <div className="flex flex-wrap items-center gap-2">
            <p className="text-muted-foreground">No requests match these filters.</p>
            <Button variant="outline" onClick={clear}>
                Clear filters
            </Button>
        </div>
    ) : summary.data ? (
        <NothingYet summary={summary.data} range={range} />
    ) : null;
    return (
        <>
            <div className="flex flex-wrap items-center gap-2">
                <SearchInput
                    aria-label="Search response IDs"
                    placeholder="Search response IDs"
                    value={draft}
                    onValueChange={setDraft}
                    className="w-full min-w-48 max-w-xs flex-1"
                />
                <CheckboxSelect
                    label="Model"
                    allLabel="All models"
                    noun="models"
                    options={withChosen(facets.data?.models ?? [], filter.model).map(modelOption)}
                    value={filter.model}
                    onValueChange={(next) => update({ model: next.join(",") })}
                />
                <CheckboxSelect
                    label="Version"
                    allLabel="All versions"
                    noun="versions"
                    options={withChosen(facets.data?.versions ?? [], filter.version).map(
                        versionOption,
                    )}
                    value={filter.version}
                    onValueChange={(next) => update({ version: next.join(",") })}
                />
                <CheckboxSelect
                    label="API key"
                    allLabel="All keys"
                    noun="keys"
                    options={withChosen(facets.data?.keys ?? [], filter.key)}
                    value={filter.key}
                    onValueChange={(next) => update({ key: next.join(",") })}
                />
                <CheckboxSelect
                    label="Status"
                    allLabel="All statuses"
                    noun="statuses"
                    options={STATUS_CLASSES.map((item) => ({
                        ...item,
                        count: statuses[item.value] ?? 0,
                    }))}
                    value={filter.status}
                    onValueChange={(next) => update({ status: next.join(",") })}
                />
                {filtering && (
                    <Button variant="ghost" onClick={clear}>
                        Clear filters
                    </Button>
                )}
            </div>
            <SummaryStrip
                summary={summary.data}
                range={range}
                onRange={(next) => update({ range: next === DEFAULT_RANGE ? "" : next })}
            />
            <ErrorLine error={list.error ?? facets.error ?? summary.error} />
            <DataGrid
                columns={COLUMNS}
                rows={list.rows}
                getRowId={(row) => String(row.id)}
                loading={list.isLoading}
                sortable={false}
                storageKey="minibrain.requests.columns"
                columnPicker
                hasMore={list.hasMore}
                loadingMore={list.loadingMore}
                onLoadMore={list.loadMore}
                total={list.total}
                onOpen={(row) => update({ request: String(row.id) })}
                rowLabel={(row) =>
                    `Request ${row.id}, ${withDeleted(modelLabel(row), row.deleted)}, status ${row.status}, ${exactTime(row.at)}`
                }
                empty={empty}
                minWidth="min-w-[1040px]"
            />
            <RequestDialog id={selected} loaded={loaded} onClose={() => update({ request: "" })} />
        </>
    );
}
