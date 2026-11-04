import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { sinceOf } from "~/lib/requests";
import { api, unwrap } from "./client";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type RequestRow = Schemas["RequestRow"];
export type RequestDetail = Schemas["RequestDetail"];
export type RequestFacets = Schemas["RequestFacets"];
export type RequestSummary = Schemas["RequestSummary"];
export type RequestFeedback = Schemas["RequestFeedback"];
export type RequestOverview = Schemas["RequestOverview"];
export type OverviewModel = Schemas["OverviewModel"];
export type OverviewSeries = Schemas["OverviewSeries"];

export type RequestFilter = {
    model: string[];
    version: string[];
    key: string[];
    status: RequestRow["status_class"][];
    q: string;
    range: string;
};

const PAGE = 50;
const LIVE_PAGE = 200;
const LIVE_MS = 3000;
const STATS_MS = 5000;
const OVERVIEW_MS = 10000;
const ROOT = ["requests"] as const;

function listOrUndefined<T>(values: T[]): T[] | undefined {
    return values.length > 0 ? values : undefined;
}

function serverQuery(filter: RequestFilter) {
    return {
        model: listOrUndefined(filter.model),
        version: listOrUndefined(filter.version),
        key: listOrUndefined(filter.key),
        status: listOrUndefined(filter.status),
        q: filter.q.trim() || undefined,
        range: filter.range,
    };
}

type ServerQuery = ReturnType<typeof serverQuery>;

function withSince({ range, ...query }: ServerQuery) {
    return { ...query, since: sinceOf(range) };
}

function fetchPage(query: ServerQuery, bounds: { cursor?: string; after?: string; limit: number }) {
    return unwrap(
        api.GET("/api/requests", { params: { query: { ...withSince(query), ...bounds } } }),
    );
}

function unique(rows: RequestRow[]): RequestRow[] {
    const seen = new Set<number>();
    return rows.filter((row) => !seen.has(row.id) && seen.add(row.id));
}

export function useRequestList(filter: RequestFilter, paused: boolean) {
    const query = serverQuery(filter);
    const pages = useInfiniteQuery({
        queryKey: [...ROOT, "list", query] as const,
        queryFn: ({ pageParam }) => fetchPage(query, { cursor: pageParam, limit: PAGE }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.next_cursor ?? undefined,
        placeholderData: keepPreviousData,
        refetchOnWindowFocus: false,
    });
    const loaded = unique(pages.data?.pages.flatMap((page) => page.items) ?? []);
    const top = loaded[0]?.id;
    const settled = pages.isSuccess && !pages.isPlaceholderData;
    const live = useQuery({
        queryKey: [...ROOT, "list", query, "after", top ?? 0] as const,
        queryFn: () =>
            fetchPage(query, {
                after: top === undefined ? undefined : String(top),
                limit: LIVE_PAGE,
            }),
        enabled: settled && !paused,
        refetchInterval: paused ? false : LIVE_MS,
        refetchOnWindowFocus: !paused,
    });
    const gap = settled && live.data !== undefined && live.data.next_cursor !== null;
    const { refetch } = pages;
    useEffect(() => {
        if (gap) {
            refetch();
        }
    }, [gap, refetch]);
    const arrivals =
        gap || top === undefined ? [] : (live.data?.items ?? []).filter((row) => row.id > top);
    const fresh = top === undefined && !gap ? (live.data?.items ?? []) : [];
    return {
        rows: unique([...fresh, ...arrivals, ...loaded]),
        total: live.data?.total ?? pages.data?.pages[0]?.total,
        isLoading: pages.isLoading,
        error: pages.error ?? live.error,
        hasMore: pages.hasNextPage,
        loadingMore: pages.isFetchingNextPage,
        loadMore: () => {
            if (!pages.isFetchingNextPage) {
                pages.fetchNextPage();
            }
        },
    };
}

export function useRequestFacets(filter: RequestFilter, paused: boolean) {
    const query = serverQuery(filter);
    return useQuery({
        queryKey: [...ROOT, "facets", query] as const,
        queryFn: () =>
            unwrap(api.GET("/api/requests/facets", { params: { query: withSince(query) } })),
        placeholderData: keepPreviousData,
        refetchInterval: paused ? false : STATS_MS,
    });
}

export function useRequestSummary(filter: RequestFilter, paused: boolean) {
    const query = serverQuery(filter);
    return useQuery({
        queryKey: [...ROOT, "summary", query] as const,
        queryFn: () =>
            unwrap(api.GET("/api/requests/summary", { params: { query: withSince(query) } })),
        placeholderData: keepPreviousData,
        refetchInterval: paused ? false : STATS_MS,
    });
}

export function useRequestDetail(id: number | null) {
    return useQuery({
        queryKey: [...ROOT, "detail", id ?? 0] as const,
        queryFn: () =>
            unwrap(
                api.GET("/api/requests/{request_id}", {
                    params: { path: { request_id: id ?? 0 } },
                }),
            ),
        enabled: id !== null,
    });
}

export type OverviewFilter = { model: string[]; range: string };

export function overviewFilter(filter: OverviewFilter): RequestFilter {
    return { ...filter, version: [], key: [], status: [], q: "" };
}

export function useRequestOverview(filter: OverviewFilter, paused: boolean) {
    const query = { model: listOrUndefined(filter.model), range: filter.range };
    return useQuery({
        queryKey: [...ROOT, "overview", query] as const,
        queryFn: () =>
            unwrap(
                api.GET("/api/requests/overview", {
                    params: { query: { model: query.model, since: sinceOf(query.range) } },
                }),
            ),
        placeholderData: keepPreviousData,
        refetchInterval: paused ? false : OVERVIEW_MS,
        refetchOnWindowFocus: !paused,
    });
}
