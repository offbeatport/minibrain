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
import { useFeedbackSummary } from "~/api/feedbackQueries";
import { keys } from "~/api/queries";
import { errorMessage } from "~/components/Section";
import { jobHref } from "~/lib/modelLinks";
import { isDeployed, nextVersion } from "../header";
import { liveOf } from "../makeLive";
import { AUTO, type DataRef, versusLive } from "./parts";
import {
    type Level,
    type MachinePlan,
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

function liveData(row: ModelRow, versions: VersionInfo[]): DataRef | null {
    const live = isDeployed(row) ? liveOf(versions) : undefined;
    if (!live || live.kind !== "lora" || !live.dataset_version_id) {
        return null;
    }
    return {
        id: live.dataset_version_id,
        number: live.dataset_version_number,
        rows: live.dataset_version_rows ?? 0,
    };
}

function fastestOf(plan: PlanInfo | undefined): MachinePlan | null {
    return (plan?.machines ?? [])
        .filter((item) => item.chosen)
        .reduce<MachinePlan | null>(
            (best, item) =>
                best === null || (item.minutes ?? 0) < (best.minutes ?? 0) ? item : best,
            null,
        );
}

export type TrainStart = Start & { data: number | null };

export function useTrainRun({
    row,
    detail,
    versions,
    start,
    blocked,
    onDone,
}: {
    row: ModelRow;
    detail: ModelDetail;
    versions: VersionInfo[];
    start: TrainStart;
    blocked: string | null;
    onDone: () => void;
}) {
    const router = useRouter();
    const toast = useToast();
    const client = useQueryClient();
    const dataVersions = useDatasetVersions(detail.dataset ?? "", Boolean(detail.dataset));
    const feedback = useFeedbackSummary(row.key);
    const saved = (dataVersions.data ?? []).filter((item) => item.saved !== false);
    const [picked, setPicked] = useState<number | null>(start.data);
    const [basis, setBasis] = useState<Quality>(start.basis);
    const [recipe, setRecipe] = useState<Recipe>(start.recipe);
    const [compute, setCompute] = useState<string>(AUTO);
    const [custom, setCustom] = useState(start.custom);
    const [breaking, setBreaking] = useState<string | null>(null);
    const chosen =
        saved.find((item) => item.id === picked) ?? saved[0] ?? detail.dataset_version ?? undefined;
    const available = trainRows(chosen);
    const machine = compute === AUTO ? null : compute;
    const datasetVersion = chosen?.id ?? null;
    const query = planQuery(recipe, available, machine, datasetVersion);
    const plan = useQuery({
        queryKey: planKey(row.key, query),
        queryFn: () => fetchPlan(row.key, query),
        placeholderData: keepPreviousData,
        retry: false,
        enabled: Boolean(chosen) && !blocked,
    });
    const presets = useQueries({
        queries: QUALITIES.map((item) => {
            const presetQuery = planQuery(
                presetRecipe(item.id),
                available,
                machine,
                datasetVersion,
            );
            return {
                queryKey: planKey(row.key, presetQuery),
                queryFn: () => fetchPlan(row.key, presetQuery),
                retry: false,
                enabled: Boolean(chosen) && !blocked,
            };
        }),
    });
    const minutes = Object.fromEntries(
        QUALITIES.map((item, index) => {
            const found = presets[index];
            const value = found.isError
                ? null
                : found.data
                  ? found.data.chosen
                      ? (found.data.minutes ?? null)
                      : null
                  : undefined;
            return [item.id, value];
        }),
    ) as Record<Quality, number | null | undefined>;
    const info: PlanInfo | undefined = plan.data;
    const planError = plan.error
        ? (errorMessage(plan.error) ?? "The planner refused these settings.")
        : null;
    const issues = issuesOf(recipe, info, planError);
    const level: Level = custom ? "custom" : basis;
    const changed = changedFrom(recipe, basis);
    const number = nextVersion(row);
    const heldOut = info?.held_out_rows ?? chosen?.counts.eval ?? 0;
    const pickedMachine = info?.machines.find((item) => item.picked) ?? null;
    const option = info?.chosen ?? pickedMachine?.smallest ?? null;
    const ready =
        !blocked &&
        Boolean(chosen) &&
        issues.length === 0 &&
        Boolean(info?.chosen) &&
        !plan.isFetching;
    const live = liveData(row, versions);
    const diff = chosen
        ? versusLive({ id: chosen.id, number: chosen.number, rows: chosen.rows }, live)
        : null;

    const create = useMutation({
        mutationFn: (force: boolean) =>
            unwrap(
                api.POST("/api/models/{name}/versions", {
                    params: { path: { name: row.key } },
                    body: { kind: "lora", ...query, breaking: force },
                }),
            ),
        onSuccess: async (version) => {
            await client.invalidateQueries();
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
            return;
        }
        setCustom(false);
        setBasis(next);
        setRecipe(presetRecipe(next));
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
        accepted: chosen?.feedback_rows ?? 0,
        pending: feedback.data?.pending ?? 0,
        diff,
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
        minutes,
        info,
        planning: plan.isFetching,
        issues,
        option,
        pickedMachine,
        fastest: fastestOf(info),
        number,
        ready,
        submit,
        create,
        failure: create.error && !breaking ? errorMessage(create.error) : null,
        breaking,
        setBreaking,
    };
}

export type TrainRun = ReturnType<typeof useTrainRun>;
