import {
    CATALOG,
    DEVICE,
    type Dataset,
    type FlowModel,
    type FlowState,
    TRAIN_MS,
    findVersion,
    liveVersion,
} from "./modelsFlowData";

export const MAX_RANK = 64;
export const MIN_HELD_OUT = 50;
export const EFFECTIVE_BATCH = 16;
export const HEADROOM = 0.85;

const GIB = 1024 ** 3;
const MICRO_BATCHES = [8, 4, 2, 1];
const NF4_BYTES = 0.516;
const LOGIT_BYTES = 12;
const FRAGMENTATION = 1.1;
const OVERHEAD = GIB;
const CHECKPOINT_SPEED = 0.75;
const BATCH_SPEED: Record<number, number> = { 1: 0.55, 2: 0.75, 4: 0.9, 8: 1 };
const SETUP_MINUTES = 2;
const WORK_MINUTES = 6.6e-5;
const EVAL_MINUTES = 4e-4;
const STATIC_TRAIN_MINUTES = 14;

export type Strategy = "LoRA" | "QLoRA";
export type Auto<T> = T | "auto";

const STRATEGY_SPEED: Record<Strategy, number> = { LoRA: 1, QLoRA: 0.7 };

type Shape = {
    hidden: number;
    layers: number;
    vocab: number;
    heads: number;
    kvHeads: number;
    headDim: number;
    intermediate: number;
    tied: boolean;
};

const SHAPES: Record<string, Shape> = {
    "Qwen3 8B": {
        hidden: 4096,
        layers: 36,
        vocab: 151936,
        heads: 32,
        kvHeads: 8,
        headDim: 128,
        intermediate: 12288,
        tied: false,
    },
    "Llama 3.2 1B": {
        hidden: 2048,
        layers: 16,
        vocab: 128256,
        heads: 32,
        kvHeads: 8,
        headDim: 64,
        intermediate: 8192,
        tied: true,
    },
    "Qwen3 0.6B": {
        hidden: 1024,
        layers: 28,
        vocab: 151936,
        heads: 16,
        kvHeads: 8,
        headDim: 128,
        intermediate: 3072,
        tied: true,
    },
};

function guessShape(params: number): Shape {
    const billions = Math.max(params / 1e9, 0.05);
    const width = 40000 * billions ** 0.62;
    const layers = Math.max(12, Math.min(96, Math.round(28 * billions ** 0.18)));
    const hidden = Math.max(512, Math.round(width / layers / 128) * 128);
    const heads = Math.max(1, Math.floor(hidden / 128));
    return {
        hidden,
        layers,
        vocab: 152064,
        heads,
        kvHeads: Math.max(1, Math.floor(heads / 4)),
        headDim: 128,
        intermediate: Math.round(hidden * 3.5),
        tied: false,
    };
}

function denseParams(shape: Shape): number {
    const q = shape.heads * shape.headDim;
    const kv = shape.kvHeads * shape.headDim;
    const attention = 2 * shape.hidden * q + 2 * shape.hidden * kv;
    return (
        embeddingParams(shape) + shape.layers * (attention + 3 * shape.hidden * shape.intermediate)
    );
}

function embeddingParams(shape: Shape): number {
    return shape.vocab * shape.hidden * (shape.tied ? 1 : 2);
}

export type Base = { name: string; params: number; context: number; shape: Shape };

function parseAmount(text: string | undefined, unit: string, scale: number): number | null {
    const match = text?.match(new RegExp(`([\\d.]+)\\s*${unit}`, "i"));
    return match ? Number(match[1]) * scale : null;
}

export function baseOf(model: FlowModel): Base {
    const name = model.base ?? model.name;
    const entry = CATALOG.find((item) => name.startsWith(item.name));
    const known = SHAPES[entry?.name ?? name];
    const listed = parseAmount(entry?.params ?? name, "B", 1e9) ?? 8e9;
    const shape = known ?? guessShape(listed);
    return {
        name,
        params: known ? denseParams(known) : listed,
        context: parseAmount(entry?.context, "K", 1024) ?? 32768,
        shape,
    };
}

export type Machine = {
    name: string;
    pool: string;
    accelerator: string;
    device: "cuda" | "cpu";
    memoryGb: number;
    quantizes: boolean;
    speed: number;
    note?: string;
};

