import {
    Button,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    FieldGroup,
    NumberField,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    cn,
    useToast,
} from "obp-ui";
import { useState } from "react";
import {
    type PoolFit,
    type Serve,
    type Slot,
    USE_LABELS,
    automaticPool,
    deploy,
    loadSeconds,
    poolFits,
    round,
    serveOf,
    slotName,
    useCompute,
    useNow,
} from "./flowCompute";
import {
    type FlowModel,
    liveVersion,
    markVisited,
    useFlowState,
    variantKey,
} from "./modelsFlowData";

const AUTOMATIC = "automatic";

function initialTarget(model: FlowModel): string {
    if (model.kind === "custom") {
        return model.slug;
    }
    const idle = model.variants.find((item) => !item.live) ?? model.variants[0];
    return variantKey(model.slug, idle?.id ?? "bf16");
}

function adapterText(model: FlowModel | undefined): string {
    if (!model || model.kind === "base") {
        return "";
    }
    const live = liveVersion(model);
    return live ? `the ${model.name} v${live.number} adapter` : "";
}

function joined(names: string[]): string {
    if (names.length <= 1) {
        return names[0] ?? "";
    }
    return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function deploySummary(model: FlowModel, serve: Serve, slots: Slot[]): string {
    const adapter = adapterText(model);
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
                  : " with no adapter yet: it serves the base until a version is live";
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
                "flex items-start gap-3 rounded-md border px-3 py-2",
                disabled
                    ? "cursor-not-allowed text-muted-foreground"
                    : "cursor-pointer hover:bg-secondary has-data-checked:border-primary has-data-checked:bg-accent",
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

function DeployForm({
    model,
    changing,
    onClose,
}: {
    model: FlowModel;
    changing: boolean;
    onClose: () => void;
}) {
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const now = useNow(5000);
    const toast = useToast();
    const [target, setTarget] = useState(() => initialTarget(model));
    const [choice, setChoice] = useState(AUTOMATIC);
    const [picking, setPicking] = useState(false);
    const [replicas, setReplicas] = useState(1);
    const serve = serveOf(target, state);
    const fits = poolFits(target, state, compute, now);
    const automatic = automaticPool(fits);
    const chosen = choice === AUTOMATIC ? automatic : fits.find((fit) => fit.pool.name === choice);
    const capacity = chosen?.fitting.length ?? 0;
    const count = Math.max(1, Math.min(replicas, capacity));
    const slots = chosen?.fitting.slice(0, count) ?? [];
    const serving = fits.filter((fit) => fit.pool.use !== "jobs");
    const jobsOnly = fits.filter((fit) => fit.pool.use === "jobs");
    const submit = () => {
        if (!chosen || slots.length === 0) {
            return;
        }
        deploy(target, chosen.pool.name, slots);
        markVisited("infra-deploy");
        toast({
            title: changing ? `Moving ${model.name}` : `Deploying ${model.name}`,
            description: `Watch it load on ${joined(slots.map(slotName))} in Infrastructure.`,
        });
        onClose();
    };
    if (!serve) {
        return null;
    }
    return (
        <>
            <DialogHeader>
                <DialogTitle>
                    {changing ? `Change where ${model.name} runs` : `Deploy ${model.name}`}
                </DialogTitle>
                <DialogDescription>
                    {`An engine in a pool loads ${serve.label} and keeps it loaded. Calls to ${model.slug} on /v1 route to it.`}
                </DialogDescription>
            </DialogHeader>
            <FieldGroup>
                {model.kind === "base" && model.variants.length > 1 && (
                    <Field id="deploy-format" label="Format">
                        <Select value={target} onValueChange={(value) => setTarget(String(value))}>
                            <SelectTrigger id="deploy-format" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {model.variants.map((item) => (
                                    <SelectItem
                                        key={item.id}
                                        value={variantKey(model.slug, item.id)}
                                    >
                                        {`${item.format} · ${item.size}${item.live ? " · deployed" : ""}`}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>
                )}
                <Field id="deploy-pool" label="Pool">
                    {picking ? (
                        <RadioGroup
                            id="deploy-pool"
                            value={choice}
                            onValueChange={(value) => setChoice(String(value))}
                            aria-label="Pool"
                        >
                            <label
                                htmlFor="deploy-pool-auto"
                                className="flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 hover:bg-secondary has-data-checked:border-primary has-data-checked:bg-accent"
                            >
                                <RadioGroupItem
                                    id="deploy-pool-auto"
                                    value={AUTOMATIC}
                                    disabled={!automatic}
                                    className="mt-1"
                                />
                                <span className="flex flex-col">
                                    <span>Automatic</span>
                                    <span className="text-sm text-muted-foreground">
                                        {automatic
                                            ? `Picks ${automatic.pool.name}: a pool that allows serving, where it is already loaded or has the most room.`
                                            : "No pool has room."}
                                    </span>
                                </span>
                            </label>
                            {[...serving, ...jobsOnly].map((fit) => (
                                <PoolOption key={fit.pool.name} fit={fit} value={fit.pool.name} />
                            ))}
                        </RadioGroup>
                    ) : (
                        <div className="flex items-center gap-3 rounded-md border px-3 py-2">
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span>
                                    {choice === AUTOMATIC ? "Automatic" : "Chosen"}
                                    {chosen && (
                                        <>
                                            <span className="text-muted-foreground"> · </span>
                                            <span className="font-mono">{chosen.pool.name}</span>
                                        </>
                                    )}
                                </span>
                                <span className="text-sm text-muted-foreground tabular-nums">
                                    {chosen ? chosen.text : "No pool that allows serving has room."}
                                </span>
                            </span>
                            <Button variant="outline" onClick={() => setPicking(true)}>
                                Change
                            </Button>
                        </div>
                    )}
                </Field>
                <Field
                    id="deploy-replicas"
                    label="Replicas"
                    hint={
                        chosen
                            ? `Each replica takes one ${serve.cpu ? "machine with" : "GPU with"} ${round(chosen.need)} free; ${capacity} ${capacity === 1 ? "fits" : "fit"} in ${chosen.pool.name}.`
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
                {chosen && slots.length > 0 && (
                    <p className="rounded-md border bg-muted px-3 py-2 tabular-nums">
                        {deploySummary(model, serve, slots)}
                    </p>
                )}
            </FieldGroup>
            <DialogFooter>
                <DialogClose asChild>
                    <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button onClick={submit} disabled={!chosen || slots.length === 0}>
                    {changing ? "Move" : "Deploy"}
                </Button>
            </DialogFooter>
        </>
    );
}

export function DeployDialog({
    model,
    changing = false,
    open,
    onOpenChange,
}: {
    model: FlowModel;
    changing?: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl [&>*]:min-w-0">
                {open && (
                    <DeployForm
                        model={model}
                        changing={changing}
                        onClose={() => onOpenChange(false)}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}
