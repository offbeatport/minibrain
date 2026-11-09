import { useParams, useRouter } from "@tanstack/react-router";
import { GraduationCap, KeyRound, Play } from "lucide-react";
import {
    Badge,
    Button,
    CodeTabs,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    FieldGroup,
    Input,
    Link,
    NumberField,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    TabNav,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import { type FormEvent, type ReactNode, useState } from "react";
import type { ModelUsage } from "~/api/client";
import { CopyButton } from "~/components/CopyButton";
import { Facts } from "~/components/Facts";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section, Stat } from "~/components/Section";
import { Requests } from "~/components/models/ModelMetrics";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { relativeTime } from "~/lib/time";
import {
    FLOW,
    type FlowModel,
    KIND_LABELS,
    type ModelTab,
    type TrainingSettings,
    attachDataset,
    catalogEntry,
    compareHref,
    createKey,
    createdAt,
    datasetHref,
    defaultRecipe,
    flowHref,
    liveVersion,
    modelHref,
    newestFirst,
    nextStep,
    pct,
    startTraining,
    useFlowModel,
    useFlowState,
    versionHref,
} from "./modelsFlowData";
import {
    Crumbs,
    Delta,
    DeployDialog,
    type DeployIntent,
    ModelAvatar,
    StateBadge,
    deployBlocked,
    deployLabel,
} from "./modelsFlowParts";

const TAB_LABELS: Record<ModelTab, string> = {
    overview: "Overview",
    versions: "Versions",
    data: "Data",
    api: "API",
};

const RANKS = [8, 16, 32, 64];
const RATES = [5e-5, 1e-4, 2e-4];
const WORKER_GB = 24;

function trainBlock(model: FlowModel): string | null {
    if (model.serveOnly) {
        return `${model.base} is serve-only: GGUF weights cannot be trained. Switch base to train.`;
    }
    if (!model.dataset) {
        return "Add data first: training needs examples.";
    }
    if (model.versions.some((version) => version.status === "training")) {
        return "A version is already training.";
    }
    return null;
}

function nextNumber(model: FlowModel): number {
    return Math.max(0, ...model.versions.map((version) => version.number)) + 1;
}

function memoryNeeded(recipe: TrainingSettings): number {
    return 2.1 + recipe.rank * 0.04 + recipe.batch * 0.12;
}

