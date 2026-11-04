import { useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Button, CheckboxSelect, DataGrid, EmptyState } from "obp-ui";
import { Suspense, lazy, useEffect, useMemo, useRef } from "react";
import {
    type OverviewFilter,
    type OverviewModel,
    type RequestOverview,
    overviewFilter,
    useRequestFacets,
    useRequestOverview,
    useRequestSummary,
} from "~/api/requestQueries";
import { ErrorLine, Section } from "~/components/Section";
import type { ChartSeries } from "~/components/charts/TimeChart";
import { count, milliseconds, percent } from "~/lib/format";
import { listHref, splitList, useListSearch } from "~/lib/listSearch";
import {
    DEFAULT_RANGE,
    OVERVIEW_KEYS,
    OVERVIEW_PATH,
    REQUESTS_PATH,
    clockTime,
    rangeOf,
} from "~/lib/requests";
import { exactTime, relativeTime } from "~/lib/time";
import { NothingYet, SummaryStrip } from "./RequestsTab";

const SLOT_COLORS = [
    "var(--primary)",
    "var(--file-sql)",
    "var(--file-parquet)",
    "var(--file-tsv)",
    "var(--file-json)",
];
const OTHER_COLOR = "var(--neutral)";
const SEPARATOR = "\u0000";
const Charts = lazy(() => import("./OverviewCharts"));

function assignSlots(keys: string[], kept: Map<string, number>): Map<string, number> {
    const next = new Map<string, number>();
    for (const key of keys) {
        const slot = kept.get(key);
        if (slot !== undefined && ![...next.values()].includes(slot)) {
            next.set(key, slot);
        }
    }
    const taken = new Set(next.values());
    const free = SLOT_COLORS.map((_, index) => index).filter((index) => !taken.has(index));
    for (const key of keys) {
        if (!next.has(key)) {
            next.set(key, free.shift() ?? 0);
        }
    }
    return next;
}

function useStableSlots(keys: string[]): Map<string, number> {
    const kept = useRef(new Map<string, number>());
    const signature = keys.join(SEPARATOR);
    const slots = useMemo(
        () => assignSlots(signature ? signature.split(SEPARATOR) : [], kept.current),
        [signature],
    );
    useEffect(() => {
        kept.current = slots;
    }, [slots]);
    return slots;
}

function chartSeries(overview: RequestOverview | undefined, slots: Map<string, number>) {
    return (overview?.series ?? []).map(
        (item): ChartSeries => ({
            key: item.key,
            label: item.label,
            color: item.other ? OTHER_COLOR : SLOT_COLORS[slots.get(item.key) ?? 0],
        }),
    );
}

const COLUMNS: ColumnDef<OverviewModel, unknown>[] = [
    {
        id: "model",
        header: "Model",
        enableHiding: false,
        accessorFn: (row) => row.label,
        cell: ({ row }) => (
            <span className="block max-w-72 truncate" title={row.original.key}>
                {row.original.label}
            </span>
        ),
    },
    {
        id: "requests",
        header: "Requests",
        accessorFn: (row) => row.requests,
        cell: ({ row }) => <span className="tabular-nums">{count(row.original.requests)}</span>,
    },
    {
        id: "errors",
        header: "Error rate",
        accessorFn: (row) => row.error_rate ?? 0,
        cell: ({ row }) => <span className="tabular-nums">{percent(row.original.error_rate)}</span>,
    },
    {
        id: "p50",
        header: "Latency p50",
        accessorFn: (row) => row.p50_ms ?? 0,
        cell: ({ row }) => (
            <span className="tabular-nums">{milliseconds(row.original.p50_ms)}</span>
        ),
    },
    {
        id: "p95",
        header: "Latency p95",
        accessorFn: (row) => row.p95_ms ?? 0,
        cell: ({ row }) => (
            <span className="tabular-nums">{milliseconds(row.original.p95_ms)}</span>
        ),
    },
    {
        id: "tokens",
        header: "Tokens in / out",
        accessorFn: (row) => row.prompt_tokens + row.completion_tokens,
        cell: ({ row }) => (
            <span className="tabular-nums">
                {`${count(row.original.prompt_tokens)} / ${count(row.original.completion_tokens)}`}
            </span>
        ),
    },
    {
        id: "last",
        header: "Last request",
        accessorFn: (row) => row.last_at ?? "",
        cell: ({ row }) =>
            row.original.last_at ? (
                <time
                    dateTime={row.original.last_at}
                    title={exactTime(row.original.last_at)}
                    className="whitespace-nowrap tabular-nums"
                >
                    {`${clockTime(row.original.last_at)}, ${relativeTime(row.original.last_at)}`}
                </time>
            ) : (
                <span className="text-muted-foreground">–</span>
            ),
    },
];

