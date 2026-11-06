import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, succeed, unwrap } from "~/api/client";
import type { ChatState } from "~/lib/playground";

export const playgroundKeys = {
    models: ["playground", "models"] as const,
    presets: ["playground", "presets"] as const,
    chats: ["playground", "chats"] as const,
    chat: (id: number) => ["playground", "chats", id] as const,
};

export function usePlaygroundModels() {
    return useQuery({
        queryKey: playgroundKeys.models,
        queryFn: () => unwrap(api.GET("/api/playground/models")),
    });
}

export function usePresets() {
    return useQuery({
        queryKey: playgroundKeys.presets,
        queryFn: () => unwrap(api.GET("/api/playground/presets")),
    });
}

type PresetChange = {
    id?: number;
    name?: string;
    settings?: Record<string, unknown>;
    is_default?: boolean;
};

export function useSavePreset() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: ({ id, name, settings, is_default }: PresetChange) =>
            id === undefined
                ? unwrap(
                      api.POST("/api/playground/presets", {
                          body: {
                              name: name ?? "",
                              settings: settings ?? {},
                              is_default: is_default ?? false,
                          },
                      }),
                  )
                : unwrap(
                      api.PUT("/api/playground/presets/{preset_id}", {
                          params: { path: { preset_id: id } },
                          body: { name, settings, is_default },
                      }),
                  ),
        onSuccess: () => client.invalidateQueries({ queryKey: playgroundKeys.presets }),
    });
}

export function useDeletePreset() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (id: number) =>
            succeed(
                api.DELETE("/api/playground/presets/{preset_id}", {
                    params: { path: { preset_id: id } },
                }),
            ),
        onSuccess: () => client.invalidateQueries({ queryKey: playgroundKeys.presets }),
    });
}

export function useChats() {
    return useQuery({
        queryKey: playgroundKeys.chats,
        queryFn: () => unwrap(api.GET("/api/playground/sessions")),
    });
}

export function useOpenChat() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (id: number) =>
            client.fetchQuery({
                queryKey: playgroundKeys.chat(id),
                queryFn: () =>
                    unwrap(
                        api.GET("/api/playground/sessions/{chat_id}", {
                            params: { path: { chat_id: id } },
                        }),
                    ),
                staleTime: 0,
            }),
    });
}

type ChatChange = {
    id: number | null;
    model?: string;
    version?: number | null;
    title?: string;
    state?: ChatState;
};

export function useSaveChat() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: ({ id, model, version, title, state }: ChatChange) =>
            id === null
                ? unwrap(
                      api.POST("/api/playground/sessions", {
                          body: {
                              model: model ?? "",
                              version: version ?? null,
                              state: state ?? {},
                          },
                      }),
                  )
                : unwrap(
                      api.PUT("/api/playground/sessions/{chat_id}", {
                          params: { path: { chat_id: id } },
                          body: { model, version, title, state },
                      }),
                  ),
        onSuccess: () => client.invalidateQueries({ queryKey: playgroundKeys.chats, exact: true }),
    });
}

export function useDeleteChat() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (id: number) =>
            succeed(
                api.DELETE("/api/playground/sessions/{chat_id}", {
                    params: { path: { chat_id: id } },
                }),
            ),
        onSuccess: () => client.invalidateQueries({ queryKey: playgroundKeys.chats, exact: true }),
    });
}
