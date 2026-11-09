import { useLayoutEffect, useRef } from "react";

export type SampleModel = { name: string; base: string; version: number };

export const MODELS: SampleModel[] = [
    { name: "Support triage", base: "Qwen3 0.6B", version: 4 },
    { name: "Invoice extractor", base: "Gemma 3 1B", version: 2 },
    { name: "guy1", base: "Llama 3.2 1B", version: 1 },
    { name: "Assistant 1", base: "Qwen3 4B", version: 7 },
    { name: "Contract reviewer", base: "Ministral 8B", version: 3 },
    { name: "SQL helper", base: "Phi-4 mini", version: 5 },
];

export const TONE_KEYS = [
    "csv",
    "tsv",
    "json",
    "jsonl",
    "parquet",
    "avro",
    "iceberg",
    "delta",
    "sql",
    "text",
] as const;

export type ToneName = (typeof TONE_KEYS)[number];

export function toneToken(name: ToneName): string {
    return `--file-${name}`;
}

export function slugOf(name: string): string {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

export function cyrb53(text: string, seed = 0): number {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        h1 = Math.imul(h1 ^ code, 2654435761);
        h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function SvgMarkup({ markup }: { markup: string }) {
    const host = useRef<HTMLSpanElement>(null);
    useLayoutEffect(() => {
        const svg = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        host.current?.replaceChildren(svg);
    }, [markup]);
    return <span ref={host} className="flex size-full" />;
}

export function cleanDicebear(svg: string): string {
    return svg.replace(/<!--[\s\S]*?-->/g, "").replace(/<metadata[\s\S]*?<\/metadata>/, "");
}
