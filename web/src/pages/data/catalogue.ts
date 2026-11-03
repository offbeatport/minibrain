import type { DatasetSummary, SourceSummary } from "~/api/client";

export type SourceKind = SourceSummary["kind"];

export type ItemRef =
    | { kind: "group"; id: SourceKind }
    | { kind: "source"; id: number }
    | { kind: "dataset"; id: string };

export const SOURCE_KINDS: { kind: SourceKind; label: string; noun: string }[] = [
    { kind: "upload", label: "Uploads", noun: "file" },
    { kind: "folder", label: "Folders", noun: "folder" },
    { kind: "s3", label: "S3", noun: "bucket" },
    { kind: "database", label: "Databases", noun: "database" },
];

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
    if (kind === "source" && /^\d+$/.test(id)) {
        return { kind, id: Number(id) };
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
    ]);
}

export function stem(filename: string): string {
    const dot = filename.lastIndexOf(".");
    return (dot > 0 ? filename.slice(0, dot) : filename).replaceAll(/[_-]+/g, " ").trim();
}

export function plural(count: number, noun: string): string {
    return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}
