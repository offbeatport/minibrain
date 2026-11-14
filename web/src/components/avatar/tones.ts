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

export const TONE_LABELS: Record<ToneName, string> = {
    csv: "Forest green",
    tsv: "Lagoon teal",
    json: "Honey amber",
    jsonl: "Ember orange",
    parquet: "Twilight indigo",
    avro: "Orchid purple",
    iceberg: "Iceberg blue",
    delta: "Moss lime",
    sql: "Berry pink",
    text: "Slate grey",
};

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

function cyrb53(text: string, seed = 0): number {
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

export function toneOf(text: string): ToneName {
    return TONE_KEYS[cyrb53(text) % TONE_KEYS.length];
}
