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
    ConfirmDialog,
    Dialog,
    DialogClose,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Kbd,
    Link,
    cn,
    useToast,
} from "obp-ui";
import { type KeyboardEvent, useState } from "react";
import { type ModelDetail, type ModelRow, type VersionInfo, api, unwrap } from "~/api/client";
import { type DatasetVersionInfo, useDatasetVersions } from "~/api/dataQueries";
import { useFeedbackSummary } from "~/api/feedbackQueries";
import { keys } from "~/api/queries";
import { errorMessage } from "~/components/Section";
import { count } from "~/lib/format";
import { jobHref } from "~/lib/modelLinks";
import { relativeTime } from "~/lib/time";
import { isDeployed, nextVersion } from "../header";
import { liveOf } from "../makeLive";
import { Advanced } from "./advanced";
import {
    AUTO,
    type DataRef,
    HeldOutWarning,
    MemoryGaugeFooter,
    Meta,
    PickSelect,
    Row,
    fitText,
    timeText,
    versusLive,
} from "./parts";
import {
    type Level,
    MIN_HELD_OUT,
    type PlanInfo,
    type PlanQuery,
    QUALITIES,
    type Quality,
    type Recipe,
    changedFrom,
    deviceHours,
    duration,
    issuesOf,
    labelOf,
    planQuery,
    presetRecipe,
    presetText,
} from "./recipe";

