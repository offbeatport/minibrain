import { useRouter } from "@tanstack/react-router";
import {
    Button,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
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
import { Fragment, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { count } from "~/lib/format";
import { closeTrain, useCan, useOverlays } from "./flowOverlays";
import { Advanced } from "./flowTrainAdvanced";
import {
    ComputePicker,
    DataPicker,
    Headline,
    HeldOutWarning,
    MemoryBar,
    MemoryTrack,
    Meta,
    QualityPicker,
    Row,
    TimeLine,
    ToggleButton,
    computeTitle,
    fitText,
    planDetail,
    versusLive,
} from "./flowTrainParts";
import {
    type ComputeChoice,
    MIN_HELD_OUT,
    type MachinePlan,
    type Plan,
    QUALITIES,
    type Quality,
    type Recipe,
    baseOf,
    busyOf,
    candidates,
    changedFrom,
    dataPicks,
    duration,
    errorsOf,
    liveData,
    longestExample,
    makePlan,
    presetRecipe,
    qualityOf,
} from "./flowTrainPlan";
import {
    FLOW,
    type FlowModel,
    datasetOf,
    jobHref,
    jobOfVersion,
    nextNumber,
    setHeldOut,
    startTraining,
    trainingVersion,
    useFlowState,
} from "./modelsFlowData";

function labelOf(quality: Quality): string {
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

function submitsOnEnter(target: HTMLElement): boolean {
    if (target.getAttribute("role") === "radio") {
        return true;
    }
    return target instanceof HTMLInputElement && target.getAttribute("aria-expanded") !== "true";
}

function Body({ model }: { model: FlowModel }) {
    const router = useRouter();
    const toast = useToast();
    const state = useFlowState();
    const scroller = useRef<HTMLDivElement>(null);
    const picks = dataPicks(model);
    const dataset = datasetOf(model);
    const [picked, setPicked] = useState(picks[0]?.number ?? 0);
    const [basis, setBasis] = useState<Quality>("balanced");
    const [recipe, setRecipe] = useState<Recipe>(presetRecipe("balanced"));
    const [compute, setCompute] = useState<ComputeChoice>("auto");
    const [opened, setOpened] = useState<"data" | "compute" | null>(null);
    const [advanced, setAdvanced] = useState(false);

    useEffect(() => {
        if (advanced) {
            scroller.current
                ?.querySelector("#train-group-adapter")
                ?.scrollIntoView({ block: "nearest" });
        }
    }, [advanced]);

    const base = baseOf(model);
    const pick = picks.find((item) => item.number === picked) ?? picks[0];
    const live = liveData(model);
    const heldOut = model.heldOut;
    const trainRows = Math.max(0, (pick?.rows ?? 0) - heldOut);
    const available = trainRows + model.accepted;
    const longest = longestExample(model);
    const input = {
        base,
        available,
        heldOut,
        longest,
        compute,
        busy: busyOf(state, model.slug),
    };
    const plan = makePlan({ ...input, recipe });
    const quality = qualityOf(recipe);
    const minutes = Object.fromEntries(
        QUALITIES.map((item) => {
            const found = makePlan({ ...input, recipe: presetRecipe(item.id) }).pick;
            return [item.id, found ? found.minutes : null];
        }),
    ) as Record<Quality, number | null>;
    const issues = errorsOf(recipe, base, plan);
    const number = nextNumber(model);
    const running = trainingVersion(model);
    const shown = shownMachine(plan, compute);
    const option = shown ? (shown.chosen ?? shown.smallest) : null;
    const pending = state.feedback.filter(
        (row) => row.model === model.slug && row.state === "pending",
    ).length;
    const ready = Boolean(pick) && issues.length === 0 && plan.pick !== null;

    const change = (patch: Partial<Recipe>) => setRecipe((current) => ({ ...current, ...patch }));
    const choose = (next: Quality) => {
        setBasis(next);
        setRecipe(presetRecipe(next));
    };
    const toggle = (which: "data" | "compute") =>
        setOpened((current) => (current === which ? null : which));

    const start = () => {
        const target = plan.pick;
        if (!ready || !pick || !target?.chosen) {
            return;
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
            {
                device: target.machine.name,
                queued: target.wait > 0,
                minutes: target.minutes,
            },
        );
        const job = jobOfVersion(model.slug, made);
        closeTrain();
        toast({
            title: `Training v${made} of ${model.name}`,
            description:
                target.wait > 0 && target.after
                    ? `Job #${job} queued on ${target.machine.name} after ${target.after}.`
                    : `Job #${job} on ${target.machine.name}.`,
            tone: "success",
        });
        if (job) {
            router.history.push(jobHref(job));
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
        ready && plan.pick && pick
            ? [
                  `Trains v${number} from ${base.name} on ${count(plan.rows)} rows`,
                  qualityName,
                  `≈ ${duration(plan.pick.minutes)} on ${plan.pick.machine.name}`,
                  plan.pick.wait > 0 && plan.pick.after ? `starts after ${plan.pick.after}` : null,
              ].filter((part): part is string => Boolean(part))
            : null;
    const diff = pick ? versusLive(pick.rows, pick.number, live) : null;
    const suggested = pick ? Math.round(pick.rows * 0.1) : 0;

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
                <DialogTitle>{`Train v${number} · ${model.name}`}</DialogTitle>
                <DialogDescription className="tabular-nums">
                    {`Trains from ${base.name}, not from ${running ? `v${running.number}` : "the version before"}. Scored on the same ${count(heldOut)} held-out rows as every version.`}
                </DialogDescription>
            </DialogHeader>
            <div
                ref={scroller}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 sm:px-7"
            >
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
                                <span>
                                    {`${changedFrom(recipe, basis)} of the Advanced settings differ from ${labelOf(basis)}.`}
                                </span>
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
                        {pick && dataset ? (
                            <>
                                <Headline
                                    action={
                                        <ToggleButton
                                            open={opened === "data"}
                                            onToggle={() => toggle("data")}
                                            controls="train-data-picker"
                                            label="training data"
                                        />
                                    }
                                >
                                    {`${dataset.slug} v${pick.number} · ${count(trainRows)} rows`}
                                    {model.accepted > 0 && (
                                        <span className="text-muted-foreground">{` + ${count(model.accepted)} accepted feedback`}</span>
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
                                            href={`${FLOW}/feedback`}
                                            onClick={() => closeTrain()}
                                            className="text-primary hover:underline"
                                        >
                                            {`${pending} feedback rows to review`}
                                        </Link>
                                    )}
                                </Meta>
                                {heldOut < MIN_HELD_OUT && (
                                    <HeldOutWarning
                                        heldOut={heldOut}
                                        suggested={suggested}
                                        next={number}
                                        onFix={() => setHeldOut(model.slug, suggested)}
                                    />
                                )}
                                {opened === "data" && (
                                    <DataPicker
                                        picks={picks}
                                        picked={pick.number}
                                        live={live}
                                        dataset={dataset}
                                        onPick={setPicked}
                                    />
                                )}
                            </>
                        ) : (
                            <Headline>
                                <span className="text-destructive">
                                    Attach a dataset first: training needs examples.
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
                            {computeTitle(compute, plan.pick)}
                            {plan.pick && (
                                <span className="text-muted-foreground">{` · ${fitText(plan.pick)}`}</span>
                            )}
                        </Headline>
                        {shown && option && <MemoryBar option={option} machine={shown.machine} />}
                        {plan.pick ? (
                            <>
                                <TimeLine pick={plan.pick} />
                                <Meta>{`${planDetail(plan.pick)}: the memory planner's choice.`}</Meta>
                            </>
                        ) : (
                            <p className="text-destructive">{plan.error}</p>
                        )}
                        {opened === "compute" && (
                            <ComputePicker plan={plan} choice={compute} onChoice={setCompute} />
                        )}
                    </Row>
                    <Collapsible open={advanced} onOpenChange={setAdvanced}>
                        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1 py-4">
                            <CollapsibleTrigger>Advanced</CollapsibleTrigger>
                            <span className="text-sm text-muted-foreground">
                                {quality
                                    ? `${labelOf(quality)} settings`
                                    : `${changedFrom(recipe, basis)} changed from ${labelOf(basis)}`}
                            </span>
                        </div>
                        <CollapsibleContent className="border-t">
                            <Advanced
                                recipe={recipe}
                                onChange={change}
                                plan={plan}
                                pick={plan.pick}
                                base={base}
                                available={available}
                                longest={longest}
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
                    {shown && option && (
                        <span className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
                            <MemoryTrack
                                option={option}
                                machine={shown.machine}
                                className="h-1.5 w-28 shrink-0"
                            />
                            {shown.chosen ? fitText(shown) : shown.reason}
                        </span>
                    )}
                    <p
                        aria-live="polite"
                        className={`text-sm tabular-nums ${summary ? "text-muted-foreground" : "text-destructive"}`}
                    >
                        {summary
                            ? summary.map((part, index) => (
                                  <Fragment key={part}>
                                      {index > 0 && " · "}
                                      <span className="whitespace-nowrap">{part}</span>
                                  </Fragment>
                              ))
                            : (issues[0]?.text ?? "Pick a data version to train on.")}
                    </p>
                </div>
                <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex">
                    <DialogClose asChild>
                        <Button type="button" variant="outline">
                            Cancel
                        </Button>
                    </DialogClose>
                    <Button type="submit" disabled={!ready}>
                        {`Train v${number}`}
                        <Kbd className="hidden sm:inline-flex">↵</Kbd>
                    </Button>
                </div>
            </div>
        </form>
    );
}

export function TrainDialog() {
    const { train } = useOverlays();
    const state = useFlowState();
    const allowed = useCan("builder");
    const model = train && allowed ? state.models.find((item) => item.slug === train) : undefined;
    return (
        <Dialog open={Boolean(model)} onOpenChange={(open) => !open && closeTrain()}>
            <DialogContent className="flex h-[min(46rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[44rem]">
                {model && <Body model={model} />}
            </DialogContent>
        </Dialog>
    );
}
