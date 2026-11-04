import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./client";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type SnapshotInfo = Schemas["SnapshotInfo"];
export type ChangeInfo = Schemas["ChangeInfo"];
export type DataSettings = Schemas["DataSettings"];
export type DatasetFolder = Schemas["DatasetFolderInfo"];

export const dataKeys = {
    folderRoots: ["data", "folders"] as const,
    datasetFolders: ["datasetFolders"] as const,
    snapshots: (slug: string) => ["datasets", slug, "snapshots"] as const,
    settings: ["settings", "data"] as const,
};

export function useFolderRoots() {
    return useQuery({
        queryKey: dataKeys.folderRoots,
        queryFn: () => unwrap(api.GET("/api/data/folders")),
    });
}

export function useDatasetFolders() {
    return useQuery({
        queryKey: dataKeys.datasetFolders,
        queryFn: () => unwrap(api.GET("/api/dataset-folders")),
    });
}

export function useSnapshots(slug: string, enabled = true) {
    return useQuery({
        queryKey: dataKeys.snapshots(slug),
        queryFn: () =>
            unwrap(api.GET("/api/datasets/{slug}/snapshots", { params: { path: { slug } } })),
        enabled: enabled && slug !== "",
    });
}

export function useDataSettings() {
    return useQuery({
        queryKey: dataKeys.settings,
        queryFn: () => unwrap(api.GET("/api/settings/data")),
    });
}