function fetchPlan(slug: string, query: PlanQuery) {
    return unwrap(
        api.GET("/api/models/{name}/training-plan", { params: { path: { name: slug }, query } }),
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
    const saved = (dataVersions.data ?? []).filter((item) => item.saved !== false);
    const [picked, setPicked] = useState<number | null>(null);
    const [basis, setBasis] = useState<Quality>("balanced");
    const [recipe, setRecipe] = useState<Recipe>(presetRecipe("balanced"));
    const [compute, setCompute] = useState<string>(AUTO);
    const [custom, setCustom] = useState(false);
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
    const level: Level = custom ? "custom" : basis;
    const changed = changedFrom(recipe, basis);
    const number = nextVersion(row);
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
                api.POST("/api/models/{name}/versions", {
                    params: { path: { name: row.key } },
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
    const choose = (next: Level) => {
        if (next === "custom") {
            setCustom(true);
            return;
        }
        setCustom(false);
        setBasis(next);
        setRecipe(presetRecipe(next));
    };
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
    const fastest = (info?.machines ?? [])
        .filter((item) => item.chosen)
        .reduce<NonNullable<PlanInfo["machines"]>[number] | null>(
            (best, item) =>
                best === null || (item.minutes ?? 0) < (best.minutes ?? 0) ? item : best,
            null,
        );
    const diff = chosen
        ? versusLive({ id: chosen.id, number: chosen.number, rows: chosen.rows }, live)
        : null;
    const failure = create.error && !breaking ? errorMessage(create.error) : null;
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
                <DialogTitle>{`Train v${number} of ${row.name}`}</DialogTitle>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:grid md:grid-cols-[minmax(0,1fr)_24rem] md:overflow-hidden">
                <div className="min-h-fit px-5 sm:px-7 md:min-h-0 md:overflow-y-auto md:overscroll-contain">
                    <div className="divide-y">
                        <Row id="train-data" label="Data">
                            {chosen ? (
                                <>
                                    <PickSelect
                                        id="train-data-select"
                                        value={String(chosen.id)}
                                        onChange={(next) => setPicked(Number(next))}
                                        options={saved.map((item, index) => ({
                                            value: String(item.id),
                                            label: `${detail.dataset_name ?? detail.dataset ?? "Data"} v${item.number ?? "–"}${index === 0 ? " · latest" : ""}`,
                                            meta: [
                                                `${count(item.counts.train ?? item.rows)} rows`,
                                                relativeTime(item.taken_at ?? item.created_at),
                                            ].join(" · "),
                                        }))}
                                    />
                                    <Meta className="flex flex-wrap gap-x-2">
                                        <span>
                                            {[
                                                `${count(chosen.counts.train ?? 0)} training rows`,
                                                accepted > 0
                                                    ? `+ ${count(accepted)} accepted feedback`
                                                    : null,
                                                `${count(heldOut)} held out`,
                                                diff,
                                            ]
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
                                </>
                            ) : (
                                <p className="min-h-8 text-destructive sm:leading-8">
                                    Add training data first: training needs examples.
                                </p>
                            )}
                        </Row>
                        <Row id="train-method" label="Method">
                            <PickSelect
                                id="train-method-select"
                                value="sft"
                                onChange={() => undefined}
                                options={[{ value: "sft", label: "Supervised fine-tuning (SFT)" }]}
                            />
                        </Row>
                        <Row id="train-quality" label="Training">
                            <PickSelect
                                id="train-quality-select"
                                value={level}
                                onChange={(next) => choose(next as Level)}
                                options={[
                                    ...QUALITIES.map((item) => ({
                                        value: item.id,
                                        label: item.label,
                                        meta: `${presetText(item.id)} · ${timeText(minutes[item.id])}`,
                                    })),
                                    {
                                        value: "custom",
                                        label: "Custom",
                                        meta:
                                            custom && changed > 0
                                                ? `${changed} changed from ${labelOf(basis)}`
                                                : "set each parameter",
                                        separated: true,
                                    },
                                ]}
                            />
                        </Row>
                        <Row id="train-compute" label="Compute">
                            <PickSelect
                                id="train-compute-select"
                                value={compute}
                                onChange={setCompute}
                                options={[
                                    {
                                        value: AUTO,
                                        label: "Automatic",
                                        meta: fastest
                                            ? `fastest that fits · ${fastest.name}`
                                            : "nothing fits",
                                    },
                                    ...(info?.machines ?? []).map((item, index) => ({
                                        value: item.name,
                                        label: `${item.name} · ${item.pool}`,
                                        meta: item.chosen
                                            ? `${fitText(item.chosen)} · ≈ ${duration(item.minutes)}`
                                            : (item.reason ?? "does not fit"),
                                        disabled: !item.chosen,
                                        separated: index === 0,
                                    })),
                                ]}
                            />
                            {(planError || info?.level === "insufficient") && (
                                <p className="text-destructive">{planError ?? info?.basis}</p>
                            )}
                            {info && !info.chosen && info.level === "unknown" && (
                                <Meta>{info.basis}</Meta>
                            )}
                        </Row>
                    </div>
                </div>
                <aside
                    aria-labelledby="train-parameters"
                    className="flex min-h-0 flex-col border-t bg-muted md:border-t-0 md:border-l"
                >
                    <div className="flex min-h-14 items-center justify-between gap-3 border-b px-5 py-3">
                        <h3 id="train-parameters" className="font-medium">
                            Training parameters
                        </h3>
                        {custom ? (
                            changed > 0 && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() => setRecipe(presetRecipe(basis))}
                                >
                                    {`Reset to ${labelOf(basis)}`}
                                </Button>
                            )
                        ) : (
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => choose("custom")}
                            >
                                Customise
                            </Button>
                        )}
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
                        <Advanced
                            disabled={!custom}
                            recipe={recipe}
                            onChange={change}
                            plan={info}
                            available={available}
                            heldOut={heldOut}
                            issues={issues}
                            next={number}
                        />
                    </div>
                </aside>
            </div>
            <div className="flex flex-col gap-4 border-t px-5 py-4 sm:flex-row sm:items-end sm:px-7">
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                    {option ? (
                        <MemoryGaugeFooter option={option} memoryLabel={memoryLabel} />
                    ) : null}
                    <p
                        aria-live="polite"
                        className={cn(
                            "text-sm tabular-nums",
                            failure || (!ready && !plan.isFetching)
                                ? "text-destructive"
                                : "text-muted-foreground",
                        )}
                    >
                        {failure ??
                            (ready &&
                            info?.chosen &&
                            info.minutes !== null &&
                            info.minutes !== undefined
                                ? [
                                      `≈ ${duration(info.minutes)} on ${info.machine}`,
                                      deviceHours(
                                          info.minutes,
                                          info.machines.find((item) => item.picked)?.kind,
                                      ),
                                      info.queue.ahead > 0
                                          ? `${info.queue.ahead} ahead in the queue`
                                          : "starts now",
                                  ].join(" · ")
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
            <DialogContent className="flex h-[min(46rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[70rem]">
                {open && detail && (
                    <Body row={row} detail={detail} versions={versions} onClose={onClose} />
                )}
            </DialogContent>
        </Dialog>
    );
}