export const MACHINES: Machine[] = [
    {
        name: DEVICE,
        pool: "train",
        accelerator: "NVIDIA A10",
        device: "cuda",
        memoryGb: 24,
        quantizes: true,
        speed: 1,
    },
    {
        name: "gpu-t4-1",
        pool: "train",
        accelerator: "NVIDIA T4",
        device: "cuda",
        memoryGb: 16,
        quantizes: false,
        speed: 0.35,
        note: "no bitsandbytes, so no QLoRA",
    },
    {
        name: "cpu-1",
        pool: "cpu",
        accelerator: "CPU",
        device: "cpu",
        memoryGb: 64,
        quantizes: false,
        speed: 0.05,
        note: "about 20 times slower",
    },
];

export const POOLS = [...new Set(MACHINES.map((machine) => machine.pool))];
export const CLOSED_POOL = { name: "serve", machines: ["gpu-a10-2", "gpu-a10-3"] };

export function memoryLabel(machine: Machine): string {
    return machine.device === "cpu" ? "RAM" : "GPU memory";
}

export type Option = {
    strategy: Strategy;
    checkpointing: boolean;
    micro: number;
    weights: number;
    adapter: number;
    activations: number;
    peak: number;
    usable: number;
    available: number;
    supported: boolean;
    reason: string | null;
    speed: number;
};

export function fits(option: Option): boolean {
    return option.supported && option.peak <= option.usable;
}

function loraParams(shape: Shape, rank: number): number {
    const q = shape.heads * shape.headDim;
    const kv = shape.kvHeads * shape.headDim;
    const perLayer = 7 * shape.hidden + 2 * q + 2 * kv + 3 * shape.intermediate;
    return rank * shape.layers * perLayer;
}

function unsupported(machine: Machine, strategy: Strategy): string | null {
    if (strategy !== "QLoRA" || machine.quantizes) {
        return null;
    }
    return machine.device === "cuda" ? "no QLoRA here" : "QLoRA needs a GPU";
}

function estimate(
    base: Base,
    machine: Machine,
    strategy: Strategy,
    checkpointing: boolean,
    micro: number,
    seq: number,
    rank: number,
): Option {
    const shape = base.shape;
    const element = machine.device === "cuda" ? 2 : 4;
    const q = shape.heads * shape.headDim;
    const kv = shape.kvHeads * shape.headDim;
    const tokens = micro * seq;
    const embeddings = Math.min(embeddingParams(shape), base.params);
    const weights =
        strategy === "LoRA"
            ? base.params * element
            : (base.params - embeddings) * NF4_BYTES + embeddings * 2;
    const states = machine.quantizes ? 2 : strategy === "QLoRA" ? 4 : 8;
    const adapter = loraParams(shape, rank) * ((strategy === "QLoRA" ? 4 : 8) + states);
    const full =
        4 * shape.hidden +
        4 * q +
        3 * kv +
        4 * shape.intermediate +
        Math.floor(1.5 * (5 * shape.hidden + q + shape.intermediate));
    const scores = machine.device === "cuda" ? 0 : shape.heads * seq * element;
    const perLayer = full * element + scores;
    const stored = checkpointing
        ? shape.layers * shape.hidden * element + perLayer
        : shape.layers * perLayer;
    const dequantize =
        strategy === "QLoRA" ? shape.hidden * Math.max(shape.intermediate, q) * 2 : 0;
    const activations =
        (tokens * stored + dequantize) * FRAGMENTATION +
        tokens * shape.vocab * LOGIT_BYTES * FRAGMENTATION +
        OVERHEAD;
    const reason = unsupported(machine, strategy);
    const available = machine.memoryGb * GIB;
    return {
        strategy,
        checkpointing,
        micro,
        weights,
        adapter,
        activations,
        peak: weights + adapter + activations,
        usable: available * HEADROOM,
        available,
        supported: reason === null,
        reason,
        speed:
            machine.speed *
            STRATEGY_SPEED[strategy] *
            (checkpointing ? CHECKPOINT_SPEED : 1) *
            (BATCH_SPEED[micro] ?? 1),
    };
}

