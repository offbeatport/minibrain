import {
    keepPreviousData,
    useInfiniteQuery,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { api, unwrap } from "./client";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type FeedbackInfo = Schemas["FeedbackInfo"];
export type FeedbackDetail = Schemas["FeedbackDetail"];
export type FeedbackSummary = Schemas["FeedbackSummary"];
export type FeedbackStatus = FeedbackInfo["status"];
export type PlaygroundFeedback = Schemas["PlaygroundFeedback"];

export type FeedbackFilter = {
    model?: string[];
    status?: string[];
    assignee?: string[];
    q?: string;
};

const PAGE = 50;
const ROOT = ["feedback"] as const;

export const feedbackKeys = {
    root: ROOT,
    list: (filter: FeedbackFilter) => [...ROOT, "list", filter] as const,
    facets: (filter: FeedbackFilter) => [...ROOT, "facets", filter] as const,
    item: (id: number) => [...ROOT, "item", id] as const,
    summary: (slug: string) => [...ROOT, "summary", slug] as const,
};

function listOrUndefined(values: string[] | undefined): string[] | undefined {
    return values && values.length > 0 ? values : undefined;
}

function serverQuery(filter: FeedbackFilter) {
    return {
        model: listOrUndefined(filter.model),
        status: listOrUndefined(filter.status),
        assignee: listOrUndefined(filter.assignee),
        q: filter.q?.trim() || undefined,
    };
}

export function useFeedbackList(filter: FeedbackFilter) {
    const query = serverQuery(filter);
    const pages = useInfiniteQuery({
        queryKey: feedbackKeys.list(query),
        queryFn: ({ pageParam }) =>
            unwrap(
                api.GET("/api/feedback", {
                    params: { query: { ...query, cursor: pageParam, limit: PAGE } },
                }),
            ),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.next_cursor ?? undefined,
        placeholderData: keepPreviousData,
    });
    return {
        rows: pages.data?.pages.flatMap((page) => page.items) ?? [],
        total: pages.data?.pages[0]?.total,
        isLoading: pages.isLoading,
        error: pages.error,
        hasMore: pages.hasNextPage,
        loadingMore: pages.isFetchingNextPage,
        loadMore: () => {
            if (!pages.isFetchingNextPage) {
                pages.fetchNextPage();
            }
        },
    };
}

export function useFeedbackFacets(filter: FeedbackFilter) {
    const query = serverQuery(filter);
    return useQuery({
        queryKey: feedbackKeys.facets(query),
        queryFn: () => unwrap(api.GET("/api/feedback/facets", { params: { query } })),
        placeholderData: keepPreviousData,
    });
}

export function useFeedbackItem(id: number | null) {
    return useQuery({
        queryKey: feedbackKeys.item(id ?? 0),
        queryFn: () =>
            unwrap(
                api.GET("/api/feedback/{feedback_id}", {
                    params: { path: { feedback_id: id ?? 0 } },
                }),
            ),
        enabled: id !== null,
    });
}

export function useFeedbackSummary(slug: string) {
    return useQuery({
        queryKey: feedbackKeys.summary(slug),
        queryFn: () =>
            unwrap(
                api.GET("/api/minibrains/{slug}/feedback/summary", { params: { path: { slug } } }),
            ),
        enabled: Boolean(slug),
    });
}

export function useRefreshFeedback() {
    const client = useQueryClient();
    return () => client.invalidateQueries({ queryKey: ROOT });
}

export function useReview() {
    const refresh = useRefreshFeedback();
    return useMutation({
        mutationFn: (body: { id: number; decision: "accept" | "reject"; label?: string }) =>
            unwrap(
                api.POST("/api/feedback/{feedback_id}/review", {
                    params: { path: { feedback_id: body.id } },
                    body: { decision: body.decision, label: body.label ?? null },
                }),
            ),
        onSuccess: refresh,
    });
}

export function useAssign() {
    const refresh = useRefreshFeedback();
    return useMutation({
        mutationFn: (body: { id: number; mine: boolean }) =>
            unwrap(
                api.POST("/api/feedback/{feedback_id}/assign", {
                    params: { path: { feedback_id: body.id } },
                    body: { mine: body.mine },
                }),
            ),
        onSuccess: refresh,
    });
}

export function useSendFeedback(slug: string) {
    const refresh = useRefreshFeedback();
    return useMutation({
        mutationFn: (body: PlaygroundFeedback) =>
            unwrap(
                api.POST("/api/minibrains/{slug}/feedback", { params: { path: { slug } }, body }),
            ),
        onSuccess: refresh,
    });
}
