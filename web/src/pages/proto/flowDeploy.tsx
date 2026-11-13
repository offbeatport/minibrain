import { useRouter } from "@tanstack/react-router";
import {
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogTitle,
    Field,
    NumberField,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    cn,
    useToast,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import {
    type PoolFit,
    type Serve,
    type Slot,
    USE_LABELS,
    automaticPool,
    deployedPlacements,
    liveReplicas,
    loadSeconds,
    placementOf,
    poolFits,
    round,
    serveOf,
    slotName,
    useCompute,
    useNow,
} from "./flowCompute";
import { startDeploy, startVersionDeploy } from "./flowRollout";
import { Stat } from "./flowTrainParts";
import {
    DEFAULT_CONTEXT,
    type FlowModel,
    type FlowVersion,
    LONG_CONTEXT,
    findVersion,
    jobHref,
    liveVersion,
    newestFirst,
    pct,
    points,
    useFlowState,
    variantKey,
} from "./modelsFlowData";

export type DeployMode = "deploy" | "change" | "version";

export function direction(model: FlowModel, version: FlowVersion): string {
    const live = model.deployed ? liveVersion(model) : undefined;
    if (!live || live.number === version.number) {
        return "";
    }
    const delta =
        live.scores && version.scores ? ` (${points(version.scores[0] - live.scores[0])})` : "";
    if (version.number < live.number) {
        return `v${version.number} replaces v${live.number}${delta}.`;
    }
    return live.scores && version.scores
        ? `v${version.number} scores ${points(version.scores[0] - live.scores[0])} over deployed v${live.number}.`
        : `v${version.number} replaces deployed v${live.number}.`;
}

function deployable(model: FlowModel): FlowVersion[] {
    return newestFirst(model).filter((version) => version.status === "ready");
}

export function defaultVersion(model: FlowModel, mode: DeployMode): number {
    const ready = deployable(model);
    if (mode === "change" && model.live !== null) {
        return model.live;
    }
    const passing = ready
        .filter(
            (version) =>
                version.kind === "trained" &&
                version.passed &&
                (mode !== "version" || version.number !== model.live),
        )
        .sort((a, b) => (b.scores?.[0] ?? 0) - (a.scores?.[0] ?? 0));
    return passing[0]?.number ?? 0;
}

function versionOption(model: FlowModel, version: FlowVersion): string {
    const parts = [
        version.kind === "prompt" ? `v${version.number} · Baseline` : `v${version.number}`,
        version.kind === "prompt" ? "prompt only" : pct(version.scores?.[0]),
        model.deployed && version.number === model.live ? "deployed" : null,
        version.passed === false ? "below rule" : null,
    ];
    return parts.filter(Boolean).join(" · ");
}

function samePlacements(model: FlowModel, slots: Slot[]): boolean {
    const current = deployedPlacements(model.slug);
    return (
        model.deployed &&
        current.length === slots.length &&
        slots.every((slot) =>
            current.some(
                (placement) =>
                    placement.machine === slot.machine.id &&
                    placement.gpu === (slot.gpu?.index ?? null),
            ),
        )
    );
}

const AUTOMATIC = "automatic";

export const DEPLOY_DIALOG =
    "flex h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:h-[min(38rem,calc(100dvh-2rem))] sm:max-w-[56rem]";

const PANEL =
    "flex min-h-0 flex-1 flex-col gap-field overflow-y-auto overscroll-contain px-5 py-5 sm:px-7";

const OPTION =
    "flex items-start gap-3 rounded-md border px-3 py-2 has-data-checked:border-primary has-data-checked:bg-accent";

function initialTarget(model: FlowModel): string {
    if (model.kind === "custom") {
        return model.slug;
    }
    const idle = model.variants.find((item) => !item.live) ?? model.variants[0];
    return variantKey(model.slug, idle?.id ?? "bf16");
}

function adapterText(model: FlowModel | undefined, number: number | null): string {
    if (!model || model.kind === "base" || number === null) {
        return "";
    }
    const version = findVersion(model, number);
    if (!version) {
        return "";
    }
    return version.kind === "prompt"
        ? `v${number} instructions (prompt only)`
        : `the ${model.name} v${number} adapter`;
}

function joined(names: string[]): string {
    if (names.length <= 1) {
        return names[0] ?? "";
    }
    return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function deploySummary(
    model: FlowModel,
    serve: Serve,
    slots: Slot[],
    version: number | null = model.live,
): string {
    const adapter = adapterText(model, version);
    const loading = slots.filter((slot) => !slot.loaded);
    const already = slots.filter((slot) => slot.loaded);
    const seconds = loadSeconds(serve, loading.length === 0);
    const parts: string[] = [];
    if (loading.length > 0) {
        const where = joined(loading.map(slotName));
        const tail =
            model.kind === "base"
                ? ""
                : adapter
                  ? ` with ${adapter}`
                  : " with no adapter yet: it serves the base until a version is deployed";
        parts.push(`Loads ${serve.label} on ${where}${tail}`);
    }
    if (already.length > 0) {
        const where = joined(already.map(slotName));
        parts.push(
            model.kind === "base" || !adapter
                ? `Routes to ${serve.label}, already loaded on ${where}`
                : `Adds ${adapter} to ${serve.label}, already loaded on ${where}`,
        );
    }
    return `${parts.join("; ")} · ~${seconds} s`;
}

function PoolOption({ fit, value }: { fit: PoolFit; value: string }) {
    const disabled = Boolean(fit.reason);
    const id = `deploy-pool-${value}`;
    return (
        <label
            htmlFor={id}
            className={cn(
                OPTION,
                disabled
                    ? "cursor-not-allowed text-muted-foreground"
                    : "cursor-pointer hover:bg-secondary",
            )}
        >
            <RadioGroupItem id={id} value={value} disabled={disabled} className="mt-1" />
            <span className="flex min-w-0 flex-col">
                <span>
                    <span className="font-mono">{fit.pool.name}</span>
                    <span className="text-muted-foreground">{` · ${USE_LABELS[fit.pool.use]}`}</span>
                </span>
                <span className="text-sm text-muted-foreground tabular-nums">
                    {fit.reason ?? fit.text}
                </span>
            </span>
        </label>
    );
}

export function DeployForm({
    model,
    mode,
    version: initial,
    source,
    onClose,
}: {
    model: FlowModel;
    mode: DeployMode;
    version?: number;
    source?: "inbox";
    onClose: () => void;
}) {
    const changing = mode !== "deploy" || model.deployed;
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const now = useNow(5000);
    const toast = useToast();
    const [target, setTarget] = useState(() => initialTarget(model));
    const [choice, setChoice] = useState(AUTOMATIC);
    const [replicas, setReplicas] = useState(() => (model.deployed ? liveReplicas(model) : 1));
    const [context, setContext] = useState(DEFAULT_CONTEXT);
    const [tab, setTab] = useState("general");
    const custom = model.kind === "custom" && deployable(model).length > 0;
    const [number, setNumber] = useState(() => initial ?? defaultVersion(model, mode));
    const router = useRouter();
    const picked = custom ? findVersion(model, number) : undefined;
    const serve = serveOf(target, state);
    const fits = poolFits(target, state, compute, now);
    const automatic = automaticPool(fits);
    const chosen = choice === AUTOMATIC ? automatic : fits.find((fit) => fit.pool.name === choice);
    const capacity = chosen?.fitting.length ?? 0;
    const count = Math.max(1, Math.min(replicas, capacity));
    const slots = chosen?.fitting.slice(0, count) ?? [];
    const serving = fits.filter((fit) => fit.pool.use !== "jobs");
    const jobsOnly = fits.filter((fit) => fit.pool.use === "jobs");
    const swap = custom && number !== model.live && samePlacements(model, slots);
    const submit = () => {
        if (!chosen || slots.length === 0) {
            return;
        }
        const id = swap
            ? startVersionDeploy(model, number, source)
            : startDeploy({
                  model,
                  target,
                  pool: chosen.pool.name,
                  slots: slots.map((slot) => ({
                      placement: placementOf(slot),
                      loaded: slot.loaded,
                  })),
                  context,
                  change: changing,
                  version: custom ? number : null,
              });
        const name = custom ? `${model.name} v${number}` : model.name;
        toast({
            title: mode === "change" && !swap ? `Moving ${name}` : `Deploying ${name}`,
            description: swap
                ? `Deploy job #${id} swaps the adapter on ${joined(slots.map(slotName))}.`
                : `Deploy job #${id} loads it on ${joined(slots.map(slotName))}.`,
            action: { label: "View rollout", onClick: () => router.history.push(jobHref(id)) },
        });
        onClose();
    };
    const title =
        mode === "change"
            ? `Edit ${model.name} deployment`
            : mode === "version"
              ? `Deploy another version of ${model.name}`
              : `Deploy ${model.name}`;
    if (!serve) {
        return null;
    }
    const general = (
        <>
            {custom && (
                <Field id="deploy-version" label="Version">
                    <Select
                        value={String(number)}
                        onValueChange={(value) => setNumber(Number(value))}
                    >
                        <SelectTrigger id="deploy-version" className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {deployable(model).map((item) => (
                                <SelectItem key={item.number} value={String(item.number)}>
                                    {versionOption(model, item)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
            )}
            {model.kind === "base" && model.variants.length > 1 && (
                <Field id="deploy-format" label="Format">
                    <Select value={target} onValueChange={(value) => setTarget(String(value))}>
                        <SelectTrigger id="deploy-format" className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {model.variants.map((item) => (
                                <SelectItem key={item.id} value={variantKey(model.slug, item.id)}>
                                    {`${item.format} · ${item.size}${item.live ? " · deployed" : ""}`}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
            )}
            <Field id="deploy-pool" label="Pool">
                <RadioGroup
                    id="deploy-pool"
                    value={choice}
                    onValueChange={(value) => setChoice(String(value))}
                    aria-label="Pool"
                    className="grid gap-2 lg:grid-cols-2"
                >
                    <label
                        htmlFor="deploy-pool-auto"
                        className={cn(
                            OPTION,
                            automatic
                                ? "cursor-pointer hover:bg-secondary"
                                : "cursor-not-allowed text-muted-foreground",
                        )}
                    >
                        <RadioGroupItem
                            id="deploy-pool-auto"
                            value={AUTOMATIC}
                            disabled={!automatic}
                            className="mt-1"
                        />
                        <span className="flex min-w-0 flex-col">
                            <span>Automatic</span>
                            <span className="text-sm text-muted-foreground">
                                {automatic ? (
                                    <span className="font-mono">{automatic.pool.name}</span>
                                ) : (
                                    "No pool has room"
                                )}
                            </span>
                        </span>
                    </label>
                    {serving.map((fit) => (
                        <PoolOption key={fit.pool.name} fit={fit} value={fit.pool.name} />
                    ))}
                </RadioGroup>
                {jobsOnly.length > 0 && (
                    <p className="text-sm text-muted-foreground">
                        {"Jobs only, not for serving: "}
                        <span className="font-mono">
                            {jobsOnly.map((fit) => fit.pool.name).join(", ")}
                        </span>
                    </p>
                )}
            </Field>
            <Field
                id="deploy-replicas"
                label="Replicas"
                hint={
                    chosen
                        ? `${capacity} ${capacity === 1 ? "fits" : "fit"} in ${chosen.pool.name}`
                        : undefined
                }
            >
                <NumberField
                    id="deploy-replicas"
                    value={count}
                    onValueChange={(value) => setReplicas(value ?? 1)}
                    min={1}
                    max={Math.max(1, capacity)}
                    step={1}
                    unit={count === 1 ? "replica" : "replicas"}
                    format={{ maximumFractionDigits: 0 }}
                    disabled={capacity <= 1}
                    className="w-44"
                />
            </Field>
        </>
    );
    const rollout =
        chosen && slots.length > 0
            ? swap
                ? `Same base, already loaded on ${joined(slots.map(slotName))}: fetches the v${number} adapter, attaches it, routes ${model.slug} to it and detaches v${model.live} · ~3 s`
                : deploySummary(model, serve, slots, custom ? number : null)
            : null;
    const fit = chosen?.best
        ? chosen.best.loaded
            ? "Already loaded"
            : `${round(chosen.need)} of ${round(chosen.best.free)} free`
        : "–";
    return (
        <>
            <header className="border-b py-5 pr-14 pl-5 sm:pl-7">
                <DialogTitle className="truncate pr-0">{title}</DialogTitle>
            </header>
            <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[minmax(0,1fr)_18rem] md:grid-rows-[minmax(0,1fr)]">
                {serve.cpu ? (
                    <div className={PANEL}>{general}</div>
                ) : (
                    <Tabs
                        value={tab}
                        onValueChange={(next) => setTab(String(next))}
                        className="min-h-0 flex-1 gap-0"
                    >
                        <div className="border-b px-5 py-3 sm:px-7">
                            <TabsList aria-label="Settings">
                                <TabsTrigger value="general">General</TabsTrigger>
                                <TabsTrigger value="advanced">
                                    {context === DEFAULT_CONTEXT
                                        ? "Advanced"
                                        : "Advanced · 1 changed"}
                                </TabsTrigger>
                            </TabsList>
                        </div>
                        <TabsContent value="general" className={PANEL}>
                            {general}
                        </TabsContent>
                        <TabsContent value="advanced" className={PANEL}>
                            <Field
                                id="deploy-context"
                                label="Context length"
                                hint="Longer contexts reserve GPU memory the fit does not count"
                            >
                                <Select
                                    value={String(context)}
                                    onValueChange={(value) => setContext(Number(value))}
                                >
                                    <SelectTrigger id="deploy-context" className="w-56">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {[DEFAULT_CONTEXT, 16384, LONG_CONTEXT].map((value) => (
                                            <SelectItem key={value} value={String(value)}>
                                                {tokens(value)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                        </TabsContent>
                    </Tabs>
                )}
                <aside
                    aria-label="Rollout"
                    className="flex shrink-0 flex-col gap-4 border-t bg-muted px-5 py-4 sm:px-6 md:gap-5 md:border-t-0 md:border-l md:py-5"
                >
                    <Rollout text={rollout} delta={picked ? direction(model, picked) : ""}>
                        {custom && <Stat label="Version">{`v${number}`}</Stat>}
                        <Stat label="Pool">
                            <span className="font-mono">{chosen?.pool.name ?? "–"}</span>
                        </Stat>
                        <Stat label="Replicas">
                            {chosen ? `${slots.length} of ${capacity}` : "–"}
                        </Stat>
                        <Stat label="Memory">{fit}</Stat>
                        {!serve.cpu && <Stat label="Context">{tokens(context)}</Stat>}
                    </Rollout>
                    <div className="mt-auto flex gap-2">
                        <DialogClose asChild>
                            <Button variant="outline">Cancel</Button>
                        </DialogClose>
                        <Button
                            className="flex-1"
                            onClick={submit}
                            disabled={
                                !chosen ||
                                slots.length === 0 ||
                                (mode === "version" && number === model.live)
                            }
                        >
                            {mode === "change" && !swap && number === model.live
                                ? "Move"
                                : custom
                                  ? `Deploy v${number}`
                                  : "Deploy"}
                        </Button>
                    </div>
                </aside>
            </div>
        </>
    );
}

function tokens(value: number): string {
    return `${value.toLocaleString("en-US")} tokens`;
}

function Rollout({
    text,
    delta,
    children,
}: {
    text: string | null;
    delta: string;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-4">
            <div aria-live="polite" className="flex flex-col gap-1">
                <span className="text-muted-foreground">Rollout</span>
                {text ? (
                    <p className="tabular-nums">{text}</p>
                ) : (
                    <p className="text-destructive">No pool that allows serving has room</p>
                )}
                {delta && (
                    <span className="text-sm text-muted-foreground tabular-nums">{delta}</span>
                )}
            </div>
            <dl className="hidden flex-col gap-2.5 border-t pt-4 md:flex">{children}</dl>
        </div>
    );
}

export function DeployDialog({
    model,
    mode = "deploy",
    open,
    onOpenChange,
}: {
    model: FlowModel;
    mode?: DeployMode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className={DEPLOY_DIALOG}>
                {open && (
                    <DeployForm model={model} mode={mode} onClose={() => onOpenChange(false)} />
                )}
            </DialogContent>
        </Dialog>
    );
}