export type Recipe = {
    rank: number;
    alpha: number;
    learningRate: number;
    epochs: number;
    maxRows: number | "all";
    microBatch: Auto<number>;
    gradAccum: Auto<number>;
    seqLen: Auto<number>;
    strategy: Auto<Strategy>;
    checkpointing: Auto<boolean>;
    evalEvery: number;
    mix: number;
    seed: number;
};

export type Quality = "fast" | "balanced" | "quality";

export const QUALITIES: { id: Quality; label: string }[] = [
    { id: "fast", label: "Fast" },
    { id: "balanced", label: "Balanced" },
    { id: "quality", label: "Best" },
];

const SHARED: Omit<Recipe, "rank" | "alpha" | "learningRate" | "epochs" | "maxRows"> = {
    microBatch: "auto",
    gradAccum: "auto",
    seqLen: "auto",
    strategy: "auto",
    checkpointing: "auto",
    evalEvery: 100,
    mix: 10,
    seed: 42,
};

const PRESETS: Record<Quality, Recipe> = {
    fast: { ...SHARED, rank: 8, alpha: 16, learningRate: 2e-4, epochs: 1, maxRows: 1000 },
    balanced: { ...SHARED, rank: 16, alpha: 32, learningRate: 2e-4, epochs: 2, maxRows: 3000 },
    quality: {
        ...SHARED,
        rank: 32,
        alpha: 64,
        learningRate: 1e-4,
        epochs: 3,
        maxRows: "all",
        evalEvery: 50,
    },
};

export function presetRecipe(quality: Quality): Recipe {
    return PRESETS[quality];
}

export function qualityOf(recipe: Recipe): Quality | null {
    const keys = Object.keys(recipe) as (keyof Recipe)[];
    const found = QUALITIES.find((item) =>
        keys.every((key) => PRESETS[item.id][key] === recipe[key]),
    );
    return found?.id ?? null;
}

export function changedFrom(recipe: Recipe, quality: Quality): number {
    const preset = PRESETS[quality];
    return (Object.keys(recipe) as (keyof Recipe)[]).filter((key) => preset[key] !== recipe[key])
        .length;
}

export const LEARNING_RATES = [2e-5, 5e-5, 1e-4, 2e-4, 3e-4, 5e-4, 1e-3];
export const MICRO_CHOICES = [1, 2, 4, 8];
export const ACCUM_CHOICES = [1, 2, 4, 8, 16, 32];

const LONGEST: Record<string, number> = {
    "tickets-archive": 1840,
    "support-tickets": 1840,
    "invoices-q3": 3120,
    "supplier-contracts": 2416,
    "finance-questions": 976,
};

export function longestExample(dataset: string | null): number {
    return LONGEST[dataset ?? ""] ?? 1024;
}

export function rowsCut(longest: number, seq: number, rows: number): number {
    if (seq >= longest) {
        return 0;
    }
    const share = ((longest - seq) / longest) ** 1.6;
    return Math.max(1, Math.round(rows * share * 0.4));
}

export type DataPick = {
    number: number;
    rows: number;
    hoursAgo: number;
    usedBy: string[];
};

const DATA_AGES = [0, 2 * 24, 5 * 24];

export function dataPicks(model: FlowModel, source: Dataset | undefined): DataPick[] {
    if (!source) {
        return [];
    }
    return [0, 1, 2]
        .map((back) => ({
            number: source.version - back,
            rows: source.rows - back * 75,
            hoursAgo: (source.atMs ? 0 : source.hoursAgo) + (DATA_AGES[back] ?? 0),
            usedBy: model.versions
                .filter(
                    (version) =>
                        version.kind === "trained" && version.data.number === source.version - back,
                )
                .map((version) => `v${version.number}`),
        }))
        .filter((pick) => pick.number >= 1);
}

export function liveData(model: FlowModel): { number: number; rows: number } | null {
    const live = liveVersion(model);
    return live && live.kind === "trained" ? live.data : null;
}

export type Busy = {
    device: string;
    minutes: number;
    label: string;
};

