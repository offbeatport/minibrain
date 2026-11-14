import {
    keepPreviousData,
    useMutation,
    useQueries,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useToast } from "obp-ui";
import { useState } from "react";
import { type ModelDetail, type ModelRow, type VersionInfo, api, unwrap } from "~/api/client";
import { type DatasetVersionInfo, useDatasetVersions } from "~/api/dataQueries";
import { keys } from "~/api/queries";
import { errorMessage } from "~/components/Section";
import { jobSeconds } from "~/lib/jobs";
import { type TrainMethod, jobHref, modelVersionHref } from "~/lib/modelLinks";
import { nextVersion } from "../header";
import { AUTO, type PresetTime } from "./parts";
import { poolsOf } from "./pools";
import {
    type Level,
    type PlanInfo,
    type PlanQuery,
    QUALITIES,
    type Quality,
    type Recipe,
    type Start,
    changedFrom,
    issuesOf,
    planQuery,
    presetRecipe,
} from "./recipe";

function fetchPlan(slug: string, query: PlanQuery) {
    return unwrap(
        api.GET("/api/models/{name}/training-plan", { params: { path: { name: slug }, query } }),
    );
}

function planKey(slug: string, query: PlanQuery) {
    return [...keys.model(slug), "training-plan", query] as const;
}

function trainRows(version: DatasetVersionInfo | undefined): number {
    if (!version) {
        return 0;
    }
    return (version.counts.train ?? 0) + (version.feedback_rows ?? 0);
}

export type TrainStart = Start & { data: number | null };

function presetTime(failed: boolean, plan: PlanInfo | undefined): PresetTime {
    if (failed) {
        return null;
    }
    if (!plan) {
        return undefined;
    }
    if (plan.chosen) {
        return plan.minutes ?? null;
    }
    return plan.level === "unknown" ? "unplanned" : null;
}

function scoreSeconds(versions: VersionInfo[], heldOut: number): number | null {
    const timed = versions
        .filter(
            (version) =>
                version.kind === "prompt" &&
                version.job?.kind === "eval" &&
                version.job.finished_at &&
                version.job.status !== "failed",
        )
        .sort((a, b) => b.number - a.number)[0];
    if (!timed?.job) {
        return null;
    }
    const seconds = jobSeconds(timed.job);
    if (seconds < 0) {
        return null;
    }
    const rows = timed.held_out?.examples ?? 0;
    return rows > 0 && heldOut > 0 ? (seconds * heldOut) / rows : seconds;
}

