export function percent(value: number | null | undefined): string {
    return value === null || value === undefined ? "–" : `${(value * 100).toFixed(1)}%`;
}

export function milliseconds(value: number | null | undefined): string {
    return value === null || value === undefined ? "–" : `${Math.round(value)} ms`;
}

export function count(value: number | null | undefined): string {
    return value === null || value === undefined ? "–" : Math.round(value).toLocaleString();
}

export function dateTime(value: string | null | undefined): string {
    return value ? new Date(value).toLocaleString() : "–";
}

export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
