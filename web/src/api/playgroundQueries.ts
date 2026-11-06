import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, succeed, unwrap } from "~/api/client";

export const playgroundKeys = {
    models: ["playground", "models"] as const,
    presets: ["playground", "presets"] as const,
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
