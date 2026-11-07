import type { ModelRow } from "~/api/client";

export function slugOf(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48)
        .replace(/-+$/, "");
}

export function takenNames(rows: ModelRow[]): Set<string> {
    return new Set(
        rows.flatMap((row) => [
            row.name.trim().toLowerCase(),
            row.key.toLowerCase(),
            slugOf(row.key),
        ]),
    );
}

export function isTaken(name: string, taken: Set<string>): boolean {
    return taken.has(name.trim().toLowerCase()) || taken.has(slugOf(name));
}

export function nextFree(noun: string, taken: Set<string>, numbered = true): string {
    for (let number = 1; number < 10_000; number++) {
        const candidate = number === 1 && !numbered ? noun : `${noun} ${number}`;
        if (!isTaken(candidate, taken)) {
            return candidate;
        }
    }
    return noun;
}