function ChartsLoading() {
    return <div aria-hidden="true" className="h-96" />;
}

export function OverviewTab({ paused }: { paused: boolean }) {
    const router = useRouter();
    const { search, update } = useListSearch(OVERVIEW_PATH, OVERVIEW_KEYS);
    const range = rangeOf(search.range ?? DEFAULT_RANGE).value;
    const filter: OverviewFilter = useMemo(
        () => ({ model: splitList(search.model), range }),
        [search.model, range],
    );
    const overview = useRequestOverview(filter, paused);
    const summary = useRequestSummary(overviewFilter(filter), paused);
    const facets = useRequestFacets(overviewFilter({ ...filter, model: [] }), paused);
    const slots = useStableSlots(
        (overview.data?.series ?? []).filter((item) => !item.other).map((item) => item.key),
    );
    const series = chartSeries(overview.data, slots);
    const options = facets.data?.models ?? [];
    const known = new Set(options.map((option) => option.value));
    const models = [
        ...options,
        ...filter.model
            .filter((value) => !known.has(value))
            .map((value) => ({ value, label: value, count: 0 })),
    ];
    const data = overview.data;
    const nothing = data !== undefined && data.models.length === 0;
    const empty =
        filter.model.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
                <p className="text-muted-foreground">No requests from these models.</p>
                <Button variant="outline" onClick={() => update({ model: "" })}>
                    Clear filters
                </Button>
            </div>
        ) : summary.data ? (
            <NothingYet summary={summary.data} range={range} />
        ) : (
            <EmptyState title="No requests" />
        );
    return (
        <>
            <div className="flex flex-wrap items-center gap-2">
                <CheckboxSelect
                    label="Model"
                    allLabel="All models"
                    noun="models"
                    options={models}
                    value={filter.model}
                    onValueChange={(next) => update({ model: next.join(",") })}
                />
                {filter.model.length > 0 && (
                    <Button variant="ghost" onClick={() => update({ model: "" })}>
                        Clear filters
                    </Button>
                )}
            </div>
            <SummaryStrip
                summary={summary.data}
                range={range}
                onRange={(next) => update({ range: next === DEFAULT_RANGE ? "" : next })}
            />
            <ErrorLine error={overview.error ?? summary.error} />
            {nothing ? (
                empty
            ) : data ? (
                <Suspense fallback={<ChartsLoading />}>
                    <Charts overview={data} series={series} dimmed={overview.isPlaceholderData} />
                </Suspense>
            ) : null}
            {!nothing && (
                <Section
                    title="Models"
                    caption={`Every model that answered ${rangeOf(range).phrase}. A row opens its requests.`}
                    flush
                >
                    <DataGrid
                        columns={COLUMNS}
                        rows={data?.models ?? []}
                        getRowId={(row) => row.key}
                        loading={overview.isLoading}
                        storageKey="minibrain.overview.columns"
                        initialSort={[{ id: "requests", desc: true }]}
                        onOpen={(row) =>
                            router.history.push(
                                listHref(REQUESTS_PATH, {
                                    model: row.key,
                                    range: range === DEFAULT_RANGE ? undefined : range,
                                }),
                            )
                        }
                        rowLabel={(row) => `${row.label}, ${count(row.requests)} requests`}
                        minWidth="min-w-[860px]"
                    />
                </Section>
            )}
        </>
    );
}