export function busyOf(state: FlowState, slug: string): Busy[] {
    return state.jobs
        .filter(
            (job) => job.kind === "train" && (job.status === "running" || job.status === "queued"),
        )
        .map((job) => {
            const owner = state.models.find((model) => model.slug === job.model);
            const version = owner && job.version !== null ? findVersion(owner, job.version) : null;
            const left = 1 - (version?.progress ?? job.progress);
            const minutes = job.atMs
                ? (left * TRAIN_MS) / 60000
                : left * (job.minutes ?? STATIC_TRAIN_MINUTES);
            const name = `v${job.version ?? "?"}`;
            return {
                device: job.device ?? DEVICE,
                minutes,
                label: job.model === slug ? name : `${name} of ${owner?.name ?? job.model}`,
            };
        });
}

export type ComputeChoice = "auto" | `pool:${string}` | `machine:${string}`;

export type MachinePlan = {
    machine: Machine;
    chosen: Option | null;
    smallest: Option | null;
    micro: number;
    accum: number;
    steps: number;
    checks: number;
    minutes: number;
    wait: number;
    ahead: number;
    after: string | null;
    reason: string | null;
};

export type Problem = { text: string; detail: string | null };

export type Plan = {
    seq: number;
    rows: number;
    mixed: number;
    machines: MachinePlan[];
    pick: MachinePlan | null;
    error: Problem | null;
};

export type PlanInput = {
    base: Base;
    recipe: Recipe;
    available: number;
    heldOut: number;
    longest: number;
    compute: ComputeChoice;
    busy: Busy[];
};

export function rowsUsed(recipe: Recipe, available: number): number {
    return recipe.maxRows === "all" ? available : Math.min(recipe.maxRows, available);
}

export function resolvedSeq(recipe: Recipe, longest: number, context: number): number {
    return recipe.seqLen === "auto" ? Math.min(longest, context) : recipe.seqLen;
}

function options(base: Base, machine: Machine, recipe: Recipe, seq: number): Option[] {
    const strategies: Strategy[] =
        recipe.strategy === "auto" ? ["LoRA", "QLoRA"] : [recipe.strategy];
    const checkpoints = recipe.checkpointing === "auto" ? [false, true] : [recipe.checkpointing];
    const micros = recipe.microBatch === "auto" ? MICRO_BATCHES : [recipe.microBatch];
    return strategies.flatMap((strategy) =>
        checkpoints.flatMap((checkpointing) =>
            micros.map((micro) =>
                estimate(base, machine, strategy, checkpointing, micro, seq, recipe.rank),
            ),
        ),
    );
}

function fastest(found: Option[]): Option | null {
    return found.reduce<Option | null>(
        (best, option) =>
            best === null ||
            option.speed > best.speed ||
            (option.speed === best.speed && option.peak < best.peak)
                ? option
                : best,
        null,
    );
}

function smallestOf(found: Option[]): Option | null {
    return found.reduce<Option | null>(
        (best, option) => (best === null || option.peak < best.peak ? option : best),
        null,
    );
}

export function gigabytes(bytes: number): string {
    const amount = bytes / GIB;
    return amount >= 10 ? `${Math.round(amount)} GB` : `${amount.toFixed(1)} GB`;
}

function refusal(machine: Machine, smallest: Option | null): string {
    if (!smallest) {
        return unsupported(machine, "QLoRA") ?? "no plan runs there";
    }
    const need = gigabytes(smallest.peak);
    if (smallest.peak <= smallest.available) {
        return `needs ${need}, ${gigabytes(smallest.usable)} usable`;
    }
    return `needs ${need} of ${machine.memoryGb} GB`;
}

function planMachine(input: PlanInput, machine: Machine, seq: number, mixed: number): MachinePlan {
    const { base, recipe } = input;
    const found = options(base, machine, recipe, seq);
    const chosen = fastest(found.filter(fits));
    const smallest = smallestOf(found.filter((option) => option.supported));
    const micro = chosen?.micro ?? smallest?.micro ?? 1;
    const accum =
        recipe.gradAccum === "auto"
            ? Math.max(1, Math.round(EFFECTIVE_BATCH / micro))
            : recipe.gradAccum;
    const steps = Math.max(1, Math.ceil((mixed * recipe.epochs) / (micro * accum)));
    const checks = Math.floor((steps - 1) / recipe.evalEvery) + 1;
    const billions = base.params / 1e9;
    const work = mixed * recipe.epochs * billions * (1 + recipe.rank / 32);
    const speed = chosen?.speed ?? smallest?.speed ?? machine.speed;
    const evalEach = (input.heldOut * billions * EVAL_MINUTES) / machine.speed;
    const queue = input.busy.filter((item) => item.device === machine.name);
    return {
        machine,
        chosen,
        smallest,
        micro,
        accum,
        steps,
        checks,
        minutes: SETUP_MINUTES + (work * WORK_MINUTES) / speed + evalEach * checks,
        wait: queue.reduce((total, item) => total + item.minutes, 0),
        ahead: queue.length,
        after: queue.at(-1)?.label ?? null,
        reason: chosen ? null : refusal(machine, smallest),
    };
}

