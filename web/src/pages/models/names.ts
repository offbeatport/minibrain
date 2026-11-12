import type { ModelRow } from "~/api/client";

export function takenNames(rows: ModelRow[]): Set<string> {
    return new Set(rows.map((row) => row.name.trim().toLowerCase()));
}

export function isTaken(name: string, taken: Set<string>): boolean {
    return taken.has(name.trim().toLowerCase());
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
