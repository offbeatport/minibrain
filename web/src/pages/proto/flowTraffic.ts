import type { ApiKey, FlowModel } from "./modelsFlowData";

export type UsageRange = "24h" | "7d" | "30d";

export type Pointer = {
    hoursAgo: number;
    version: number;
    canary?: { version: number; share: number };
};

export type Cell = {
    part: string;
    version: number;
    requests: number;
    p50: number;
    p95: number;
    p99: number;
    failed: number;
    cost: number;
    spike: boolean;
};

export type Source = { model: FlowModel; keys: ApiKey[]; caller?: string };

export type Acc = {
    requests: number;
    p50: number;
    p95: number;
    p99: number;
    failed: number;
    cost: number;
};

export type Totals = {
    requests: number;
    p50: number;
    p95: number;
    p99: number;
    errors: number;
    cost: number;
    costPer1k: number;
};

export type ErrorKind = "timeout" | "engine" | "bad-request" | "safety";

export type ErrorSummary = {
    key: ErrorKind;
    label: string;
    status: string;
    count: number;
    minutesAgo: number | null;
    slug: string | null;
    version: number | null;
};

export type Caller = {
    id: string;
    slug: string;
    label: string;
    client: string;
    key: boolean;
};

export type LogEntry = {
    id: string;
    model: FlowModel;
    served: string;
    caller: string;
    question: string;
    minutesAgo: number;
    ms: number;
    kind: ErrorKind | null;
};

export const HOUR_MS = 3600 * 1000;
const DAY = 24;
const WEEK = 7 * DAY;
const HORIZON = 60 * DAY;
export const RANGE_HOURS: Record<UsageRange, number> = { "24h": DAY, "7d": WEEK, "30d": 30 * DAY };
export const BUCKET_HOURS: Record<UsageRange, number> = { "24h": 1, "7d": 6, "30d": DAY };
export const SLO_MS = 800;
const LATENCY_SPIKE = 2.6;
const PLAYGROUND = "playground";

export const ERROR_KINDS: { key: ErrorKind; label: string; status: string }[] = [
    { key: "timeout", label: "Timeout", status: "504" },
    { key: "engine", label: "Engine error", status: "503" },
    { key: "bad-request", label: "Bad request", status: "400" },
    { key: "safety", label: "Safety refusal", status: "Refused" },
];

const SPIKE_MIX: Record<ErrorKind, number> = {
    timeout: 0.72,
    engine: 0.2,
    "bad-request": 0.08,
    safety: 0,
};
const USUAL_MIX: Record<ErrorKind, number> = {
    timeout: 0.18,
    engine: 0.12,
    "bad-request": 0.55,
    safety: 0.15,
};

const CLIENTS = ["helpdesk-router/2.3", "python-httpx/0.27", "n8n/1.64"];
const KEY_SHARES = [0.68, 0.2, 0.06];
const KEY_ERRORS = [0.8, 1.9, 1];
const PLAYGROUND_ERRORS = 0.4;

const HISTORY: Record<string, Pointer[]> = {
    "support-triage": [
        { hoursAgo: 33 * DAY, version: 1 },
        { hoursAgo: 29.5 * DAY, version: 2 },
        { hoursAgo: 25.5 * DAY, version: 3 },
        { hoursAgo: 20.6 * DAY, version: 4 },
    ],
    "invoice-extractor": [
        { hoursAgo: 9 * DAY, version: 1 },
        { hoursAgo: 3.6 * DAY, version: 2 },
        { hoursAgo: 20, version: 2, canary: { version: 3, share: 10 } },
    ],
    "contract-reviewer": [{ hoursAgo: 15 * DAY, version: 1 }],
    guy1: [{ hoursAgo: 3 * DAY, version: 0 }],
};

const HOUR_SHAPE = [
    0.2, 0.15, 0.12, 0.1, 0.12, 0.2, 0.4, 0.7, 1.1, 1.4, 1.5, 1.45, 1.3, 1.4, 1.5, 1.45, 1.3, 1.1,
    0.9, 0.7, 0.55, 0.45, 0.35, 0.25,
];
const SHAPE_TOTAL = HOUR_SHAPE.reduce((sum, value) => sum + value, 0);

