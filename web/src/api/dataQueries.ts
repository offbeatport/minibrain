import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./client";

export const dataKeys = {
    folderRoots: ["data", "folders"] as const,
};

export function useFolderRoots() {
    return useQuery({
        queryKey: dataKeys.folderRoots,
        queryFn: () => unwrap(api.GET("/api/data/folders")),
    });
}
