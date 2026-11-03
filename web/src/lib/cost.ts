import type { components } from "~/api/schema";
import { percent } from "~/lib/format";

type FullCost = components["schemas"]["EvalCost"];

export type EvalCost = Pick<FullCost, "device" | "device_seconds_per_1k" | "per_1k" | "currency">;

type Side = { number: number; accuracy?: number | null; cost?: EvalCost | null };

const NONE = "–";
const SAME_BAND = 1.05;
const FRACTION_FROM = 10;

export const CURRENCIES = [
    "USD",
    "EUR",
    "GBP",
    "CHF",
    "JPY",
    "CAD",
    "AUD",
    "SEK",
    "NOK",
    "DKK",
    "INR",
    "CNY",
];

export function deviceKind(device: string | null | undefined): string {
    return device === "cpu" ? "CPU" : "GPU";
}

export function duration(seconds: number): string {
    if (seconds < 60) {
        return `${seconds.toLocaleString(undefined, { maximumSignificantDigits: 3 })} s`;
    }
    if (seconds < 3600) {
        return `${(seconds / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })} min`;
    }
    return `${(seconds / 3600).toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;
}

export function money(amount: number, currency: string): string {
    const digits: Intl.NumberFormatOptions =
        amount < 1 ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 2 };
    return amount.toLocaleString(undefined, { style: "currency", currency, ...digits });
}

export function deviceTime(cost: EvalCost | null | undefined): string {
    return cost ? `${duration(cost.device_seconds_per_1k)} ${deviceKind(cost.device)}` : NONE;
}

export function costText(cost: EvalCost | null | undefined): string {
    if (!cost) {
        return NONE;
    }
    return cost.per_1k !== null && cost.currency
        ? money(cost.per_1k, cost.currency)
        : deviceTime(cost);
}

export function priced(cost: EvalCost | null | undefined): boolean {
    return Boolean(cost && cost.per_1k !== null && cost.currency);
}

export function measuredOn(
    cost: Pick<FullCost, "device_name" | "pool" | "requests" | "batch_size">,
): string {
    const where = cost.pool === "local" ? "this machine" : `pool ${cost.pool}`;
    const rows = cost.requests.toLocaleString();
    return `Measured on ${cost.device_name} (${where}): ${rows} held-out requests in batches of ${cost.batch_size ?? 1}.`;
}

export function costSortValue(cost: EvalCost | null | undefined): number {
    if (!cost) {
        return Number.POSITIVE_INFINITY;
    }
    return cost.per_1k ?? cost.device_seconds_per_1k;
}

function timeNoun(base: EvalCost, mine: EvalCost): string {
    const kinds = new Set([deviceKind(base.device), deviceKind(mine.device)]);
    return kinds.size === 1 ? `${[...kinds][0]} time` : "device time";
}

function relation(base: EvalCost, mine: EvalCost, number: number): string | null {
    const priced = base.per_1k !== null && mine.per_1k !== null;
    const theirs = priced ? base.per_1k : base.device_seconds_per_1k;
    const ours = priced ? mine.per_1k : mine.device_seconds_per_1k;
    if (!theirs || !ours || theirs <= 0 || ours <= 0) {
        return null;
    }
    const noun = `v${number}'s ${priced ? "cost" : timeNoun(base, mine)}`;
    const ratio = theirs / ours;
    if (ratio >= FRACTION_FROM) {
        return `1/${Math.round(ratio)} of ${noun}`;
    }
    if (ratio >= SAME_BAND) {
        return `${Math.round(100 / ratio)}% of ${noun}`;
    }
    if (ratio > 1 / SAME_BAND) {
        return `about ${noun}`;
    }
    return `${(1 / ratio).toLocaleString(undefined, { maximumFractionDigits: 1 })}× ${noun}`;
}

export function headline(base: Side, mine: Side): string | null {
    if (base.accuracy === null || base.accuracy === undefined) {
        return null;
    }
    if (mine.accuracy === null || mine.accuracy === undefined) {
        return null;
    }
    const scores = `v${base.number} ${percent(base.accuracy)} → v${mine.number} ${percent(mine.accuracy)}`;
    const found = base.cost && mine.cost ? relation(base.cost, mine.cost, base.number) : null;
    return found ? `${scores} at ${found}` : scores;
}
