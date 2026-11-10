import { useRouter } from "@tanstack/react-router";
import {
    Badge,
    Button,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    FieldGroup,
    Link,
    NumberField,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    useToast,
} from "obp-ui";
import { useState } from "react";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { closeTrain, useOverlays } from "./flowOverlays";
import {
    type Adapter,
    DEVICE,
    FLOW,
    type FlowModel,
    type TrainingSettings,
    dataChoices,
    datasetOf,
    defaultRecipe,
    jobHref,
    jobOfVersion,
    nextNumber,
    rate,
    rowsSinceLive,
    startTraining,
    trainingVersion,
    useFlowState,
} from "./modelsFlowData";

const RANKS = [8, 16, 32, 64];
const RATES = [5e-5, 1e-4, 2e-4];
const ADAPTERS: Adapter[] = ["LoRA", "QLoRA"];
const BATCHES = [4, 8, 16];
const WORKER_GB = 24;

const METHODS = [
    {
        id: "sft",
        label: "Supervised fine-tuning (SFT)",
        tip: "Learns to answer like your labelled rows.",
        ready: true,
    },
    {
        id: "dpo",
        label: "DPO",
        tip: "Learns from pairs of a better and a worse answer.",
        ready: false,
    },
    {
        id: "pretraining",
        label: "Continued pretraining",
        tip: "Reads your raw text to pick up its vocabulary.",
        ready: false,
    },
    {
        id: "rl",
        label: "Reinforcement learning",
        tip: "Learns from a reward that scores each answer.",
        ready: false,
    },
];

export function memoryNeeded(recipe: TrainingSettings): number {
    const full = 2.1 + recipe.rank * 0.32 + recipe.batch * 1.4;
    return recipe.adapter === "QLoRA" ? full * 0.45 : full;
}

function signed(value: number): string {
    return `${value >= 0 ? "+" : "−"}${count(Math.abs(value))}`;
}

