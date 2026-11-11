import {
    keepPreviousData,
    useMutation,
    useQueries,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
    Button,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
    ConfirmDialog,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Kbd,
    Link,
    useToast,
} from "obp-ui";
import { Fragment, type KeyboardEvent, useState } from "react";
import { type ModelDetail, type ModelRow, type VersionInfo, api, unwrap } from "~/api/client";
import { type DatasetVersionInfo, useDatasetVersions } from "~/api/dataQueries";
import { useFeedbackSummary } from "~/api/feedbackQueries";
import { keys, useAllModels } from "~/api/queries";
import { errorMessage } from "~/components/Section";
import { count } from "~/lib/format";
import { jobHref } from "~/lib/modelLinks";
import { baseNameOf, isDeployed, nextVersion } from "../header";
import { liveOf } from "../makeLive";
import { Advanced } from "./advanced";
import {
    AUTO,
    ComputePicker,
    DataPicker,
    type DataRef,
    Headline,
    HeldOutWarning,
    MemoryBar,
    MemoryTrack,
    Meta,
    QualityPicker,
    Row,
    TimeLine,
    ToggleButton,
    fitText,
    versusLive,
} from "./parts";
import {
    MIN_HELD_OUT,
    type PlanInfo,
    type PlanQuery,
    QUALITIES,
    type Quality,
    type Recipe,
    changedFrom,
    duration,
    issuesOf,
    labelOf,
    planQuery,
    presetRecipe,
    qualityOf,
    strategyName,
} from "./recipe";

function fetchPlan(slug: string, query: PlanQuery) {
    return unwrap(
        api.GET("/api/models/{slug}/training-plan", { params: { path: { slug }, query } }),
    );
}

function planKey(slug: string, query: PlanQuery) {
    return [...keys.model(slug), "training-plan", query] as const;
}

