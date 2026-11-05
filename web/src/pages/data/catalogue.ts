import type { DatasetSummary, SourceSummary } from "~/api/client";
import type { DatasetFolder } from "~/api/dataQueries";

export type SourceKind = SourceSummary["kind"];

export type TableFormat = Extract<SourceKind, "iceberg" | "delta">;

export type SourceGroupId = "upload" | "folder" | "s3" | "database" | "lakehouse";

export type GroupId = SourceGroupId | "datasets" | "sources";

export type ItemRef =
    | { kind: "group"; id: GroupId }
    | { kind: "source"; id: number }
    | { kind: "folder"; id: number }
    | { kind: "dataset"; id: string };

export type SourceGroup = { id: SourceGroupId; label: string; noun: string; kinds: SourceKind[] };

export const SOURCE_GROUPS: SourceGroup[] = [
    { id: "upload", label: "Uploads", noun: "file", kinds: ["upload"] },
    { id: "folder", label: "Folders", noun: "folder", kinds: ["folder"] },
    { id: "s3", label: "S3", noun: "bucket", kinds: ["s3"] },
    { id: "database", label: "Databases", noun: "database", kinds: ["database"] },
    { id: "lakehouse", label: "Lakehouse", noun: "table", kinds: ["iceberg", "delta"] },
];

export const TABLE_FORMATS: Record<TableFormat, { label: string; short: string }> = {
    iceberg: { label: "Iceberg", short: "Iceberg" },
    delta: { label: "Delta Lake", short: "Delta" },
};

export function tableFormat(kind: SourceKind): TableFormat | null {
    return kind === "iceberg" || kind === "delta" ? kind : null;
}

export function groupOf(kind: SourceKind): SourceGroup {
    return SOURCE_GROUPS.find((group) => group.kinds.includes(kind)) ?? SOURCE_GROUPS[0];
}

export function inGroup(source: SourceSummary, group: SourceGroup): boolean {
    return group.kinds.includes(source.kind);
}

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
    const group = SOURCE_GROUPS.find(
        (entry) => entry.id === id || entry.kinds.some((member) => member === id),
    );
    return kind === "group" && group ? { kind, id: group.id } : null;
}

function haystack(parts: (string | null | undefined)[]): string {
    return parts.filter(Boolean).join("\n").toLowerCase();
}

export function sourceText(source: SourceSummary): string {
    const format = tableFormat(source.kind);
    return haystack([
        format ? TABLE_FORMATS[format].label : null,
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

export function sameName(first: string, second: string): boolean {
    return first.trim().toLocaleLowerCase() === second.trim().toLocaleLowerCase();
}

const DATA_SUFFIX = /\.(csv|tsv|json|jsonl|ndjson|parquet)$/i;

export function freeName(name: string, taken: string[]): string {
    if (!taken.some((item) => sameName(item, name))) {
        return name;
    }
    const suffix = name.match(DATA_SUFFIX)?.[0] ?? "";
    const ending = suffix.length < name.length ? suffix : "";
    const base = name.slice(0, name.length - ending.length).replace(/ \(\d+\)$/, "");
    for (let number = 2; ; number++) {
        const candidate = `${base} (${number})${ending}`;
        if (!taken.some((item) => sameName(item, candidate))) {
            return candidate;
        }
    }
}

export function siblingNamed(
    index: FolderIndex,
    parentId: number | null,
    name: string,
    except?: number,
): DatasetFolder | undefined {
    return (index.folders.get(parentId) ?? []).find(
        (folder) => folder.id !== except && sameName(folder.name, name),
    );
}

export function datasetsIn(datasets: DatasetSummary[], folderId: number | null): DatasetSummary[] {
    return datasets.filter((dataset) => (dataset.folder_id ?? null) === folderId);
}

export function datasetNamed(
    siblings: DatasetSummary[],
    name: string,
    except?: string,
): DatasetSummary | undefined {
    return siblings.find((dataset) => dataset.slug !== except && sameName(dataset.name, name));
}

export function freeDatasetName(siblings: DatasetSummary[], name: string): string {
    return freeName(
        name,
        siblings.map((dataset) => dataset.name),
    );
}

export function datasetNameProblem(
    siblings: DatasetSummary[],
    name: string,
    except?: string,
): string | null {
    const taken = name.trim() ? datasetNamed(siblings, name, except) : undefined;
    return taken ? `There is already a dataset called ${taken.name} here` : null;
}

export function sourceNamed(
    sources: SourceSummary[],
    name: string,
    except?: number,
): SourceSummary | undefined {
    return sources.find((source) => source.id !== except && sameName(source.name, name));
}

export function sourceNameProblem(
    sources: SourceSummary[],
    name: string,
    except?: number,
): string | null {
    const taken = name.trim() ? sourceNamed(sources, name, except) : undefined;
    return taken ? `There is already a source called ${taken.name}` : null;
}