export function TrainDialog({
    model,
    open,
    onOpenChange,
}: {
    model: FlowModel;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const [recipe, setRecipe] = useState<TrainingSettings>(() => defaultRecipe(model));
    const number = nextNumber(model);
    const needed = memoryNeeded(recipe);
    const fits = needed <= WORKER_GB;
    const start = (event: FormEvent) => {
        event.preventDefault();
        const job = startTraining(model.slug, recipe);
        onOpenChange(false);
        router.history.push(`${FLOW}/jobs/${job}`);
    };
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <form onSubmit={start} noValidate className="flex flex-col gap-6">
                    <DialogHeader>
                        <DialogTitle>{`Train v${number} of ${model.name}`}</DialogTitle>
                        <DialogDescription>
                            {`LoRA on ${model.base}, from the install's default recipe.${model.accepted > 0 ? ` Includes ${model.accepted} accepted feedback rows.` : ""}`}
                        </DialogDescription>
                    </DialogHeader>
                    <FieldGroup className="grid grid-cols-2">
                        <Field id="train-rank" label="LoRA rank">
                            <Select
                                value={String(recipe.rank)}
                                onValueChange={(value) =>
                                    setRecipe({ ...recipe, rank: Number(value) })
                                }
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
                                onValueChange={(value) =>
                                    setRecipe({ ...recipe, epochs: value ?? 1 })
                                }
                                min={1}
                                max={10}
                                step={1}
                                format={{ maximumFractionDigits: 0 }}
                            />
                        </Field>
                        <Field id="train-rate" label="Learning rate">
                            <Select
                                value={String(recipe.learningRate)}
                                onValueChange={(value) =>
                                    setRecipe({ ...recipe, learningRate: Number(value) })
                                }
                            >
                                <SelectTrigger id="train-rate">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {RATES.map((rate) => (
                                        <SelectItem key={rate} value={String(rate)}>
                                            {rate.toExponential(0)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field id="train-rows" label="Training rows">
                            <NumberField
                                id="train-rows"
                                value={recipe.rows}
                                onValueChange={(value) =>
                                    setRecipe({ ...recipe, rows: value ?? recipe.rows })
                                }
                                min={10}
                                step={100}
                                format={{ maximumFractionDigits: 0 }}
                            />
                        </Field>
                    </FieldGroup>
                    <p className="flex items-center gap-2">
                        <StatusText tone={fits ? "success" : "destructive"}>
                            {fits ? "Fits" : "Does not fit"}
                        </StatusText>
                        <span className="text-muted-foreground tabular-nums">
                            {`Needs about ${needed.toFixed(1)} GB of ${WORKER_GB} GB on gpu-a10-1 · about 12 minutes`}
                        </span>
                    </p>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Button variant="outline" type="button">
                                Cancel
                            </Button>
                        </DialogClose>
                        <Button type="submit" disabled={!fits}>
                            {`Start v${number}`}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function TrainButton({
    model,
    label,
    variant = "outline",
}: {
    model: FlowModel;
    label?: string;
    variant?: "outline" | "default";
}) {
    const [open, setOpen] = useState(false);
    const blocked = trainBlock(model);
    const button = (
        <Button variant={variant} disabled={Boolean(blocked)} onClick={() => setOpen(true)}>
            <GraduationCap aria-hidden="true" />
            {label ?? `Train v${nextNumber(model)}`}
        </Button>
    );
    return (
        <>
            {blocked ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span className="inline-flex">{button}</span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs whitespace-normal">
                        {blocked}
                    </TooltipContent>
                </Tooltip>
            ) : (
                button
            )}
            {open && <TrainDialog model={model} open={open} onOpenChange={setOpen} />}
        </>
    );
}

function usageOf(model: FlowModel): ModelUsage | null {
    const total = model.traffic.reduce((sum, value) => sum + value, 0);
    if (total === 0 && !model.deployed) {
        return null;
    }
    return {
        days: [],
        daily: model.traffic,
        total,
        previous: model.previous,
        failed: Math.round(total * model.errors),
        last_at: new Date().toISOString(),
        p50_ms: null,
    };
}

function Panel({
    title,
    children,
    footer,
}: { title: string; children: ReactNode; footer?: ReactNode }) {
    return (
        <section className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-panel">
            <h2 className="text-lg font-semibold">{title}</h2>
            <div className="flex flex-1 flex-col gap-3">{children}</div>
            {footer && <div className="flex flex-wrap items-center gap-2">{footer}</div>}
        </section>
    );
}

function IsItGood({ model }: { model: FlowModel }) {
    const live = liveVersion(model);
    const best = live ?? newestFirst(model).find((version) => version.scores);
    const zero = model.versions.find((version) => version.number === 0);
    if (!best?.scores) {
        return (
            <Panel title="Is it good?">
                <p className="text-muted-foreground">
                    {model.kind === "base"
                        ? "Base models are not scored here; build a custom model on it to score it on your data."
                        : "Not scored yet: add data and v0 is scored on its held-out rows."}
                </p>
            </Panel>
        );
    }
    return (
        <Panel
            title="Is it good?"
            footer={
                <Link
                    href={modelHref(model.slug, "versions")}
                    className="text-primary hover:underline"
                >
                    {`All ${model.versions.length} versions →`}
                </Link>
            }
        >
            <div className="flex items-baseline gap-3">
                <span className="text-3xl tabular-nums">{pct(best.scores[0])}</span>
                <span className="text-muted-foreground">{`${model.metrics[0].toLowerCase()}, v${best.number}${live ? " (live)" : ""}`}</span>
            </div>
            {zero?.scores && zero.number !== best.number && (
                <p className="text-sm">
                    <Delta
                        value={best.scores[0] - zero.scores[0]}
                        suffix="vs v0, the base with instructions only"
                    />
                </p>
            )}
            <p className="text-sm text-muted-foreground">{`Scored on ${count(model.heldOut)} held-out rows.`}</p>
        </Panel>
    );
}

function IsItWorking({ model }: { model: FlowModel }) {
    if (!model.deployed) {
        return (
            <Panel title="Is it working?">
                <p className="text-muted-foreground">Not deployed, so nothing calls it yet.</p>
            </Panel>
        );
    }
    return (
        <Panel
            title="Is it working?"
            footer={
                <Link
                    href={`${FLOW}/monitor?model=${model.slug}`}
                    className="text-primary hover:underline"
                >
                    Traffic in Monitor →
                </Link>
            }
        >
            <Requests usage={usageOf(model)} live />
            <div className="flex flex-wrap gap-x-8 gap-y-2">
                <Stat label="Latency p95" value={model.p95 ? `${model.p95} ms` : "–"} />
                <Stat label="Errors" value={`${(model.errors * 100).toFixed(1)}%`} />
            </div>
        </Panel>
    );
}

function WhatNext({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const step = nextStep(state, model);
    if (!step) {
        return (
            <Panel title="What next?">
                <p className="text-muted-foreground">
                    Build a custom model on it to train on your data.
                </p>
                <div>
                    <Button asChild>
                        <Link href={`${FLOW}/models/new?base=${model.slug}`}>
                            Add a model on it
                        </Link>
                    </Button>
                </div>
            </Panel>
        );
    }
    return (
        <Panel title="What next?">
            <p className="text-muted-foreground">{step.detail}</p>
            <div>
                {step.train ? (
                    <TrainButton model={model} label={step.label} variant="default" />
                ) : (
                    <Button asChild>
                        <Link href={step.href}>{step.label}</Link>
                    </Button>
                )}
            </div>
        </Panel>
    );
}

const CANNED = "refund_request";

function TryIt({ model }: { model: FlowModel }) {
    const [text, setText] = useState("I was charged twice, please send one payment back.");
    const [answer, setAnswer] = useState<string | null>(null);
    const ready =
        model.versions.some((version) => version.status === "ready") || model.kind === "base";
    return (
        <Section
            title="Try it"
            caption={
                model.deployed
                    ? "Asks the live version."
                    : "Loads the newest ready version for a quick test; nothing is deployed."
            }
        >
            <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                    event.preventDefault();
                    setAnswer(
                        model.kind === "base"
                            ? "This sounds like a billing issue: a duplicate charge that should be refunded."
                            : CANNED,
                    );
                }}
            >
                <div className="flex gap-2">
                    <Input
                        aria-label="Message"
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                    />
                    <Button type="submit" disabled={!ready || !text.trim()}>
                        Ask
                    </Button>
                </div>
                {answer && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted px-3 py-2">
                        <span className={model.kind === "base" ? undefined : "font-mono text-sm"}>
                            {answer}
                        </span>
                        <Link
                            href={`${FLOW}/playground?model=${model.slug}`}
                            className="text-sm text-primary hover:underline"
                        >
                            Continue in the Playground →
                        </Link>
                    </div>
                )}
            </form>
        </Section>
    );
}

function Details({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const data = state.datasets.find((item) => item.slug === model.dataset);
    const items: [string, ReactNode][] =
        model.kind === "base"
            ? [
                  ["Publisher", model.publisher],
                  ["Size", model.size ?? "–"],
                  ["Licence", model.licence],
                  ["Serving", model.serveOnly ? "Serve-only (GGUF)" : "Serve and train"],
                  [
                      "API name",
                      <span key="api" className="font-mono text-sm">
                          {model.slug}
                      </span>,
                  ],
              ]
            : [
                  [
                      "Base",
                      <Link
                          key="base"
                          href={modelHref(baseSlug(model))}
                          className="text-primary hover:underline"
                      >
                          {model.base}
                      </Link>,
                  ],
                  ["Licence", model.licence],
                  [
                      "Data",
                      data ? (
                          <Link
                              key="data"
                              href={datasetHref(data.slug)}
                              className="text-primary hover:underline"
                          >{`${data.name} v${data.version}`}</Link>
                      ) : (
                          "None yet"
                      ),
                  ],
                  [
                      "API name",
                      <span key="api" className="font-mono text-sm">
                          {model.slug}
                      </span>,
                  ],
                  ["Versions", String(model.versions.length)],
              ];
    return (
        <Section title="Details">
            <Facts items={items} />
        </Section>
    );
}

function baseSlug(model: FlowModel): string {
    return model.base ? model.base.toLowerCase().replace(/[^a-z0-9.]+/g, "-") : model.slug;
}

function Overview({ model }: { model: FlowModel }) {
    return (
        <div className="flex flex-col gap-4">
            <div className="grid gap-4 lg:grid-cols-3">
                <IsItGood model={model} />
                <IsItWorking model={model} />
                <WhatNext model={model} />
            </div>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <TryIt model={model} />
                <Details model={model} />
            </div>
        </div>
    );
}

function VersionsTab({ model }: { model: FlowModel }) {
    const [deploy, setDeploy] = useState<DeployIntent>(null);
    const live = liveVersion(model);
    if (model.versions.length === 0) {
        return (
            <Section title="Versions">
                <p className="text-muted-foreground">
                    No versions yet: add data and v0 is scored at once.
                </p>
            </Section>
        );
    }
    return (
        <Section
            title="Versions"
            caption="Every version, newest first. Open one for its scores, answers and model card."
            actions={<TrainButton model={model} />}
        >
            <div className="overflow-x-auto rounded-md border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Version</TableHead>
                            <TableHead>Kind</TableHead>
                            <TableHead className="text-right">{model.metrics[0]}</TableHead>
                            <TableHead className="text-right">Against live</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Created</TableHead>
                            <TableHead />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {newestFirst(model).map((version) => {
                            const label = deployLabel(model, version);
                            const blocked = deployBlocked(version);
                            return (
                                <TableRow key={version.number}>
                                    <TableCell>
                                        <Link
                                            href={versionHref(model.slug, version.number)}
                                            className="font-medium hover:underline"
                                        >
                                            {`v${version.number}`}
                                        </Link>
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {KIND_LABELS[version.kind]}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        {pct(version.scores?.[0])}
                                    </TableCell>
                                    <TableCell className="text-right text-sm">
                                        {live &&
                                        version.scores &&
                                        live.scores &&
                                        live.number !== version.number ? (
                                            <Delta value={version.scores[0] - live.scores[0]} />
                                        ) : null}
                                    </TableCell>
                                    <TableCell>
                                        <StateBadge model={model} version={version} />
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {relativeTime(createdAt(version))}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <span className="inline-flex gap-1">
                                            {label && !blocked && (
                                                <Button
                                                    variant="secondary"
                                                    size="sm"
                                                    onClick={() => setDeploy({ model, version })}
                                                >
                                                    {label}
                                                </Button>
                                            )}
                                            {live &&
                                                version.scores &&
                                                live.number !== version.number && (
                                                    <Button variant="outline" size="sm" asChild>
                                                        <Link
                                                            href={compareHref(
                                                                model.slug,
                                                                live.number,
                                                                version.number,
                                                            )}
                                                        >
                                                            Compare
                                                        </Link>
                                                    </Button>
                                                )}
                                        </span>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
            <DeployDialog intent={deploy} onOpenChange={(open) => !open && setDeploy(null)} />
        </Section>
    );
}

function DataTab({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const current = state.datasets.find((item) => item.slug === model.dataset);
    const [picked, setPicked] = useState(state.datasets[0]?.slug ?? "");
    if (current) {
        return (
            <Section
                title="Training data"
                caption="What the next version trains on and every version is scored on."
                actions={
                    <Button variant="outline" asChild>
                        <Link href={datasetHref(current.slug)}>Open dataset</Link>
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
                                {current.name}
                            </Link>,
                        ],
                        [
                            "Version",
                            <span
                                key="v"
                                className="tabular-nums"
                            >{`v${current.version} · ${count(current.rows)} rows`}</span>,
                        ],
                        [
                            "Split",
                            <span
                                key="s"
                                className="tabular-nums"
                            >{`${count(current.split[0])} train · ${count(current.split[1])} held out`}</span>,
                        ],
                        ["Labels", current.labels.map(([label]) => label).join(", ")],
                        [
                            "Accepted feedback",
                            model.accepted > 0
                                ? `${model.accepted} rows join the next version`
                                : "None waiting",
                        ],
                    ]}
                />
            </Section>
        );
    }
    return (
        <Section
            title="Training data"
            caption="Pick a dataset, or upload a file on the Data page first."
        >
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
                                <span className="flex-1 font-medium">{item.name}</span>
                                <span className="font-mono text-sm text-muted-foreground">
                                    {item.file}
                                </span>
                                <span className="w-24 text-right text-muted-foreground tabular-nums">{`${count(item.rows)} rows`}</span>
                            </label>
                        </li>
                    ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                    <Button disabled={!picked} onClick={() => attachDataset(model.slug, picked)}>
                        Use this dataset
                    </Button>
                    <Button variant="outline" asChild>
                        <Link href={`${FLOW}/data?for=${model.slug}`}>Upload a file</Link>
                    </Button>
                </div>
            </div>
        </Section>
    );
}

function snippets(model: string, key: string) {
    const url = "https://minibrain.internal/v1/chat/completions";
    return [
        {
            id: "curl",
            label: "curl",
            language: "bash" as const,
            code: `curl ${url} \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${model}", "messages": [{"role": "user", "content": "I was charged twice"}]}'`,
        },
        {
            id: "python",
            label: "Python",
            language: "python" as const,
            code: `from openai import OpenAI\n\nclient = OpenAI(base_url="https://minibrain.internal/v1", api_key="${key}")\nreply = client.chat.completions.create(\n    model="${model}",\n    messages=[{"role": "user", "content": "I was charged twice"}],\n)\nprint(reply.choices[0].message.content)`,
        },
    ];
}

function ApiTab({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const [created, setCreated] = useState<string | null>(null);
    const [shown, setShown] = useState<string | null>(null);
    const keys = state.keys[model.slug] ?? [];
    const key = created ?? "$MINIBRAIN_API_KEY";
    return (
        <div className="flex flex-col gap-4">
            <Section
                title="Keys"
                caption={`Keys that can call ${model.slug}. A key is shown once, when it is created.`}
                actions={
                    <Button
                        onClick={() => {
                            const fresh = createKey(model.slug);
                            setCreated(fresh);
                            setShown(fresh);
                        }}
                    >
                        <KeyRound aria-hidden="true" />
                        Create key
                    </Button>
                }
            >
                {keys.length === 0 ? (
                    <p className="text-muted-foreground">No keys yet.</p>
                ) : (
                    <ul className="flex flex-col gap-1">
                        {keys.map((prefix) => (
                            <li key={prefix} className="font-mono text-sm">
                                {prefix}
                            </li>
                        ))}
                    </ul>
                )}
            </Section>
            <Section
                title="Call it"
                caption={
                    model.deployed
                        ? `OpenAI-compatible, by name. ${created ? "The snippets carry the key you just created." : "Create a key and the snippets fill with it."}`
                        : "Deploy a version first; until then these calls are refused."
                }
            >
                <CodeTabs items={snippets(model.slug, key)} />
            </Section>
            <Dialog open={shown !== null} onOpenChange={(open) => !open && setShown(null)}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Copy your key now</DialogTitle>
                        <DialogDescription>
                            It is not shown again. The snippets below now use it.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex items-center gap-2 rounded-md border bg-muted px-3 py-2">
                        <span className="flex-1 font-mono text-sm break-all">{shown}</span>
                        <CopyButton value={shown ?? ""} label="Copy key" />
                    </div>
                    <DialogFooter>
                        <DialogClose asChild>
                            <Button>Done</Button>
                        </DialogClose>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function tabOf(value: string | undefined, model: FlowModel): ModelTab {
    const tabs = tabsOf(model);
    return tabs.find((tab) => tab === value) ?? "overview";
}

function tabsOf(model: FlowModel): ModelTab[] {
    return model.kind === "base" ? ["overview", "api"] : ["overview", "versions", "data", "api"];
}

function Header({ model }: { model: FlowModel }) {
    const live = liveVersion(model);
    const entry = catalogEntry(model.slug);
    const caption =
        model.kind === "base"
            ? `${model.size} · ${model.licence}${entry ? "" : ""}`
            : `On ${model.base} · ${live ? `v${live.number} live` : "not deployed"}`;
    return (
        <PageHeader
            title={model.name}
            icon={<ModelAvatar model={model} size="lg" />}
            badge={<Badge variant="outline">{model.kind === "base" ? "Base" : "Custom"}</Badge>}
            caption={caption}
            actions={
                <>
                    {model.deployed ? (
                        <StatusText tone="success" className="px-1 text-sm">
                            Live
                        </StatusText>
                    ) : (
                        <span className="px-1 text-sm text-muted-foreground">Not deployed</span>
                    )}
                    {(model.kind === "base" ||
                        model.versions.some((version) => version.status === "ready")) && (
                        <Button variant="outline" asChild>
                            <Link href={`${FLOW}/playground?model=${model.slug}`}>
                                <Play aria-hidden="true" />
                                Try in Playground
                            </Link>
                        </Button>
                    )}
                    {model.kind === "custom" && <TrainButton model={model} />}
                </>
            }
        />
    );
}

export function FlowModelPage() {
    const params = useParams({ strict: false }) as { model?: string; tab?: string };
    const model = useFlowModel(params.model);
    if (!model) {
        return (
            <Page>
                <Crumbs
                    items={[{ label: "Models", href: flowHref() }, { label: params.model ?? "" }]}
                />
                <p className="text-muted-foreground">{`No model called ${params.model}.`}</p>
            </Page>
        );
    }
    const tab = tabOf(params.tab, model);
    return (
        <Page>
            <Crumbs items={[{ label: "Models", href: flowHref() }, { label: model.name }]} />
            <Header model={model} />
            <TabNav
                label={`${model.name} pages`}
                tabs={tabsOf(model).map((item) => ({
                    href: modelHref(model.slug, item),
                    label: TAB_LABELS[item],
                }))}
            />
            <div className={cn("pt-2")}>
                {tab === "overview" && <Overview model={model} />}
                {tab === "versions" && <VersionsTab model={model} />}
                {tab === "data" && <DataTab model={model} />}
                {tab === "api" && <ApiTab model={model} />}
            </div>
        </Page>
    );
}
