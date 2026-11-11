import type { components } from "~/api/schema";

type Schemas = components["schemas"];

export type PlanInfo = Schemas["TrainingPlanInfo"];
export type OptionInfo = Schemas["TrainingOptionInfo"];
export type MachinePlan = Schemas["MachinePlanInfo"];

export type Auto<T> = T | "auto";
export type Strategy = "lora" | "qlora";

export type Recipe = {
    rank: number;
    alpha: Auto<number>;
    learningRate: number;
    epochs: number;
    maxRows: number | "all";
    microBatch: Auto<number>;
    gradAccum: Auto<number>;
    seqLen: Auto<number>;
    strategy: Auto<Strategy>;
    checkpointing: Auto<boolean>;
    evalEvery: Auto<number>;
    seed: number;
};

export type Quality = "fast" | "balanced" | "quality";

export const QUALITIES: { id: Quality; label: string; blurb: string }[] = [
    { id: "fast", label: "Fast", blurb: "Check whether training helps." },
    { id: "balanced", label: "Balanced", blurb: "The usual run." },
    { id: "quality", label: "Higher quality", blurb: "More capacity and passes." },
];

export const MAX_RANK = 64;
export const MIN_HELD_OUT = 50;
export const HEADROOM = 0.85;
export const LEARNING_RATES = [2e-5, 5e-5, 1e-4, 2e-4, 3e-4, 5e-4, 1e-3];
export const MICRO_CHOICES = [1, 2, 4, 8];
export const ACCUM_CHOICES = [1, 2, 4, 8, 16, 32];

const SHARED: Omit<Recipe, "rank" | "learningRate" | "epochs" | "maxRows"> = {
    alpha: "auto",
    microBatch: "auto",
    gradAccum: "auto",
    seqLen: "auto",
    strategy: "auto",
    checkpointing: "auto",
    evalEvery: "auto",
    seed: 7,
};

const PRESETS: Record<Quality, Recipe> = {
    fast: { ...SHARED, rank: 8, learningRate: 2e-4, epochs: 1, maxRows: 1000 },
    balanced: { ...SHARED, rank: 16, learningRate: 2e-4, epochs: 1, maxRows: 3000 },
    quality: { ...SHARED, rank: 32, learningRate: 1e-4, epochs: 3, maxRows: "all" },
};

export function presetRecipe(quality: Quality): Recipe {
    return PRESETS[quality];
}

export function qualityOf(recipe: Recipe): Quality | null {
    const keys = Object.keys(recipe) as (keyof Recipe)[];
    return (
        QUALITIES.find((item) => keys.every((key) => PRESETS[item.id][key] === recipe[key]))?.id ??
        null
    );
}

export function changedFrom(recipe: Recipe, quality: Quality): number {
    const preset = PRESETS[quality];
    return (Object.keys(recipe) as (keyof Recipe)[]).filter((key) => preset[key] !== recipe[key])
        .length;
}

export function labelOf(quality: Quality): string {
    return QUALITIES.find((item) => item.id === quality)?.label ?? quality;
}

function auto<T>(value: Auto<T>): T | undefined {
    return value === "auto" ? undefined : value;
}

export type PlanQuery = {
    rank: number;
    alpha?: number;
    learning_rate: number;
    epochs: number;
    max_rows: number;
    micro_batch?: number;
    grad_accum?: number;
    seq_len?: number;
    strategy?: Strategy;
    checkpointing?: boolean;
    eval_every?: number;
    seed: number;
    machine?: string;
    dataset_version_id?: number;
};

export function planQuery(
    recipe: Recipe,
    available: number,
    machine: string | null,
    datasetVersion: number | null,
): PlanQuery {
    const query: PlanQuery = {
        rank: recipe.rank,
        alpha: auto(recipe.alpha),
        learning_rate: recipe.learningRate,
        epochs: recipe.epochs,
        max_rows: Math.max(10, recipe.maxRows === "all" ? available : recipe.maxRows),
        micro_batch: auto(recipe.microBatch),
        grad_accum: auto(recipe.gradAccum),
        seq_len: auto(recipe.seqLen),
        strategy: auto(recipe.strategy),
        checkpointing: auto(recipe.checkpointing),
        eval_every: auto(recipe.evalEvery),
        seed: recipe.seed,
        machine: machine ?? undefined,
        dataset_version_id: datasetVersion ?? undefined,
    };
    return Object.fromEntries(
        Object.entries(query).filter(([, value]) => value !== undefined),
    ) as PlanQuery;
}

export type Issue = { field: keyof Recipe | "compute"; text: string };

export function issuesOf(
    recipe: Recipe,
    plan: PlanInfo | undefined,
    error: string | null,
): Issue[] {
    const found: Issue[] = [];
    if (recipe.rank > MAX_RANK) {
        found.push({
            field: "rank",
            text: `Rank ${recipe.rank} is above ${MAX_RANK}, the largest the serving engines load.`,
        });
    }
    if (recipe.seqLen !== "auto" && plan?.context && recipe.seqLen > plan.context) {
        found.push({
            field: "seqLen",
            text: `The base reads at most ${plan.context.toLocaleString()} tokens.`,
        });
    }
    if (error) {
        found.push({ field: "compute", text: error });
    } else if (plan?.level === "insufficient") {
        found.push({ field: "compute", text: plan.basis });
    }
    return found;
}

export function duration(minutes: number | null | undefined): string {
    if (minutes === null || minutes === undefined) {
        return "–";
    }
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

export function deviceHours(minutes: number, kind: string | null | undefined): string {
    const hours = minutes / 60;
    const amount = hours < 0.1 ? "< 0.1" : `≈ ${hours.toFixed(1)}`;
    return `${amount} ${kind === "cpu" ? "CPU" : "GPU"}-hours`;
}

export function gigabytes(bytes: number | null | undefined): string {
    if (bytes === null || bytes === undefined) {
        return "–";
    }
    const amount = bytes / 1024 ** 3;
    return amount >= 10 ? `${Math.round(amount)} GB` : `${amount.toFixed(1)} GB`;
}

export function rateText(value: number): string {
    return value.toExponential(0).replace("e-", "e-");
}

export function strategyName(strategy: string | null | undefined): string {
    return strategy === "qlora" ? "QLoRA" : "LoRA";
}