function Body({ model }: { model: FlowModel }) {
    const router = useRouter();
    const toast = useToast();
    const state = useFlowState();
    const choices = dataChoices(model);
    const dataset = datasetOf(model);
    const [picked, setPicked] = useState(String(choices[0]?.number ?? ""));
    const [recipe, setRecipe] = useState<TrainingSettings>(defaultRecipe(model));
    const change = (patch: Partial<TrainingSettings>) => setRecipe({ ...recipe, ...patch });
    const number = nextNumber(model);
    const running = trainingVersion(model);
    const device = running ? "gpu-a10-2" : DEVICE;
    const needed = memoryNeeded(recipe);
    const fits = needed <= WORKER_GB;
    const pending = state.feedback.filter(
        (row) => row.model === model.slug && row.state === "pending",
    ).length;
    const label = (choice: { number: number; rows: number }) => {
        const since = rowsSinceLive(model, choice.rows);
        return `v${choice.number} · ${count(choice.rows)} rows${since === null ? "" : `, ${signed(since)} since live`}`;
    };
    const start = () => {
        const choice = choices.find((item) => String(item.number) === picked);
        const made = startTraining(model.slug, recipe, choice);
        const job = jobOfVersion(model.slug, made);
        closeTrain();
        toast({
            title: `Training v${made} of ${model.name}`,
            description: `Job #${job} on ${device}.`,
            tone: "success",
        });
        if (job) {
            router.history.push(jobHref(job));
        }
    };
    return (
        <>
            <DialogHeader>
                <DialogTitle>{`Train v${number}`}</DialogTitle>
                <DialogDescription>
                    {`${model.name} trains from ${model.base}, not from the version before. v${number} is scored on the same held-out rows as every version.`}
                </DialogDescription>
            </DialogHeader>
            <FieldGroup>
                <Field
                    id="train-data"
                    label="Data version"
                    hint={
                        <span className="flex flex-wrap gap-x-1">
                            <span className="tabular-nums">
                                {model.accepted > 0
                                    ? `${model.accepted} feedback ${model.accepted === 1 ? "row" : "rows"} will join.`
                                    : "No accepted feedback waiting."}
                            </span>
                            {pending > 0 && (
                                <Link
                                    href={`${FLOW}/feedback`}
                                    onClick={() => closeTrain()}
                                    className="text-primary hover:underline"
                                >
                                    {`${pending} to review`}
                                </Link>
                            )}
                        </span>
                    }
                >
                    <Select value={picked} onValueChange={(value) => setPicked(String(value))}>
                        <SelectTrigger id="train-data">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {choices.map((choice) => (
                                <SelectItem
                                    key={choice.number}
                                    value={String(choice.number)}
                                    label={label(choice)}
                                >
                                    <span className="tabular-nums">{label(choice)}</span>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {dataset && (
                        <span className="text-sm text-muted-foreground">
                            {`${dataset.name} · `}
                            <Link
                                href={`${FLOW}/data?for=${model.slug}`}
                                onClick={() => closeTrain()}
                                className="text-primary hover:underline"
                            >
                                Change dataset
                            </Link>
                        </span>
                    )}
                </Field>
                <Field id="train-method" label="Method">
                    <Select value="sft">
                        <SelectTrigger id="train-method">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {METHODS.map((method) => (
                                <Tooltip key={method.id}>
                                    <TooltipTrigger asChild>
                                        <SelectItem
                                            value={method.id}
                                            label={method.label}
                                            disabled={!method.ready}
                                            className="data-[disabled]:pointer-events-auto"
                                        >
                                            <span>{method.label}</span>
                                            {!method.ready && (
                                                <Badge variant="neutral">Coming soon</Badge>
                                            )}
                                        </SelectItem>
                                    </TooltipTrigger>
                                    <TooltipContent side="right">{method.tip}</TooltipContent>
                                </Tooltip>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
                <div className="grid grid-cols-2 gap-field">
                    <Field id="train-epochs" label="Epochs">
                        <NumberField
                            id="train-epochs"
                            value={recipe.epochs}
                            onValueChange={(value) => change({ epochs: value ?? 1 })}
                            min={1}
                            max={10}
                            step={1}
                            format={{ maximumFractionDigits: 0 }}
                        />
                    </Field>
                    <Field id="train-rate" label="Learning rate">
                        <Select
                            value={String(recipe.learningRate)}
                            onValueChange={(value) => change({ learningRate: Number(value) })}
                        >
                            <SelectTrigger id="train-rate">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {RATES.map((value) => (
                                    <SelectItem key={value} value={String(value)}>
                                        {rate(value)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>
                </div>
                <Collapsible>
                    <CollapsibleTrigger>Advanced</CollapsibleTrigger>
                    <CollapsibleContent>
                        <div className="grid grid-cols-3 gap-field pt-4">
                            <Field id="train-adapter" label="Adapter">
                                <Select
                                    value={recipe.adapter}
                                    onValueChange={(value) => change({ adapter: value as Adapter })}
                                >
                                    <SelectTrigger id="train-adapter">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {ADAPTERS.map((adapter) => (
                                            <SelectItem
                                                key={adapter}
                                                value={adapter}
                                                description={
                                                    adapter === "QLoRA"
                                                        ? "4-bit, less memory"
                                                        : undefined
                                                }
                                            >
                                                {adapter}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                            <Field id="train-rank" label="LoRA rank">
                                <Select
                                    value={String(recipe.rank)}
                                    onValueChange={(value) => change({ rank: Number(value) })}
                                >
                                    <SelectTrigger id="train-rank">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {RANKS.map((rank) => (
                                            <SelectItem key={rank} value={String(rank)}>
                                                {String(rank)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                            <Field id="train-batch" label="Batch">
                                <Select
                                    value={String(recipe.batch)}
                                    onValueChange={(value) => change({ batch: Number(value) })}
                                >
                                    <SelectTrigger id="train-batch">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {BATCHES.map((batch) => (
                                            <SelectItem key={batch} value={String(batch)}>
                                                {String(batch)}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                        </div>
                    </CollapsibleContent>
                </Collapsible>
            </FieldGroup>
            <p className="flex flex-wrap items-center gap-x-2">
                <StatusText tone={fits ? "success" : "destructive"}>
                    {fits ? "Fits" : "Does not fit"}
                </StatusText>
                <span className="text-muted-foreground tabular-nums">
                    {`about ${needed.toFixed(1)} of ${WORKER_GB} GB on ${device} · about 12 minutes`}
                </span>
                {running && (
                    <span className="text-sm text-muted-foreground">
                        {`${DEVICE} is training v${running.number}.`}
                    </span>
                )}
            </p>
            <DialogFooter>
                <DialogClose asChild>
                    <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button disabled={!fits || choices.length === 0} onClick={start}>
                    {`Train v${number}`}
                </Button>
            </DialogFooter>
        </>
    );
}

export function TrainDialog() {
    const { train } = useOverlays();
    const state = useFlowState();
    const model = train ? state.models.find((item) => item.slug === train) : undefined;
    return (
        <Dialog open={Boolean(model)} onOpenChange={(open) => !open && closeTrain()}>
            <DialogContent className="sm:max-w-xl">{model && <Body model={model} />}</DialogContent>
        </Dialog>
    );
}
