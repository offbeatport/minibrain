import { useRouter } from "@tanstack/react-router";
import { useToast } from "obp-ui";
import { useState } from "react";
import { closeTrain } from "./flowOverlays";
import {
    type ComputeChoice,
    type DataPick,
    type Issue,
    MIN_HELD_OUT,
    type MachinePlan,
    type Option,
    type Plan,
    QUALITIES,
    type Quality,
    type Recipe,
    baseOf,
    busyOf,
    candidates,
    changedFrom,
    dataPicks,
    errorsOf,
    liveData,
    longestExample,
    makePlan,
    presetRecipe,
    qualityOf,
} from "./flowTrainPlan";
import {
    type FlowModel,
    attachDataset,
    datasetOf,
    jobHref,
    jobOfVersion,
    nextNumber,
    setHeldOut,
    startTraining,
    useFlowState,
} from "./modelsFlowData";

export function labelOf(quality: Quality): string {
    return QUALITIES.find((item) => item.id === quality)?.label ?? quality;
}

function shownMachine(plan: Plan, compute: ComputeChoice): MachinePlan | null {
    if (plan.pick) {
        return plan.pick;
    }
    const allowed = candidates(compute);
    return plan.machines
        .filter((item) => allowed.includes(item.machine) && item.smallest)
        .reduce<MachinePlan | null>((best, item) => {
            const ratio = (item.smallest?.peak ?? 0) / item.machine.memoryGb;
            const bestRatio = best ? (best.smallest?.peak ?? 0) / best.machine.memoryGb : 0;
            return best === null || ratio < bestRatio ? item : best;
        }, null);
}

export function useTrainer(model: FlowModel) {
    const router = useRouter();
    const toast = useToast();
    const state = useFlowState();
    const bound = datasetOf(model);
    const [choice, setChoice] = useState<string | null>(null);
    const dataset = bound ?? state.datasets.find((item) => item.slug === choice);
    const picks: DataPick[] = dataPicks(model, dataset);
    const [picked, setPicked] = useState(picks[0]?.number ?? 0);
    const [basis, setBasis] = useState<Quality>("balanced");
    const [recipe, setRecipe] = useState<Recipe>(presetRecipe("balanced"));
    const [computeChoice, setCompute] = useState<ComputeChoice | null>(null);

    const base = baseOf(model);
    const pick = picks.find((item) => item.number === picked) ?? picks[0] ?? null;
    const live = liveData(model);
    const heldOut = bound ? model.heldOut : (dataset?.split[1] ?? model.heldOut);
    const trainRows = Math.max(0, (pick?.rows ?? 0) - heldOut);
    const available = trainRows + model.accepted;
    const longest = longestExample(dataset?.slug ?? null);
    const busy = busyOf(state, model.slug);
    const best = makePlan({
        base,
        available,
        heldOut,
        longest,
        compute: "auto",
        busy,
        recipe,
    }).pick;
    const compute: ComputeChoice =
        computeChoice ?? (best ? `machine:${best.machine.name}` : "auto");
    const input = { base, available, heldOut, longest, compute, busy };
    const plan = makePlan({ ...input, recipe });
    const quality = qualityOf(recipe);
    const minutes = Object.fromEntries(
        QUALITIES.map((item) => {
            const found = makePlan({ ...input, recipe: presetRecipe(item.id) }).pick;
            return [item.id, found ? found.minutes : null];
        }),
    ) as Record<Quality, number | null>;
    const issues = errorsOf(recipe, base, plan);
    const blocker: Issue | null = pick
        ? (issues[0] ?? null)
        : { field: "data", text: "Pick a dataset", detail: null };
    const number = nextNumber(model);
    const shown = shownMachine(plan, compute);
    const option: Option | null = shown ? (shown.chosen ?? shown.smallest) : null;
    const ready = blocker === null && plan.pick !== null;
    const suggested = pick ? Math.round(pick.rows * 0.1) : 0;
    const pending = state.feedback.filter(
        (row) => row.model === model.slug && row.state === "pending",
    ).length;

    const change = (patch: Partial<Recipe>) => setRecipe((current) => ({ ...current, ...patch }));
    const choose = (next: Quality) => {
        setBasis(next);
        setRecipe(presetRecipe(next));
    };

    const start = () => {
        const target = plan.pick;
        if (!ready || !pick || !dataset || !target?.chosen) {
            return;
        }
        if (!bound) {
            attachDataset(model.slug, dataset.slug);
        }
        const made = startTraining(
            model.slug,
            {
                adapter: target.chosen.strategy,
                rank: recipe.rank,
                epochs: recipe.epochs,
                learningRate: recipe.learningRate,
                rows: Math.max(0, plan.rows - model.accepted),
                batch: target.micro,
            },
            { number: pick.number, rows: pick.rows },
            { device: target.machine.name, queued: target.wait > 0, minutes: target.minutes },
        );
        const job = jobOfVersion(model.slug, made);
        closeTrain();
        const where =
            target.wait > 0 && target.after
                ? `Job #${job} queued on ${target.machine.name} after ${target.after}.`
                : `Job #${job} on ${target.machine.name}.`;
        toast({
            title: `Training v${made} of ${model.name}`,
            description: bound ? where : `Bound to ${dataset.name}. ${where}`,
            tone: "success",
        });
        if (job) {
            router.history.push(jobHref(job));
        }
    };

    return {
        model,
        number,
        base,
        dataset,
        binding: !bound,
        choice,
        setChoice,
        picks,
        pick,
        setPicked,
        live,
        heldOut,
        lowHeldOut: heldOut < MIN_HELD_OUT,
        suggested,
        fixHeldOut: () => setHeldOut(model.slug, suggested),
        trainRows,
        available,
        accepted: model.accepted,
        pending,
        longest,
        recipe,
        change,
        quality,
        basis,
        choose,
        changed: quality ? 0 : changedFrom(recipe, basis),
        reset: () => choose(basis),
        compute,
        setCompute,
        plan,
        minutes,
        issues,
        blocker,
        shown,
        option,
        ready,
        start,
    };
}

export type Trainer = ReturnType<typeof useTrainer>;