export function candidates(compute: ComputeChoice): Machine[] {
    if (compute.startsWith("pool:")) {
        return MACHINES.filter((machine) => `pool:${machine.pool}` === compute);
    }
    if (compute.startsWith("machine:")) {
        return MACHINES.filter((machine) => `machine:${machine.name}` === compute);
    }
    return MACHINES;
}

export function makePlan(input: PlanInput): Plan {
    const { base, recipe } = input;
    const seq = resolvedSeq(recipe, input.longest, base.context);
    const rows = rowsUsed(recipe, input.available);
    const mixed = Math.round(rows / (1 - recipe.mix / 100));
    const machines = MACHINES.map((machine) => planMachine(input, machine, seq, mixed));
    const allowed = candidates(input.compute);
    const pick = machines
        .filter((item) => item.chosen && allowed.includes(item.machine))
        .reduce<MachinePlan | null>(
            (best, item) =>
                best === null || item.wait + item.minutes < best.wait + best.minutes ? item : best,
            null,
        );
    return {
        seq,
        rows,
        mixed,
        machines,
        pick,
        error: pick ? null : noFit(input.compute, machines),
    };
}

function noFit(compute: ComputeChoice, machines: MachinePlan[]): Problem {
    const wanted = machines.filter((item) => candidates(compute).includes(item.machine));
    if (wanted.length === 1) {
        return { text: `Doesn't fit ${wanted[0].machine.name}`, detail: wanted[0].reason };
    }
    const closest = wanted.reduce<MachinePlan | null>(
        (best, item) =>
            best === null ||
            (item.smallest?.peak ?? Number.POSITIVE_INFINITY) / item.machine.memoryGb <
                (best.smallest?.peak ?? Number.POSITIVE_INFINITY) / best.machine.memoryGb
                ? item
                : best,
        null,
    );
    return closest
        ? { text: "Nothing fits", detail: `${closest.machine.name} ${closest.reason}` }
        : { text: "No training machines", detail: null };
}

export function duration(minutes: number): string {
    if (minutes < 1) {
        return "under a minute";
    }
    if (minutes < 60) {
        return `${Math.round(minutes)} min`;
    }
    const hours = Math.floor(minutes / 60);
    const rest = Math.round(minutes - hours * 60);
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function computeHours(plan: MachinePlan): string {
    const hours = plan.minutes / 60;
    return hours < 0.1 ? "< 0.1" : hours.toFixed(1);
}

export function hoursUnit(plan: MachinePlan): string {
    return `${plan.machine.device === "cpu" ? "CPU" : "GPU"}-hours`;
}

export function approx(minutes: number): string {
    return minutes < 1 ? "< 1 min" : `~${duration(minutes)}`;
}

export type Issue = {
    field: keyof Recipe | "data" | "compute";
    text: string;
    detail: string | null;
};

export function errorsOf(recipe: Recipe, base: Base, plan: Plan): Issue[] {
    const found: Issue[] = [];
    if (recipe.rank > MAX_RANK) {
        found.push({
            field: "rank",
            text: `Rank ${recipe.rank} · max ${MAX_RANK}`,
            detail: `Serving loads rank ${MAX_RANK} at most`,
        });
    }
    if (recipe.seqLen !== "auto" && recipe.seqLen > base.context) {
        found.push({
            field: "seqLen",
            text: `Max ${base.context.toLocaleString()} tokens`,
            detail: `${base.name} context`,
        });
    }
    if (plan.error) {
        found.push({ field: "compute", ...plan.error });
    }
    return found;
}
