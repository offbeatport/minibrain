import { useParams, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import type { ModelRow } from "~/api/client";
import { type ModelTab, modelPageHref } from "~/lib/modelLinks";

export const TAB_LABELS: Record<ModelTab, string> = {
    overview: "Overview",
    versions: "Versions",
    evaluation: "Evaluation",
    monitoring: "Monitoring",
    api: "API keys",
    settings: "Settings",
    files: "Files",
};

const ALIASES: Record<string, ModelTab> = {
    data: "versions",
    training: "versions",
    keys: "api",
};

export function tabsFor(row: ModelRow, builder: boolean): ModelTab[] {
    if (row.kind === "base") {
        return builder
            ? ["overview", "monitoring", "api", "settings"]
            : ["overview", "monitoring", "api"];
    }
    return builder
        ? ["overview", "versions", "evaluation", "monitoring", "api", "settings"]
        : ["overview", "versions", "evaluation", "monitoring", "api"];
}

export function useModelTab(row: ModelRow | undefined, builder: boolean): ModelTab {
    const { tab } = useParams({ strict: false }) as { tab?: string };
    const router = useRouter();
    const tabs = row ? [...tabsFor(row, builder), "files" as const] : [];
    const wanted = tab ? (ALIASES[tab] ?? tab) : "overview";
    const known = tabs.find((item) => item === wanted);
    const key = row?.key;
    const redirect = row !== undefined && tab !== undefined && known !== tab ? known : undefined;
    const unknown = row !== undefined && tab !== undefined && !known;
    useEffect(() => {
        if (key && (unknown || redirect)) {
            const search = window.location.search;
            router.history.replace(`${modelPageHref(key, redirect ?? "overview")}${search}`);
        }
    }, [unknown, redirect, key, router]);
    return known ?? "overview";
}
