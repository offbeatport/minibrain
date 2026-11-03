import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./client";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type SnapshotInfo = Schemas["SnapshotInfo"];
export type ChangeInfo = Schemas["ChangeInfo"];
export type DataSettings = Schemas["DataSettings"];

export const dataKeys = {
    folderRoots: ["data", "folders"] as const,
    snapshots: (slug: string) => ["datasets", slug, "snapshots"] as const,
    settings: ["settings", "data"] as const,
};

export function useFolderRoots() {
    return useQuery({
        queryKey: dataKeys.folderRoots,
        queryFn: () => unwrap(api.GET("/api/data/folders")),
    });
}

export function useSnapshots(slug: string) {
    return useQuery({
        queryKey: dataKeys.snapshots(slug),
        queryFn: () =>
            unwrap(api.GET("/api/datasets/{slug}/snapshots", { params: { path: { slug } } })),
    });
}

export function useDataSettings() {
    return useQuery({
        queryKey: dataKeys.settings,
        queryFn: () => unwrap(api.GET("/api/settings/data")),
    });
}
