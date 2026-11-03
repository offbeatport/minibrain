import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type JobInfo, api, unwrap } from "./client";
import { isActiveJob } from "./queries";

export type JobOrder = "newest" | "oldest";

export type JobFilter = {
    kind?: string[];
    minibrain?: string[];
    status?: string[];
    q?: string;
    since?: string;
    order?: JobOrder;
};

const PAGE = 50;
const LIVE_MS = 2000;
const IDLE_MS = 15000;
const FACETS_LIVE_MS = 5000;
const TYPING_MS = 250;
const SINCE_MS: Record<string, number> = {
    "24h": 24 * 3600 * 1000,
    "7d": 7 * 24 * 3600 * 1000,
    "30d": 30 * 24 * 3600 * 1000,
};

export const SINCE_CHOICES = [
    { value: "24h", label: "Last 24 hours" },
    { value: "7d", label: "Last 7 days" },
    { value: "30d", label: "Last 30 days" },
];

function useDebounced<T>(value: T, delay: number): T {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const timer = window.setTimeout(() => setSettled(value), delay);
        return () => window.clearTimeout(timer);
    }, [value, delay]);
    return settled;
}

function listOrUndefined(values: string[] | undefined): string[] | undefined {
    return values && values.length > 0 ? values : undefined;
}

function sinceTime(token: string | undefined): string | undefined {
    const span = token ? SINCE_MS[token] : undefined;
    return span === undefined ? undefined : new Date(Date.now() - span).toISOString();
}

function serverQuery(filter: JobFilter) {
    return {
        kind: listOrUndefined(filter.kind),
        minibrain: listOrUndefined(filter.minibrain),
        status: listOrUndefined(filter.status),
        q: filter.q?.trim() || undefined,
        since: filter.since && filter.since in SINCE_MS ? filter.since : undefined,
    };
}

type ServerQuery = ReturnType<typeof serverQuery>;

function fetchPage(query: ServerQuery, order: JobOrder, cursor: string | undefined) {
    return unwrap(
        api.GET("/api/jobs", {
            params: {
                query: { ...query, since: sinceTime(query.since), order, cursor, limit: PAGE },
            },
        }),
    );
}

function unique(jobs: JobInfo[]): JobInfo[] {
    const seen = new Set<number>();
    return jobs.filter((job) => !seen.has(job.id) && seen.add(job.id));
}

function arrivals(head: JobInfo[], loaded: JobInfo[], order: JobOrder): JobInfo[] {
    if (order !== "newest") {
        return [];
    }
    const top = loaded[0]?.id ?? Number.NEGATIVE_INFINITY;
    return head.filter((job) => job.id > top);
}

export function useJobList(filter: JobFilter) {
    const q = useDebounced(filter.q ?? "", TYPING_MS);
    const query = serverQuery({ ...filter, q });
    const order = filter.order ?? "newest";
    const pages = useInfiniteQuery({
        queryKey: ["jobs", "list", query, order] as const,
        queryFn: ({ pageParam }) => fetchPage(query, order, pageParam),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.next_cursor ?? undefined,
        placeholderData: keepPreviousData,
        refetchOnWindowFocus: false,
    });
    const loaded = unique(pages.data?.pages.flatMap((page) => page.items) ?? []);
    const active = loaded.filter(isActiveJob).map((job) => job.id);
    const watched = useRef<number[]>(active);
    useEffect(() => {
        watched.current = active;
    });
    const live = useQuery({
        queryKey: ["jobs", "list", query, order, "live"] as const,
        queryFn: async () => {
            const ids = watched.current.slice(0, 200);
            const [head, current] = await Promise.all([
                fetchPage(query, order, undefined),
                ids.length > 0
                    ? unwrap(api.GET("/api/jobs", { params: { query: { id: ids, limit: 200 } } }))
                    : null,
            ]);
            return { head, current: current?.items ?? [] };
        },
        enabled: pages.isSuccess && !pages.isPlaceholderData,
        refetchInterval: (current) =>
            watched.current.length > 0 || current.state.data?.head.items.some(isActiveJob)
                ? LIVE_MS
                : IDLE_MS,
        refetchOnWindowFocus: true,
    });
    const head = live.data?.head;
    const gap =
        head !== undefined &&
        head.next_cursor !== null &&
        order === "newest" &&
        loaded.length > 0 &&
        head.items.every((job) => job.id > (loaded[0]?.id ?? 0));
    const { refetch } = pages;
    useEffect(() => {
        if (gap) {
            refetch();
        }
    }, [gap, refetch]);
    const fresh = new Map<number, JobInfo>();
    for (const job of [...(live.data?.current ?? []), ...(head?.items ?? [])]) {
        fresh.set(job.id, job);
    }
    const rows = gap
        ? loaded
        : [
              ...arrivals(head?.items ?? [], loaded, order),
              ...loaded.map((job) => fresh.get(job.id) ?? job),
          ];
    return {
        rows,
        total: head?.total ?? pages.data?.pages[0]?.total,
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

export function useJobFacets(filter: JobFilter, live: boolean) {
    const q = useDebounced(filter.q ?? "", TYPING_MS);
    const query = serverQuery({ ...filter, q });
    return useQuery({
        queryKey: ["jobs", "facets", query] as const,
        queryFn: () =>
            unwrap(
                api.GET("/api/jobs/facets", {
                    params: { query: { ...query, since: sinceTime(query.since) } },
                }),
            ),
        placeholderData: keepPreviousData,
        refetchInterval: live ? FACETS_LIVE_MS : IDLE_MS,
    });
}