export function useTrainRun({
    row,
    detail,
    versions,
    start,
    blocked,
    method,
    instructions,
    onDone,
}: {
    row: ModelRow;
    detail: ModelDetail;
    versions: VersionInfo[];
    start: TrainStart;
    blocked: string | null;
    method: TrainMethod;
    instructions: string | null;
    onDone: () => void;
}) {
    const training = method === "sft";
    const router = useRouter();
    const toast = useToast();
    const client = useQueryClient();
    const dataVersions = useDatasetVersions(detail.dataset ?? "", Boolean(detail.dataset));
    const saved = (dataVersions.data ?? []).filter((item) => item.saved !== false);
    const [picked, setPicked] = useState<number | null>(start.data);
    const [basis, setBasis] = useState<Quality>(start.basis);
    const [recipe, setRecipe] = useState<Recipe>(start.recipe);
    const [compute, setPool] = useState<string>(AUTO);
    const [custom, setCustom] = useState(start.custom);
    const [open, setOpen] = useState(start.custom);
    const [breaking, setBreaking] = useState<string | null>(null);
    const chosen =
        saved.find((item) => item.id === picked) ?? saved[0] ?? detail.dataset_version ?? undefined;
    const available = trainRows(chosen);
    const pool = compute === AUTO ? null : compute;
    const datasetVersion = chosen?.id ?? null;
    const query = planQuery(recipe, available, pool, datasetVersion);
    const plan = useQuery({
        queryKey: planKey(row.key, query),
        queryFn: () => fetchPlan(row.key, query),
        placeholderData: keepPreviousData,
        retry: false,
        enabled: Boolean(chosen) && !blocked && training,
    });
    const presets = useQueries({
        queries: QUALITIES.map((item) => {
            const presetQuery = planQuery(
                { ...presetRecipe(item.id), machine: recipe.machine },
                available,
                pool,
                datasetVersion,
            );
            return {
                queryKey: planKey(row.key, presetQuery),
                queryFn: () => fetchPlan(row.key, presetQuery),
                retry: false,
                enabled: Boolean(chosen) && !blocked && training,
            };
        }),
    });
    const minutes = Object.fromEntries(
        QUALITIES.map((item, index) => {
            const found = presets[index];
            return [item.id, presetTime(found.isError, found.data)];
        }),
    ) as Record<Quality, PresetTime>;
    const info: PlanInfo | undefined = plan.data;
    const pools = poolsOf(info);
    const poolMachines =
        pool === null
            ? (info?.machines ?? [])
            : (pools.find((item) => item.name === pool)?.machines ?? []);
    const planError = plan.error
        ? (errorMessage(plan.error) ?? "The planner refused these settings.")
        : null;
    const issues = training ? issuesOf(recipe, info, planError) : [];
    const level: Level = custom ? "custom" : basis;
    const changed = changedFrom(recipe, basis);
    const number = nextVersion(row);
    const heldOut = info?.held_out_rows ?? chosen?.counts.eval ?? 0;
    const pickedMachine = info?.machines.find((item) => item.picked) ?? null;
    const option = info?.chosen ?? pickedMachine?.smallest ?? null;
    const ready = training
        ? !blocked &&
          Boolean(chosen) &&
          issues.length === 0 &&
          (Boolean(info?.chosen) || info?.level === "unknown") &&
          !plan.isFetching
        : !blocked;

    const create = useMutation({
        mutationFn: (force: boolean) => {
            const saved = instructions === null ? {} : { instructions };
            const body = training
                ? { kind: "lora" as const, ...query, breaking: force, ...saved }
                : {
                      kind: "prompt" as const,
                      dataset_version_id: datasetVersion ?? undefined,
                      breaking: force,
                      ...saved,
                  };
            return unwrap(
                api.POST("/api/models/{name}/versions", {
                    params: { path: { name: row.key } },
                    body,
                }),
            );
        },
        onSuccess: async (version) => {
            await client.invalidateQueries();
            if (version.kind === "prompt") {
                toast({
                    title:
                        version.status === "evaluating"
                            ? `Scoring v${version.number} of ${row.name}`
                            : `Saved v${version.number} of ${row.name}`,
                    description: instructions === null ? undefined : "With the new instructions.",
                    tone: "success",
                });
                router.history.push(modelVersionHref(row.key, version.number));
                return;
            }
            const job = version.job;
            toast({
                title: `Training v${version.number} of ${row.name}`,
                description: job
                    ? `Job #${job.id}${info?.queue.ahead ? `, ${info.queue.ahead} ahead in the queue` : ""}.`
                    : undefined,
                tone: "success",
            });
            if (job) {
                router.history.push(jobHref(job));
            } else {
                onDone();
            }
        },
        onError: (error, force) => {
            const reason = errorMessage(error) ?? "";
            if (!force && reason.includes("breaking change")) {
                setBreaking(reason);
            }
        },
    });

    const choose = (next: Level) => {
        if (next === "custom") {
            setCustom(true);
            setOpen(true);
            return;
        }
        setCustom(false);
        setBasis(next);
        setRecipe(presetRecipe(next));
    };
    const setCompute = (next: string) => {
        setPool(next);
        const pinned = (info?.machines ?? []).find((item) => item.name === recipe.machine);
        if (next !== AUTO && pinned && pinned.pool !== next) {
            setRecipe((current) => ({ ...current, machine: "auto" }));
        }
    };
    const submit = () => {
        if (ready && !create.isPending) {
            create.mutate(false);
        }
    };
    return {
        saved,
        chosen,
        setPicked,
        available,
        heldOut,
        level,
        basis,
        custom,
        changed,
        choose,
        recipe,
        change: (patch: Partial<Recipe>) => setRecipe((current) => ({ ...current, ...patch })),
        reset: () => setRecipe(presetRecipe(basis)),
        compute,
        setCompute,
        pools,
        poolMachines,
        open,
        setOpen,
        minutes,
        info,
        planning: plan.isFetching,
        issues,
        option,
        pickedMachine,
        number,
        ready,
        training,
        scoreSeconds: scoreSeconds(versions, heldOut),
        submit,
        create,
        failure: create.error && !breaking ? errorMessage(create.error) : null,
        breaking,
        setBreaking,
    };
}

export type TrainRun = ReturnType<typeof useTrainRun>;
