import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./client";
import type { components } from "./schema";

type Schemas = components["schemas"];

export type ConnectionInfo = Schemas["ConnectionInfo"];
export type ConnectionBody = Schemas["ConnectionBody"];
export type ConnectionKind = Schemas["ConnectionBody"]["kind"];
export type ExtensionsInfo = Schemas["ExtensionsInfo"];

export const connectionKeys = {
    all: ["connections"] as const,
    extensions: ["extensions"] as const,
    tables: (id: number) => ["connections", id, "tables"] as const,
};

export const KIND_LABELS: Record<ConnectionKind, string> = {
    s3: "S3-compatible",
    postgres: "PostgreSQL",
    mysql: "MySQL",
};

export const EXTENSIONS_FOR: Record<string, string[]> = {
    s3: ["httpfs"],
    database: ["postgres_scanner", "mysql_scanner"],
    iceberg: ["httpfs", "iceberg", "avro"],
    postgres: ["postgres_scanner"],
    mysql: ["mysql_scanner"],
};

export function useConnections() {
    return useQuery({
        queryKey: connectionKeys.all,
        queryFn: () => unwrap(api.GET("/api/connections")),
    });
}

export function useExtensions() {
    return useQuery({
        queryKey: connectionKeys.extensions,
        queryFn: () => unwrap(api.GET("/api/extensions")),
        staleTime: 60_000,
    });
}

export function useConnectionTables(id: number | null) {
    return useQuery({
        queryKey: connectionKeys.tables(id ?? 0),
        queryFn: () =>
            unwrap(
                api.GET("/api/connections/{connection_id}/tables", {
                    params: { path: { connection_id: id ?? 0 } },
                }),
            ),
        enabled: id !== null,
        retry: false,
        staleTime: 30_000,
    });
}

export function missingExtensions(info: ExtensionsInfo | undefined, needed: string[]): string[] {
    if (!info) {
        return [];
    }
    const installed = new Set(
        info.extensions.filter((item) => item.installed).map((item) => item.name),
    );
    return needed.filter((name) => !installed.has(name));
}
