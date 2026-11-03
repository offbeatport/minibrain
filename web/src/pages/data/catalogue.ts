import type { DatasetSummary, SourceSummary } from "~/api/client";
import type { DatasetFolder } from "~/api/dataQueries";

export type SourceKind = SourceSummary["kind"];

export type GroupId = SourceKind | "datasets" | "sources";

export type ItemRef =
    | { kind: "group"; id: GroupId }
    | { kind: "source"; id: number }
    | { kind: "folder"; id: number }
    | { kind: "dataset"; id: string };

export const SOURCE_KINDS: { kind: SourceKind; label: string; noun: string }[] = [
    { kind: "upload", label: "Uploads", noun: "file" },
    { kind: "folder", label: "Folders", noun: "folder" },
    { kind: "s3", label: "S3", noun: "bucket" },
    { kind: "database", label: "Databases", noun: "database" },
    { kind: "iceberg", label: "Iceberg", noun: "table" },
];

export const DATASETS_GROUP: ItemRef = { kind: "group", id: "datasets" };

export const SOURCES_GROUP: ItemRef = { kind: "group", id: "sources" };

export function itemKey(item: ItemRef): string {
    return `${item.kind}:${item.id}`;
}

export function itemHref(item: ItemRef): string {
    return `/data?item=${item.kind}:${encodeURIComponent(String(item.id))}`;
}

export function parseItem(value: unknown): ItemRef | null {
    if (typeof value !== "string") {
        return null;
    }
    const split = value.indexOf(":");
    const kind = value.slice(0, split);
    const id = value.slice(split + 1);
    if (split < 1 || !id) {
        return null;
    }
    if (kind === "dataset") {
        return { kind, id };
    }
    if ((kind === "source" || kind === "folder") && /^\d+$/.test(id)) {
        return { kind, id: Number(id) };
    }
    if (kind === "group" && (id === "datasets" || id === "sources")) {
        return { kind, id };
    }
    const group = SOURCE_KINDS.find((entry) => entry.kind === id);
    return kind === "group" && group ? { kind, id: group.kind } : null;
}

export function kindLabel(kind: SourceKind): string {
    return SOURCE_KINDS.find((entry) => entry.kind === kind)?.label ?? kind;
}

function haystack(parts: (string | null | undefined)[]): string {
    return parts.filter(Boolean).join("\n").toLowerCase();
}

export function sourceText(source: SourceSummary): string {
    return haystack([
        source.name,
        source.filename,
        source.table,
        source.path,
        source.query,
        source.connection,
        source.description,
        ...source.tags,
        ...source.columns.map((column) => column.name),
    ]);
}

export function datasetText(dataset: DatasetSummary): string {
    return haystack([
        dataset.name,
        dataset.slug,
        dataset.description,
        ...dataset.tags,
        dataset.mapping.input_column,
        dataset.mapping.label_column,
        ...dataset.sources.map((source) => source.table),
        ...dataset.columns.map((column) => column.name),
    ]);
}

export function usesSource(dataset: DatasetSummary, sourceId: number): boolean {
    return dataset.sources.some((source) => source.id === sourceId);
}

export function stem(filename: string): string {
    const dot = filename.lastIndexOf(".");
    return (dot > 0 ? filename.slice(0, dot) : filename).replaceAll(/[_-]+/g, " ").trim();
}

export function plural(count: number, noun: string): string {
    return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

export type FolderIndex = {
    byId: Map<number, DatasetFolder>;
    folders: Map<number | null, DatasetFolder[]>;
    datasets: Map<number | null, DatasetSummary[]>;
};

function byName(a: { name: string }, b: { name: string }): number {
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
}

function grouped<T>(items: T[], key: (item: T) => number | null): Map<number | null, T[]> {
    const groups = new Map<number | null, T[]>();
    for (const item of items) {
        const at = key(item);
        groups.set(at, [...(groups.get(at) ?? []), item]);
    }
    return groups;
}

export function folderIndex(folders: DatasetFolder[], datasets: DatasetSummary[]): FolderIndex {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const known = (id: number | null | undefined) => (id != null && byId.has(id) ? id : null);
    return {
        byId,
        folders: grouped([...folders].sort(byName), (folder) => known(folder.parent_id)),
        datasets: grouped([...datasets].sort(byName), (dataset) => known(dataset.folder_id)),
    };
}

export function folderTrail(index: FolderIndex, id: number | null): DatasetFolder[] {
    const trail: DatasetFolder[] = [];
    for (let at = id; at !== null; ) {
        const folder = index.byId.get(at);
        if (!folder || trail.includes(folder)) {
            break;
        }
        trail.unshift(folder);
        at = folder.parent_id;
    }
    return trail;
}

export function folderPath(index: FolderIndex, id: number | null): string {
    return ["Datasets", ...folderTrail(index, id).map((folder) => folder.name)].join(" / ");
}

export function insideFolder(index: FolderIndex, id: number): number[] {
    const below = (index.folders.get(id) ?? []).map((folder) => folder.id);
    return [id, ...below.flatMap((child) => insideFolder(index, child))];
}

export function datasetsInside(index: FolderIndex, id: number | null): DatasetSummary[] {
    const ids = id === null ? [null, ...index.byId.keys()] : insideFolder(index, id);
    return ids.flatMap((at) => index.datasets.get(at) ?? []);
}

export function siblingNamed(
    index: FolderIndex,
    parentId: number | null,
    name: string,
    except?: number,
): DatasetFolder | undefined {
    const wanted = name.trim().toLocaleLowerCase();
    return (index.folders.get(parentId) ?? []).find(
        (folder) => folder.id !== except && folder.name.toLocaleLowerCase() === wanted,
    );
}
