import { useRouter } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import {
    Button,
    Checkbox,
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
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Timeline,
    TimelineDot,
    TimelineItem,
    cn,
    useToast,
} from "obp-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CopyButton } from "~/components/CopyButton";
import { Facts } from "~/components/Facts";
import { Section, Stat } from "~/components/Section";
import { StepChart, type StepSeries } from "~/components/charts/StepChart";
import { ChartLegend } from "~/components/charts/TimeChart";
import { ProgressBar, StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { useSearchParam } from "~/lib/listSearch";
import {
    FLOW,
    type FlowModel,
    type FlowVersion,
    LOSS_STEPS,
    type Method,
    type TrainingSettings,
    applyUpdate,
    attachDataset,
    compareHref,
    createKey,
    datasetHref,
    defaultRecipe,
    deleteVariantFiles,
    deployVariants,
    jobHref,
    lossCurve,
    newestFirst,
    nextNumber,
    pct,
    retryWithQLoRA,
    revokeKey,
    setRecipe,
    shortAgo,
    startTraining,
    timeLeft,
    trainingVersion,
    undeployVariants,
    useFlowState,
    variantKey,
    versionHref,
    versionState,
} from "./modelsFlowData";
import {
    MakeLiveButton,
    ScoreBadge,
    Tip,
    VersionName,
    VersionStatus,
    openConnect,
} from "./modelsFlowParts";

const RANKS = [8, 16, 32, 64];
const RATES = [5e-5, 1e-4, 2e-4];
const METHODS: Method[] = ["LoRA", "QLoRA"];
const WORKER_GB = 24;

export const LOSS_SERIES: StepSeries[] = [
    { key: "loss", label: "Training loss", color: "var(--primary)" },
    {
        key: "heldOut",
        label: "Held-out loss",
        color: "var(--file-sql)",
        dots: true,
    },
];

export function trainBlock(model: FlowModel): string | null {
    if (model.serveOnly) {
        return `${model.base} is serve-only: GGUF weights cannot be trained.`;
    }
    if (!model.dataset) {
        return "Attach a dataset first: training needs examples.";
    }
    const training = trainingVersion(model);
    if (training) {
        return `v${training.number} is training; one run at a time.`;
    }
    return null;
}

function memoryNeeded(recipe: TrainingSettings): number {
    const full = 2.1 + recipe.rank * 0.32 + recipe.batch * 1.4;
    return recipe.method === "QLoRA" ? full * 0.45 : full;
}

export function useStartTraining(model: FlowModel) {
    const router = useRouter();
    return (recipe?: TrainingSettings) => {
        const number = startTraining(model.slug, recipe);
        router.history.push(versionHref(model.slug, number, "training"));
    };
}

export function LossChart({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const stop =
        version.status === "training"
            ? LOSS_STEPS * (version.progress ?? 0)
            : version.status === "failed"
              ? LOSS_STEPS * 0.3
              : LOSS_STEPS;
    const rows = lossCurve(version.number).filter((row) => row.step <= stop);
    return (
        <div className="flex flex-col gap-3">
            <ChartLegend series={LOSS_SERIES} />
            <StepChart
                rows={rows}
                series={LOSS_SERIES}
                format={(value) => value.toFixed(3)}
                axisFormat={(value) => value.toFixed(2)}
                label={`Training and held-out loss for ${model.name} v${version.number}`}
                domain={[0, LOSS_STEPS]}
                height={220}
            />
        </div>
    );
}

export function RunPanel({
    model,
    version,
    title,
    links = true,
}: {
    model: FlowModel;
    version: FlowVersion;
    title: string;
    links?: boolean;
}) {
    const step = Math.round((version.progress ?? 0) * LOSS_STEPS);
    return (
        <Section
            title={title}
            caption={`${version.settings?.method ?? "LoRA"} on ${model.base} · data v${version.data.number} · started ${shortAgo(version)}`}
            actions={
                <>
                    {links && (
                        <Button variant="outline" asChild>
                            <Link href={versionHref(model.slug, version.number, "training")}>
                                {`Open v${version.number}`}
                            </Link>
                        </Button>
                    )}
                    <Button variant="outline" asChild>
                        <Link href={jobHref(version.jobId)}>{`Job #${version.jobId}`}</Link>
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-x-10 gap-y-2">
                    <StatusText tone="info">
                        <span className="tabular-nums">{`Training · ${Math.round((version.progress ?? 0) * 100)}%`}</span>
                    </StatusText>
                    <Stat label="Step" value={`${count(step)} of ${count(LOSS_STEPS)}`} />
                    <Stat label="Time left" value={timeLeft(version)} />
                    <Stat label="Worker" value="gpu-a10-1" />
                </div>
                <ProgressBar
                    value={version.progress ?? 0}
                    label={`v${version.number} progress`}
                    className="w-full"
                />
                <LossChart model={model} version={version} />
            </div>
        </Section>
    );
}

function DatasetPanel({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const current = state.datasets.find((item) => item.slug === model.dataset);
    const [picked, setPicked] = useState(state.datasets[0]?.slug ?? "");
    if (current) {
        const warnings = current.checks.filter((check) => check.state === "warning").length;
        return (
            <Section
                title="Data"
                caption="What the next version trains on and every version is scored on."
                actions={
                    <Button variant="outline" asChild>
                        <Link href={`${FLOW}/data?for=${model.slug}`}>Change</Link>
                    </Button>
                }
            >
                <Facts
                    items={[
                        [
                            "Dataset",
                            <Link
                                key="d"
                                href={datasetHref(current.slug)}
                                className="text-primary hover:underline"
                            >
                                {`${current.name} v${current.version}`}
                            </Link>,
                        ],
                        [
                            "Rows",
                            <span key="r" className="tabular-nums">
                                {count(current.rows)}
                            </span>,
                        ],
                        [
                            "Quality",
                            <span key="q">
                                {`${current.checks.length - warnings} checks passed`}
                                {warnings > 0 && (
                                    <span className="text-warning">{`, ${warnings} warning`}</span>
                                )}
                            </span>,
                        ],
                        [
                            "Split",
                            <span
                                key="s"
                                className="tabular-nums"
                            >{`${count(current.split[0])} train · ${count(current.split[1])} held out`}</span>,
                        ],
                    ]}
                />
            </Section>
        );
    }
    return (
        <Section
            title="Data"
            caption="Attach a dataset: it is checked and split, then v0 Baseline is scored on its held-out rows."
        >
            {state.datasets.length === 0 ? (
                <div className="flex flex-col items-start gap-3">
                    <p className="text-muted-foreground">No datasets on this install yet.</p>
                    <Button asChild>
                        <Link href={`${FLOW}/data?for=${model.slug}`}>Upload on the Data page</Link>
                    </Button>
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    <ul className="divide-y rounded-md border">
                        {state.datasets.map((item) => (
                            <li key={item.slug}>
                                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-secondary has-[:checked]:bg-accent">
                                    <input
                                        type="radio"
                                        name="dataset"
                                        value={item.slug}
                                        checked={picked === item.slug}
                                        onChange={() => setPicked(item.slug)}
                                        className="accent-primary"
                                    />
                                    <span className="flex-1 truncate font-medium">{item.name}</span>
                                    <span className="text-muted-foreground tabular-nums">{`${count(item.rows)} rows`}</span>
                                </label>
                            </li>
                        ))}
                    </ul>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            disabled={!picked}
                            onClick={() => attachDataset(model.slug, picked)}
                        >
                            Attach
                        </Button>
                        <Button variant="outline" asChild>
                            <Link href={`${FLOW}/data?for=${model.slug}`}>Upload a file</Link>
                        </Button>
                    </div>
                </div>
            )}
        </Section>
    );
}

function Waiting({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const pending = state.feedback.filter(
        (row) => row.model === model.slug && row.state === "pending",
    ).length;
    const next = nextNumber(model);
    const rows: [string, ReactNode][] = [
        [
            "Accepted feedback",
            model.accepted > 0 ? (
                <span
                    key="a"
                    className="tabular-nums"
                >{`${model.accepted} rows join v${next}`}</span>
            ) : (
                <span key="a" className="text-muted-foreground">
                    None yet
                </span>
            ),
        ],
        [
            "To review",
            pending > 0 ? (
                <Link key="p" href={`${FLOW}/feedback`} className="text-primary hover:underline">
                    {`${pending} feedback rows →`}
                </Link>
            ) : (
                <span key="p" className="text-muted-foreground">
                    Nothing
                </span>
            ),
        ],
        [
            "Test examples",
            <span key="t" className="tabular-nums">
                {state.examples > 0
                    ? `${state.examples} saved from the Playground, checked on every version`
                    : "Save answers from the Playground to check them on every version"}
            </span>,
        ],
    ];
    return (
        <Section title="Waiting to join" caption={`Rows the next run, v${next}, picks up.`}>
            <Facts items={rows} />
        </Section>
    );
}

function SettingsPanel({ model }: { model: FlowModel }) {
    const recipe = defaultRecipe(model);
    const start = useStartTraining(model);
    const blocked = trainBlock(model);
    const needed = memoryNeeded(recipe);
    const fits = needed <= WORKER_GB;
    const change = (patch: Partial<TrainingSettings>) =>
        setRecipe(model.slug, { ...recipe, ...patch });
    const number = nextNumber(model);
    return (
        <Section
            title="Settings"
            caption={`The recipe v${number} trains with. It starts from the install default and keeps your last change.`}
        >
            <div className="flex flex-col gap-field">
                <FieldGroup className="grid grid-cols-2">
                    <Field id="train-method" label="Method">
                        <Select
                            value={recipe.method}
                            onValueChange={(value) => change({ method: value as Method })}
                        >
                            <SelectTrigger id="train-method">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {METHODS.map((method) => (
                                    <SelectItem key={method} value={method}>
                                        {method === "QLoRA" ? "QLoRA (4-bit, less memory)" : "LoRA"}
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
                                        {value.toExponential(0)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>
                </FieldGroup>
                <p className="flex flex-wrap items-center gap-x-2">
                    <StatusText tone={fits ? "success" : "destructive"}>
                        {fits ? "Fits" : "Does not fit"}
                    </StatusText>
                    <span className="text-muted-foreground tabular-nums">
                        {`about ${needed.toFixed(1)} of ${WORKER_GB} GB on gpu-a10-1 · about 12 minutes`}
                    </span>
                </p>
                <div className="flex flex-wrap items-center gap-3">
                    <Tip tip={blocked}>
                        <Button disabled={Boolean(blocked) || !fits} onClick={() => start(recipe)}>
                            {`Train v${number}`}
                            {model.accepted > 0 && ` (+${model.accepted} feedback rows)`}
                        </Button>
                    </Tip>
                    <span className="text-sm text-muted-foreground">
                        Every version trains from the base, not from the version before.
                    </span>
                </div>
            </div>
        </Section>
    );
}

export function TrainingTab({ model }: { model: FlowModel }) {
    const training = trainingVersion(model);
    return (
        <div className="flex flex-col gap-4">
            {training && (
                <RunPanel
                    model={model}
                    version={training}
                    title={`v${training.number} is training`}
                />
            )}
            <div className="grid gap-4 lg:grid-cols-2">
                <div className="flex flex-col gap-4">
                    <DatasetPanel model={model} />
                    <Waiting model={model} />
                </div>
                <SettingsPanel model={model} />
            </div>
        </div>
    );
}

const DOT_COLORS: Record<string, string> = {
    success: "var(--success)",
    info: "var(--info)",
    destructive: "var(--destructive)",
    neutral: "var(--faint)",
    warning: "var(--warning)",
    approval: "var(--approval)",
};

function VersionLine({
    model,
    version,
    picked,
    onPick,
}: {
    model: FlowModel;
    version: FlowVersion;
    picked: boolean;
    onPick: (on: boolean) => void;
}) {
    const toast = useToast();
    const router = useRouter();
    const memory = /memory/i.test(version.error ?? "");
    const newest = newestFirst(model)[0]?.number === version.number;
    const settings = version.settings;
    return (
        <TimelineItem
            dot={<TimelineDot color={DOT_COLORS[versionState(model, version).tone]} />}
            className="pb-2"
        >
            <div
                className={cn(
                    "-mt-0.5 flex min-h-10 flex-1 flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-2 py-1",
                    picked && "bg-accent",
                )}
            >
                <Checkbox
                    aria-label={`Select v${version.number} to compare`}
                    checked={picked}
                    disabled={!version.scores}
                    onCheckedChange={(value) => onPick(value === true)}
                />
                <span className="flex w-60 min-w-0 flex-col">
                    <Link
                        href={versionHref(model.slug, version.number)}
                        className="font-semibold hover:underline"
                    >
                        <VersionName version={version} />
                    </Link>
                    <span className="truncate text-sm text-muted-foreground">
                        {settings
                            ? `${settings.method} r${settings.rank} · data v${version.data.number} · ${shortAgo(version)}`
                            : `Prompt only · data v${version.data.number} · ${shortAgo(version)}`}
                    </span>
                </span>
                <span className="w-16 text-right tabular-nums">{pct(version.scores?.[0])}</span>
                <span className="w-32">
                    <ScoreBadge model={model} version={version} />
                </span>
                <span className="w-44">
                    <VersionStatus model={model} version={version} />
                </span>
                <span className="ml-auto flex items-center gap-2">
                    {version.status === "training" && (
                        <Button variant="outline" asChild>
                            <Link href={versionHref(model.slug, version.number, "training")}>
                                Watch
                            </Link>
                        </Button>
                    )}
                    {version.status === "failed" && newest && memory && (
                        <Button
                            variant="outline"
                            onClick={() => {
                                const number = retryWithQLoRA(model.slug, version.number);
                                toast({
                                    title: `v${number} is training with QLoRA`,
                                    tone: "success",
                                });
                                router.history.push(versionHref(model.slug, number, "training"));
                            }}
                        >
                            Retry with QLoRA
                        </Button>
                    )}
                    <MakeLiveButton model={model} version={version} variant="secondary" />
                </span>
            </div>
        </TimelineItem>
    );
}

export function VersionsTab({ model }: { model: FlowModel }) {
    const router = useRouter();
    const [picked, setPicked] = useState<number[]>([]);
    const pick = (number: number, on: boolean) =>
        setPicked(
            on
                ? [...picked.filter((n) => n !== number), number].slice(-2)
                : picked.filter((n) => n !== number),
        );
    const sorted = [...picked].sort((a, b) => a - b);
    if (model.versions.length === 0) {
        return (
            <Section title="Versions">
                <p className="text-muted-foreground">
                    No versions yet. Attach data on the Training tab and v0 Baseline is scored at
                    once.
                </p>
            </Section>
        );
    }
    return (
        <Section
            title="Versions"
            caption={`Newest first. Each is an immutable result, callable as ${model.slug}@N; live is a pointer to one of them.`}
            actions={
                <>
                    {picked.length > 0 && (
                        <Button variant="outline" onClick={() => setPicked([])}>
                            Clear
                        </Button>
                    )}
                    <Tip
                        tip={
                            picked.length === 2 ? null : "Tick two scored versions to compare them."
                        }
                    >
                        <Button
                            variant={picked.length === 2 ? "default" : "outline"}
                            disabled={picked.length !== 2}
                            onClick={() =>
                                router.history.push(compareHref(model.slug, sorted[0], sorted[1]))
                            }
                        >
                            {picked.length === 2
                                ? `Compare v${sorted[0]} and v${sorted[1]}`
                                : "Compare"}
                        </Button>
                    </Tip>
                </>
            }
        >
            <Timeline>
                {newestFirst(model).map((version) => (
                    <VersionLine
                        key={version.number}
                        model={model}
                        version={version}
                        picked={picked.includes(version.number)}
                        onPick={(on) => pick(version.number, on)}
                    />
                ))}
                <TimelineItem dot={<TimelineDot color="var(--faint)" />} className="pb-0">
                    <span className="-mt-0.5 flex min-h-10 flex-col justify-center px-2">
                        <span className="font-medium">{model.base}</span>
                        <span className="text-sm text-muted-foreground">
                            The base. Every version above is trained from it, not from the one
                            before.
                        </span>
                    </span>
                </TimelineItem>
            </Timeline>
        </Section>
    );
}

export function KeysTab({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const wantsNew = useSearchParam("new") === "1";
    const [shown, setShown] = useState<string | null>(null);
    const done = useRef(false);
    const keys = state.keys[model.slug] ?? [];
    const create = () => setShown(createKey(model.slug));
    useEffect(() => {
        if (wantsNew && !done.current) {
            done.current = true;
            setShown(createKey(model.slug));
        }
    }, [wantsNew, model.slug]);
    return (
        <div className="flex flex-col gap-4">
            <Section
                title="API keys"
                caption={`Keys that can call ${model.slug} and ${model.slug}@N. A key is shown once, when it is created.`}
                actions={
                    <>
                        <Button variant="outline" onClick={() => openConnect(model.slug)}>
                            Connect
                        </Button>
                        <Button onClick={create}>
                            <KeyRound aria-hidden="true" />
                            Create key
                        </Button>
                    </>
                }
                flush
            >
                {keys.length === 0 ? (
                    <p className="px-panel py-6 text-muted-foreground">No keys yet.</p>
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="pl-panel">Key</TableHead>
                                <TableHead>Created</TableHead>
                                <TableHead>Last used</TableHead>
                                <TableHead />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {keys.map((key) => (
                                <TableRow key={key.id}>
                                    <TableCell className="pl-panel font-mono text-sm">
                                        {key.prefix}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {shortAgo(key)}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {key.lastUsed === null
                                            ? "Never"
                                            : shortAgo({ hoursAgo: key.lastUsed })}
                                    </TableCell>
                                    <TableCell className="pr-panel text-right">
                                        <Button
                                            variant="outline"
                                            onClick={() => revokeKey(model.slug, key.id)}
                                        >
                                            Revoke
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </Section>
            <Dialog open={shown !== null} onOpenChange={(open) => !open && setShown(null)}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Copy your key now</DialogTitle>
                        <DialogDescription>
                            It is not shown again. Connect has the base URL and code to use it.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex items-center gap-2 rounded-md border bg-muted py-1 pr-1 pl-3">
                        <span className="flex-1 font-mono text-sm break-all">{shown}</span>
                        <CopyButton value={shown ?? ""} label="Copy key" />
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => {
                                setShown(null);
                                openConnect(model.slug);
                            }}
                        >
                            Connect
                        </Button>
                        <DialogClose asChild>
                            <Button>Done</Button>
                        </DialogClose>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

export function VariantsTab({ model }: { model: FlowModel }) {
    const toast = useToast();
    return (
        <Section
            title="Variants"
            caption="The formats installed on this install. Each one on the API has its own model name."
            flush
        >
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="pl-panel">Format</TableHead>
                        <TableHead>API name</TableHead>
                        <TableHead className="text-right">Size</TableHead>
                        <TableHead>Training</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Cost / 1k req.</TableHead>
                        <TableHead />
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {model.variants.map((item) => {
                        const key = variantKey(model.slug, item.id);
                        return (
                            <TableRow key={item.id}>
                                <TableCell className="pl-panel font-medium">
                                    {item.format}
                                </TableCell>
                                <TableCell className="font-mono text-sm">{item.apiName}</TableCell>
                                <TableCell className="text-right">{item.size}</TableCell>
                                <TableCell className="text-muted-foreground">
                                    {item.trainable ? "Trainable" : "Serve-only"}
                                </TableCell>
                                <TableCell>
                                    {item.live ? (
                                        <StatusText tone="success">
                                            {`On the API${item.replicas.length > 1 ? ` · ${item.replicas.length} replicas` : ""}`}
                                        </StatusText>
                                    ) : (
                                        <span className="text-muted-foreground">Off</span>
                                    )}
                                    {item.update && (
                                        <span className="block text-sm text-info">
                                            Update available
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell className="text-right">{`${item.gpuSeconds.toFixed(1)} GPU·s`}</TableCell>
                                <TableCell className="pr-panel text-right">
                                    <span className="inline-flex gap-2">
                                        {item.update && (
                                            <Button
                                                variant="outline"
                                                onClick={() => {
                                                    applyUpdate(model.slug, item.id);
                                                    toast({
                                                        title: `${item.format} updated`,
                                                        tone: "success",
                                                    });
                                                }}
                                            >
                                                Update
                                            </Button>
                                        )}
                                        <Button
                                            variant="outline"
                                            onClick={() =>
                                                item.live
                                                    ? undeployVariants([key])
                                                    : deployVariants([key])
                                            }
                                        >
                                            {item.live ? "Take off the API" : "Put on the API"}
                                        </Button>
                                        <Tip tip={item.live ? "Take it off the API first." : null}>
                                            <Button
                                                variant="outline"
                                                disabled={item.live}
                                                onClick={() => deleteVariantFiles([key])}
                                            >
                                                Delete files
                                            </Button>
                                        </Tip>
                                    </span>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </Section>
    );
}