function noise(seed: number): number {
    const value = Math.sin(seed * 12.9898) * 43758.5453;
    return value - Math.floor(value);
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

function sameCanary(pointer: Pointer, model: FlowModel): boolean {
    return (
        (pointer.canary?.version ?? null) === (model.canary?.version ?? null) &&
        (pointer.canary?.share ?? null) === (model.canary?.share ?? null)
    );
}

export function pointersOf(model: FlowModel): Pointer[] {
    if (model.kind === "base") {
        return model.deployed ? [{ hoursAgo: 75 * DAY, version: 0 }] : [];
    }
    if (model.live === null) {
        return HISTORY[model.slug] ?? [];
    }
    const live = model.versions.find((version) => version.number === model.live);
    const known = HISTORY[model.slug] ?? [
        { hoursAgo: Math.min(live?.hoursAgo ?? 0, 40 * DAY), version: model.live },
    ];
    const last = known.at(-1);
    if (last && last.version === model.live && sameCanary(last, model)) {
        return known;
    }
    return [
        ...known,
        {
            hoursAgo: 0,
            version: model.live,
            canary: model.canary ? { ...model.canary } : undefined,
        },
    ];
}

export function coveredFor(model: FlowModel, range: UsageRange): boolean {
    const first = pointersOf(model)[0];
    return first !== undefined && first.hoursAgo >= 2 * RANGE_HOURS[range];
}

function activeAt(pointers: Pointer[], hoursAgo: number): Pointer | undefined {
    return [...pointers].reverse().find((pointer) => pointer.hoursAgo > hoursAgo);
}

function dailyTotal(model: FlowModel, dayAgo: number): number {
    if (dayAgo < 7) {
        return model.traffic[6 - dayAgo] ?? 0;
    }
    const mean = sum(model.traffic) / 7;
    const weekday = model.traffic[6 - (dayAgo % 7)] ?? mean;
    return (weekday * 0.6 + mean * 0.4) * (0.82 + noise(dayAgo + 7) * 0.3);
}

type Part = {
    key: string;
    version: number;
    share: number;
    latency: number;
    gpu: number;
    spike: boolean;
};

function drift(version: number): number {
    return 1 + (((version * 37) % 11) - 5) / 60;
}

function partsOf(model: FlowModel, pointer: Pointer): Part[] {
    if (model.kind === "base") {
        const live = model.variants.filter((item) => item.live);
        const total = sum(live.map((item) => sum(item.traffic)));
        return live.map((item) => ({
            key: item.id,
            version: 0,
            share: total > 0 ? sum(item.traffic) / total : 1 / live.length,
            latency: item.p95 ?? model.p95,
            gpu: item.gpuSeconds,
            spike: false,
        }));
    }
    const failing = model.errors > model.usualErrors * 3;
    const shares: [number, number, boolean][] = pointer.canary
        ? [
              [pointer.version, 1 - pointer.canary.share / 100, false],
              [pointer.canary.version, pointer.canary.share / 100, failing],
          ]
        : [[pointer.version, 1, false]];
    return shares.map(([version, share, spike]) => ({
        key: `v${version}`,
        version,
        share,
        latency: model.p95 * drift(version) * (spike ? LATENCY_SPIKE : 1),
        gpu: model.gpuSeconds,
        spike,
    }));
}

type Raw = Cell & { gpu: number; wobble: number };

function scalePrevious(model: FlowModel, hours: Raw[][]) {
    const previous = sum(
        hours.slice(WEEK, 2 * WEEK).flatMap((cells) => cells.map((c) => c.requests)),
    );
    if (previous <= 0) {
        return;
    }
    const factor = model.previous / previous;
    for (const cells of hours.slice(WEEK, 2 * WEEK)) {
        for (const cell of cells) {
            cell.requests *= factor;
        }
    }
}

function calibrateLatency(model: FlowModel, hours: Raw[][]) {
    const week = hours.slice(0, WEEK).flat();
    const requests = sum(week.map((cell) => cell.requests));
    const weighted = sum(week.map((cell) => cell.p95 * cell.requests));
    if (requests <= 0 || weighted <= 0 || model.p95 <= 0) {
        return;
    }
    const factor = (model.p95 * requests) / weighted;
    for (const cell of hours.flat()) {
        cell.p50 *= factor;
        cell.p95 *= factor;
        cell.p99 *= factor;
    }
}

function calibrateErrors(model: FlowModel, hours: Raw[][], fresh: number) {
    const day = hours.slice(0, DAY).flat();
    const requests = sum(day.map((cell) => cell.requests));
    const usual = sum(
        day
            .filter((cell) => cell.version !== fresh)
            .map((cell) => cell.requests * model.usualErrors * cell.wobble),
    );
    const weight = sum(
        day.filter((cell) => cell.version === fresh).map((cell) => cell.requests * cell.wobble),
    );
    const level =
        weight > 0 ? Math.max(0, (model.errors * requests - usual) / weight) : model.errors;
    for (const cell of hours.flat()) {
        cell.failed =
            cell.requests * (cell.version === fresh ? level : model.usualErrors) * cell.wobble;
    }
}

function generate(model: FlowModel): Cell[][] {
    const pointers = pointersOf(model);
    const clockNow = new Date().getHours();
    const hours: Raw[][] = [];
    for (let hour = 0; hour < HORIZON; hour += 1) {
        const pointer = activeAt(pointers, hour);
        if (!pointer) {
            hours.push([]);
            continue;
        }
        const clock = (clockNow - (hour % DAY) + DAY) % DAY;
        const total = (dailyTotal(model, Math.floor(hour / DAY)) * HOUR_SHAPE[clock]) / SHAPE_TOTAL;
        hours.push(
            partsOf(model, pointer).map((part, index) => {
                const seed = hour * 3 + part.version + index * 17;
                const p95 = part.latency * (0.88 + noise(seed) * 0.24);
                return {
                    part: part.key,
                    version: part.version,
                    requests: total * part.share,
                    p50: p95 * (0.4 + noise(seed + 7) * 0.06),
                    p95,
                    p99: p95 * (1.7 + noise(seed + 11) * 0.3),
                    failed: 0,
                    cost: 0,
                    spike: part.spike,
                    gpu: part.gpu,
                    wobble: 0.6 + noise(hour * 5 + part.version) * 0.8,
                };
            }),
        );
    }
    scalePrevious(model, hours);
    calibrateLatency(model, hours);
    const last = pointers.at(-1);
    calibrateErrors(model, hours, last?.canary?.version ?? last?.version ?? 0);
    return hours.map((cells) =>
        cells.map(({ gpu, wobble, ...cell }) => ({
            ...cell,
            cost: model.p95 > 0 ? ((cell.requests / 1000) * gpu * cell.p95) / model.p95 : 0,
        })),
    );
}

const cache = new WeakMap<FlowModel, { hour: number; cells: Cell[][] }>();

export function cellsOf(model: FlowModel): Cell[][] {
    const hour = Math.floor(Date.now() / HOUR_MS);
    const known = cache.get(model);
    if (known && known.hour === hour) {
        return known.cells;
    }
    const cells = generate(model);
    cache.set(model, { hour, cells });
    return cells;
}

export function callersOf(model: FlowModel, keys: ApiKey[]): Caller[] {
    return [
        ...keys.map((key, index) => ({
            id: key.id,
            slug: model.slug,
            label: key.prefix,
            client: CLIENTS[index % CLIENTS.length],
            key: true,
        })),
        {
            id: `${PLAYGROUND}:${model.slug}`,
            slug: model.slug,
            label: "Signed-in users",
            client: "minibrain web",
            key: false,
        },
    ];
}

type Weight = { requests: number; errors: number };

function keyActive(key: ApiKey, hour: number): boolean {
    return key.lastUsed !== null && hour >= Math.floor(key.lastUsed) && hour < key.hoursAgo;
}

function callerWeight(source: Source, hour: number): Weight {
    if (!source.caller) {
        return { requests: 1, errors: 1 };
    }
    const shares = source.keys.map((key, index) =>
        keyActive(key, hour) ? (KEY_SHARES[index] ?? 0.03) : 0,
    );
    const playground = Math.max(0, 1 - sum(shares));
    const factors = source.keys.map((_, index) => KEY_ERRORS[index] ?? 1);
    const norm =
        sum(shares.map((share, index) => share * factors[index])) + playground * PLAYGROUND_ERRORS;
    const position = source.keys.findIndex((key) => key.id === source.caller);
    const share = position >= 0 ? shares[position] : playground;
    const factor = position >= 0 ? factors[position] : PLAYGROUND_ERRORS;
    return { requests: share, errors: norm > 0 ? (share * factor) / norm : 0 };
}

export function emptyAcc(): Acc {
    return { requests: 0, p50: 0, p95: 0, p99: 0, failed: 0, cost: 0 };
}

function add(acc: Acc, cell: Cell, weight: Weight) {
    const requests = cell.requests * weight.requests;
    acc.requests += requests;
    acc.p50 += cell.p50 * requests;
    acc.p95 += cell.p95 * requests;
    acc.p99 += cell.p99 * requests;
    acc.failed += cell.failed * weight.errors;
    acc.cost += cell.cost * weight.requests;
}

export function totalsOf(acc: Acc): Totals {
    const requests = acc.requests;
    return {
        requests: Math.round(requests),
        p50: requests > 0 ? acc.p50 / requests : 0,
        p95: requests > 0 ? acc.p95 / requests : 0,
        p99: requests > 0 ? acc.p99 / requests : 0,
        errors: requests > 0 ? acc.failed / requests : 0,
        cost: acc.cost,
        costPer1k: requests > 0 ? (acc.cost * 1000) / requests : 0,
    };
}

export function eachCell(
    sources: Source[],
    from: number,
    to: number,
    visit: (source: Source, cell: Cell, hour: number, weight: Weight) => void,
) {
    for (const source of sources) {
        const hours = cellsOf(source.model);
        for (let hour = from; hour < Math.min(to, hours.length); hour += 1) {
            const cells = hours[hour];
            if (cells.length === 0) {
                continue;
            }
            const weight = callerWeight(source, hour);
            if (weight.requests <= 0) {
                continue;
            }
            for (const cell of cells) {
                visit(source, cell, hour, weight);
            }
        }
    }
}

export function summaryOf(sources: Source[], range: UsageRange, previous = false): Totals {
    const span = RANGE_HOURS[range];
    const from = previous ? span : 0;
    const acc = emptyAcc();
    eachCell(sources, from, from + span, (_, cell, __, weight) => add(acc, cell, weight));
    return totalsOf(acc);
}

export function groupsOf(
    sources: Source[],
    range: UsageRange,
    keyOf: (source: Source, cell: Cell) => string,
): Map<string, Acc> {
    const groups = new Map<string, Acc>();
    eachCell(sources, 0, RANGE_HOURS[range], (source, cell, _, weight) => {
        const key = keyOf(source, cell);
        const acc = groups.get(key) ?? emptyAcc();
        add(acc, cell, weight);
        groups.set(key, acc);
    });
    return groups;
}

export type Bucket = { step: number; groups: Map<string, Acc> };

export function bucketsOf(
    sources: Source[],
    range: UsageRange,
    keyOf: (source: Source, cell: Cell) => string,
): Bucket[] {
    const size = BUCKET_HOURS[range];
    const count = RANGE_HOURS[range] / size;
    const now = Date.now();
    const buckets: Bucket[] = Array.from({ length: count }, (_, position) => ({
        step: now - (count - 1 - position) * size * HOUR_MS,
        groups: new Map(),
    }));
    eachCell(sources, 0, RANGE_HOURS[range], (source, cell, hour, weight) => {
        const bucket = buckets[count - 1 - Math.floor(hour / size)];
        const key = keyOf(source, cell);
        const acc = bucket.groups.get(key) ?? emptyAcc();
        add(acc, cell, weight);
        bucket.groups.set(key, acc);
    });
    return buckets;
}

function mixOf(model: FlowModel, cell: Cell): Record<ErrorKind, number> {
    if (cell.spike) {
        return SPIKE_MIX;
    }
    if (model.safety) {
        return USUAL_MIX;
    }
    const rest = 1 - USUAL_MIX.safety;
    return {
        timeout: USUAL_MIX.timeout / rest,
        engine: USUAL_MIX.engine / rest,
        "bad-request": USUAL_MIX["bad-request"] / rest,
        safety: 0,
    };
}

export function errorsOf(sources: Source[], range: UsageRange): ErrorSummary[] {
    const each = sources.map((source) => errorsOfSource(source, range));
    return ERROR_KINDS.map((kind, position) => {
        const found = each.map((list) => list[position]);
        const latest = found
            .filter((item) => item.minutesAgo !== null)
            .sort((a, b) => (a.minutesAgo ?? 0) - (b.minutesAgo ?? 0))[0];
        return {
            key: kind.key,
            label: kind.label,
            status: kind.status,
            count: sum(found.map((item) => item.count)),
            minutesAgo: latest?.minutesAgo ?? null,
            slug: latest?.slug ?? null,
            version: latest?.version ?? null,
        };
    });
}

function errorsOfSource(source: Source, range: UsageRange): ErrorSummary[] {
    const sources = [source];
    return ERROR_KINDS.map((kind, position) => {
        const span = RANGE_HOURS[range];
        const amounts = new Array<number>(span).fill(0);
        const leaders = new Map<number, { slug: string; version: number; amount: number }>();
        eachCell(sources, 0, span, (source, cell, hour, weight) => {
            const amount = cell.failed * weight.errors * mixOf(source.model, cell)[kind.key];
            amounts[hour] += amount;
            const leader = leaders.get(hour);
            if (amount > 0 && (!leader || amount > leader.amount)) {
                leaders.set(hour, { slug: source.model.slug, version: cell.version, amount });
            }
        });
        let seen: { hour: number; slug: string; version: number } | null = null;
        let running = 0;
        for (let hour = 0; hour < span && !seen; hour += 1) {
            running += amounts[hour];
            const leader = leaders.get(hour);
            if (running >= 0.5 && leader) {
                seen = { hour, slug: leader.slug, version: leader.version };
            }
        }
        const total = sum(amounts);
        return {
            key: kind.key,
            label: kind.label,
            status: kind.status,
            count: Math.round(total),
            minutesAgo: seen
                ? seen.hour * 60 + 2 + Math.floor(noise(seen.hour + position * 31) * 55)
                : null,
            slug: seen?.slug ?? null,
            version: seen?.version ?? null,
        };
    });
}

function servedBy(model: FlowModel, version: number): string {
    if (model.kind === "base") {
        return model.variants.find((item) => item.live)?.apiName ?? model.slug;
    }
    return `${model.slug}@${version}`;
}

function callerAt(model: FlowModel, keys: ApiKey[], hour: number, seed: number): string {
    const callers = callersOf(model, keys);
    const roll = noise(seed);
    let running = 0;
    for (const caller of callers) {
        running += callerWeight({ model, keys, caller: caller.id }, hour).requests;
        if (roll < running) {
            return caller.id;
        }
    }
    return callers.at(-1)?.id ?? PLAYGROUND;
}

function latencyAt(model: FlowModel, version: number, hour: number, seed: number): number {
    const cell = cellsOf(model)[hour]?.find((item) => item.version === version);
    if (!cell) {
        return Math.round(model.p95 * 0.5);
    }
    return Math.round(cell.p50 * (0.7 + noise(seed) * 1.1));
}

export function logOf(models: FlowModel[], keysOf: (slug: string) => ApiKey[]): LogEntry[] {
    return models
        .filter((model) => model.deployed)
        .flatMap((model) => {
            const keys = keysOf(model.slug);
            const live = model.kind === "base" ? 0 : (model.live ?? 0);
            const answers = model.recent.map((item, index): LogEntry => {
                const hour = Math.floor(item.minutesAgo / 60);
                const version =
                    model.canary && index === 1 && item.minutesAgo < 20 * 60
                        ? model.canary.version
                        : live;
                return {
                    id: `${model.slug}-ok-${index}`,
                    model,
                    served: servedBy(model, version),
                    caller: callerAt(model, keys, hour, index + model.slug.length),
                    question: item.question,
                    minutesAgo: item.minutesAgo,
                    ms: latencyAt(model, version, hour, index + 3),
                    kind: null,
                };
            });
            const failures = errorsOf([{ model, keys }], "30d")
                .filter((item) => item.minutesAgo !== null)
                .map((item, index): LogEntry => {
                    const minutesAgo = item.minutesAgo ?? 0;
                    const version = item.version ?? live;
                    const hour = Math.floor(minutesAgo / 60);
                    const asked = model.recent[(index + 1) % Math.max(1, model.recent.length)];
                    return {
                        id: `${model.slug}-${item.key}`,
                        model,
                        served: servedBy(model, version),
                        caller: callerAt(model, keys, hour, index * 7 + 5),
                        question: asked?.question ?? "–",
                        minutesAgo,
                        ms:
                            item.key === "timeout"
                                ? 30000
                                : item.key === "bad-request"
                                  ? 4 + index
                                  : latencyAt(model, version, hour, index + 9),
                        kind: item.key,
                    };
                });
            return [...answers, ...failures];
        })
        .sort((a, b) => a.minutesAgo - b.minutesAgo);
}

export function callerLabel(models: FlowModel[], keysOf: (slug: string) => ApiKey[], id: string) {
    for (const model of models) {
        const found = callersOf(model, keysOf(model.slug)).find((caller) => caller.id === id);
        if (found) {
            return found.label;
        }
    }
    return id;
}