function submitsOnEnter(target: HTMLElement): boolean {
    if (target.getAttribute("role") === "radio") {
        return true;
    }
    return target instanceof HTMLInputElement && target.getAttribute("aria-expanded") !== "true";
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

function Body({
    row,
    detail,
    versions,
    onClose,
}: {
    row: ModelRow;
    detail: ModelDetail;
    versions: VersionInfo[];
    onClose: () => void;
}) {
    const router = useRouter();
    const toast = useToast();
    const client = useQueryClient();
    const dataVersions = useDatasetVersions(detail.dataset ?? "", Boolean(detail.dataset));
    const feedback = useFeedbackSummary(row.key);
    const models = useAllModels();
    const baseName = baseNameOf(models.data, row.base_model);
    const saved = (dataVersions.data ?? []).filter((item) => item.saved !== false);
    const [picked, setPicked] = useState<number | null>(null);
    const [basis, setBasis] = useState<Quality>("balanced");
    const [recipe, setRecipe] = useState<Recipe>(presetRecipe("balanced"));
    const [compute, setCompute] = useState<string>(AUTO);
    const [opened, setOpened] = useState<"data" | "compute" | null>(null);
    const [advanced, setAdvanced] = useState(false);
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
        enabled: Boolean(chosen),
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
                enabled: Boolean(chosen),
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
    const quality = qualityOf(recipe);
    const number = nextVersion(row);
    const running = versions.find((version) => version.status === "training");
    const heldOut = info?.held_out_rows ?? chosen?.counts.eval ?? 0;
    const option = info?.chosen ?? info?.machines.find((item) => item.picked)?.smallest ?? null;
    const memoryLabel = info?.memory_label ?? "memory";
    const ready =
        Boolean(chosen) && issues.length === 0 && Boolean(info?.chosen) && !plan.isFetching;
    const live = liveData(row, versions);
    const accepted = chosen?.feedback_rows ?? 0;
    const pending = feedback.data?.pending ?? 0;

    const create = useMutation({
        mutationFn: (force: boolean) =>
            unwrap(
                api.POST("/api/models/{slug}/versions", {
                    params: { path: { slug: row.key } },
                    body: { kind: "lora", ...query, breaking: force },
                }),
            ),
        onSuccess: async (version) => {
            await client.invalidateQueries();
            onClose();
            const job = version.job;
            toast({
                title: `Training v${version.number} of ${row.name}`,
                description: job
                    ? `Job #${job}${info?.queue.ahead ? `, ${info.queue.ahead} ahead in the queue` : ""}.`
                    : undefined,
                tone: "success",
            });
            if (job) {
                router.history.push(jobHref(job));
            }
        },
        onError: (error, force) => {
            const reason = errorMessage(error) ?? "";
            if (!force && reason.includes("breaking change")) {
                setBreaking(reason);
            }
        },
    });

    const change = (patch: Partial<Recipe>) => setRecipe((current) => ({ ...current, ...patch }));
    const choose = (next: Quality) => {
        setBasis(next);
        setRecipe(presetRecipe(next));
    };
    const toggle = (which: "data" | "compute") =>
        setOpened((current) => (current === which ? null : which));
    const start = () => {
        if (ready && !create.isPending) {
            create.mutate(false);
        }
    };
    const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
            return;
        }
        if (submitsOnEnter(event.target as HTMLElement)) {
            event.preventDefault();
            start();
        }
    };
    const qualityName = quality ? labelOf(quality) : "Custom";
    const summary =
        ready && info?.chosen
            ? [
                  `Trains v${number} from ${baseName} on ${count(info.rows)} rows`,
                  qualityName,
                  `≈ ${duration(info.minutes)} on ${info.machine}`,
                  info.queue.ahead > 0 ? `${info.queue.ahead} ahead in the queue` : null,
              ].filter((part): part is string => Boolean(part))
            : null;
    const diff = chosen
        ? versusLive({ id: chosen.id, number: chosen.number, rows: chosen.rows }, live)
        : null;
    const failure = create.error && !breaking ? errorMessage(create.error) : null;
    const computeTitle = [
        compute === AUTO ? "Automatic" : null,
        info?.machine,
        info?.chosen ? info.chosen.label : null,
    ]
        .filter(Boolean)
        .join(" · ");

    return (
        <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
                event.preventDefault();
                start();
            }}
            onKeyDown={onKeyDown}
        >
            <DialogHeader className="border-b px-5 pt-6 pb-5 sm:px-7 sm:pt-7">
                <DialogTitle>{`Train v${number} · ${row.name}`}</DialogTitle>
                <DialogDescription className="tabular-nums">
                    {`Trains from ${baseName}, not from ${running ? `v${running.number}` : "the version before"}. Scored on the same ${count(heldOut)} held-out rows as every version.`}
                </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 sm:px-7">
                <div className="divide-y">
                    <Row id="train-method" label="Method">
                        <p className="flex min-h-8 flex-wrap items-center gap-x-3">
                            <span>Supervised fine-tuning (SFT)</span>
                            <span className="text-sm text-muted-foreground">
                                DPO, continued pretraining, RL: coming soon
                            </span>
                        </p>
                    </Row>
                    <Row id="train-quality" label="Training quality">
                        <QualityPicker value={quality} minutes={minutes} onPick={choose} />
                        {!quality && (
                            <Meta className="flex flex-wrap items-center gap-x-2">
                                <span className="text-foreground">Custom</span>
                                <span>{`${changedFrom(recipe, basis)} of the Advanced settings differ from ${labelOf(basis)}.`}</span>
                                <button
                                    type="button"
                                    className="rounded-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                                    onClick={() => choose(basis)}
                                >
                                    {`Reset to ${labelOf(basis)}`}
                                </button>
                            </Meta>
                        )}
                    </Row>
                    <Row id="train-data" label="Training data">
                        {chosen ? (
                            <>
                                <Headline
                                    action={
                                        saved.length > 1 ? (
                                            <ToggleButton
                                                open={opened === "data"}
                                                onToggle={() => toggle("data")}
                                                controls="train-data-picker"
                                                label="training data"
                                            />
                                        ) : undefined
                                    }
                                >
                                    {`${detail.dataset_name ?? detail.dataset ?? "Data"} v${chosen.number ?? "–"} · ${count(chosen.counts.train ?? 0)} rows`}
                                    {accepted > 0 && (
                                        <span className="text-muted-foreground">{` + ${count(accepted)} accepted feedback`}</span>
                                    )}
                                </Headline>
                                <Meta className="flex flex-wrap gap-x-2">
                                    <span>
                                        {[`${count(heldOut)} held out`, diff]
                                            .filter(Boolean)
                                            .join(" · ")}
                                    </span>
                                    {pending > 0 && (
                                        <Link
                                            href={`/feedback?model=${encodeURIComponent(row.key)}`}
                                            onClick={onClose}
                                            className="text-primary hover:underline"
                                        >
                                            {`${count(pending)} feedback rows to review`}
                                        </Link>
                                    )}
                                </Meta>
                                {heldOut < MIN_HELD_OUT && <HeldOutWarning heldOut={heldOut} />}
                                {opened === "data" && (
                                    <DataPicker
                                        versions={saved}
                                        picked={chosen.id}
                                        live={live}
                                        onPick={setPicked}
                                        footer={
                                            <>
                                                {`Saved versions of ${detail.dataset_name ?? detail.dataset}. `}
                                                <Link
                                                    href={`/data?item=${encodeURIComponent(`dataset:${detail.dataset}`)}`}
                                                    onClick={onClose}
                                                    className="text-primary hover:underline"
                                                >
                                                    Open the dataset
                                                </Link>
                                            </>
                                        }
                                    />
                                )}
                            </>
                        ) : (
                            <Headline>
                                <span className="text-destructive">
                                    Add training data first: training needs examples.
                                </span>
                            </Headline>
                        )}
                    </Row>
                    <Row id="train-compute" label="Compute">
                        <Headline
                            action={
                                <ToggleButton
                                    open={opened === "compute"}
                                    onToggle={() => toggle("compute")}
                                    controls="train-compute-picker"
                                    label="compute"
                                />
                            }
                        >
                            {computeTitle || "Automatic"}
                            {info?.chosen && (
                                <span className="text-muted-foreground">{` · ${fitText(info.chosen)}`}</span>
                            )}
                        </Headline>
                        {option && <MemoryBar option={option} memoryLabel={memoryLabel} />}
                        {info?.chosen && info.minutes !== null && info.minutes !== undefined ? (
                            <>
                                <TimeLine
                                    minutes={info.minutes}
                                    kind={info.machines.find((item) => item.picked)?.kind}
                                    ahead={info.queue.ahead}
                                />
                                <Meta>{`${info.chosen.checkpointing ? "Gradient checkpointing" : "No checkpointing"}, batch ${info.chosen.micro_batch} × ${info.grad_accum ?? info.chosen.grad_accum}: the memory planner's choice.`}</Meta>
                            </>
                        ) : info && !info.chosen && info.level === "unknown" ? (
                            <Meta>{info.basis}</Meta>
                        ) : (
                            (planError || info?.level === "insufficient") && (
                                <p className="text-destructive">{planError ?? info?.basis}</p>
                            )
                        )}
                        {opened === "compute" && info && (
                            <ComputePicker
                                machines={info.machines}
                                choice={compute}
                                onChoice={setCompute}
                            />
                        )}
                    </Row>
                    <Collapsible open={advanced} onOpenChange={setAdvanced}>
                        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-4">
                            <CollapsibleTrigger>Advanced</CollapsibleTrigger>
                            <span className="text-sm text-muted-foreground">
                                {quality
                                    ? `${labelOf(quality)} settings${info?.chosen ? ` · ${strategyName(info.chosen.strategy)}` : ""}`
                                    : `${changedFrom(recipe, basis)} changed from ${labelOf(basis)}`}
                            </span>
                        </div>
                        <CollapsibleContent className="border-t">
                            <Advanced
                                recipe={recipe}
                                onChange={change}
                                plan={info}
                                available={available}
                                heldOut={heldOut}
                                issues={issues}
                                next={number}
                            />
                        </CollapsibleContent>
                    </Collapsible>
                </div>
            </div>
            <div className="flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:px-7">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    {option && (
                        <span className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
                            <MemoryTrack
                                option={option}
                                memoryLabel={memoryLabel}
                                className="h-1.5 w-28 shrink-0"
                            />
                            {info?.chosen ? fitText(info.chosen) : "does not fit"}
                        </span>
                    )}
                    <p
                        aria-live="polite"
                        className={`text-sm tabular-nums ${summary ? "text-muted-foreground" : "text-destructive"}`}
                    >
                        {failure ??
                            (summary
                                ? summary.map((part, index) => (
                                      <Fragment key={part}>
                                          {index > 0 && " · "}
                                          <span className="whitespace-nowrap">{part}</span>
                                      </Fragment>
                                  ))
                                : plan.isFetching
                                  ? "Planning…"
                                  : (issues[0]?.text ??
                                    (chosen
                                        ? "Waiting for the planner."
                                        : "Add training data first.")))}
                    </p>
                </div>
                <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex">
                    <DialogClose asChild>
                        <Button type="button" variant="outline">
                            Cancel
                        </Button>
                    </DialogClose>
                    <Button type="submit" disabled={!ready || create.isPending}>
                        {`Train v${number}`}
                        <Kbd className="hidden sm:inline-flex">↵</Kbd>
                    </Button>
                </div>
            </div>
            <ConfirmDialog
                open={breaking !== null}
                onOpenChange={(open) => !open && setBreaking(null)}
                title="This version breaks the contract"
                description={breaking ?? ""}
                confirmLabel="Train it anyway"
                destructive
                onConfirm={() => {
                    setBreaking(null);
                    return create.mutateAsync(true);
                }}
            />
        </form>
    );
}

export function TrainDialog({
    row,
    detail,
    versions,
    open,
    onClose,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    versions: VersionInfo[];
    open: boolean;
    onClose: () => void;
}) {
    return (
        <Dialog open={open && Boolean(detail)} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="flex h-[min(46rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[44rem]">
                {open && detail && (
                    <Body row={row} detail={detail} versions={versions} onClose={onClose} />
                )}
            </DialogContent>
        </Dialog>
    );
}
