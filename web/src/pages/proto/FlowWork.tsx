import { useParams, useRouter, useRouterState } from "@tanstack/react-router";
import {
    Box,
    ChartColumn,
    ChartLine,
    Check,
    Database,
    Hourglass,
    ListChecks,
    Logs,
    Package,
    Rows3,
    Send,
    ShieldCheck,
    SlidersHorizontal,
    Split,
} from "lucide-react";
import {
    Badge,
    Button,
    Checkbox,
    DropZone,
    Input,
    Link,
    type LogEntry,
    LogViewer,
    SegmentedTabs,
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tabs,
    TabsList,
    TabsTrigger,
    useToast,
} from "obp-ui";
import {
    type FormEvent,
    type MouseEvent,
    type ReactNode,
    useEffect,
    useRef,
    useState,
} from "react";
import { Facts } from "~/components/Facts";
import { PageHeader } from "~/components/PageHeader";
import { Page, PanelSection, PanelSections, Section, Stat } from "~/components/Section";
import { StepChart, type StepSeries } from "~/components/charts/StepChart";
import { ChartLegend, type ChartSeries, TimeChart } from "~/components/charts/TimeChart";
import { ProgressBar, StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { useSearchParam } from "~/lib/listSearch";
import { relativeTime } from "~/lib/time";
import { ArtifactLine } from "./flowExport";
import { useCan } from "./flowOverlays";
import { BulkJobs, JobStatusText } from "./flowTraining";
import {
    BASELINE_HINT,
    DEVICE,
    FLOW,
    type FlowModel,
    type FlowVersion,
    type Job,
    type JobKind,
    LOSS_STEPS,
    SAMPLE_FILE,
    attachDataset,
    cancelJobs,
    changedSettings,
    countRequest,
    createdAt,
    datasetHref,
    datasetOf,
    exportOption,
    exportSize,
    findVersion,
    jobHref,
    jobOfVersion,
    liveVersion,
    lossCurve,
    modelHref,
    nextStep,
    pct,
    points,
    rate,
    retryWithQLoRA,
    reviewFeedback,
    rowsSinceLive,
    saveExample,
    uploadSample,
    useFlowState,
    versionHref,
    versionName,
} from "./modelsFlowData";
import { Crumbs, MakeLiveButton } from "./modelsFlowParts";

function modelName(models: FlowModel[], slug: string): string {
    return models.find((model) => model.slug === slug)?.name ?? slug;
}

export function FlowDataPage() {
    const state = useFlowState();
    const router = useRouter();
    const target = useSearchParam("for");
    const upload = () => {
        const slug = uploadSample();
        router.history.push(`${datasetHref(slug)}${target ? `?for=${target}` : ""}`);
    };
    return (
        <Page wide>
            <PageHeader
                title="Data"
                caption="Datasets your models train and are scored on. Each has one page; models link to it."
            />
            <DropZone
                onFiles={upload}
                accept=".csv,.jsonl,.parquet"
                title="Drop a CSV, JSONL or Parquet file"
                description="It is checked and split before any model uses it."
            >
                <Button variant="ghost" onClick={upload}>
                    {`Use the sample ${SAMPLE_FILE}`}
                </Button>
            </DropZone>
            <PanelSections>
                <PanelSection
                    icon={Database}
                    title="Datasets"
                    description="Open a dataset to preview its rows, checks and splits."
                    flush
                >
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="pl-panel">Dataset</TableHead>
                                <TableHead>File</TableHead>
                                <TableHead className="text-right">Rows</TableHead>
                                <TableHead className="text-right">Version</TableHead>
                                <TableHead>Used by</TableHead>
                                <TableHead className="pr-panel">Updated</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {state.datasets.map((item) => {
                                const users = state.models.filter(
                                    (model) => model.dataset === item.slug,
                                );
                                return (
                                    <TableRow key={item.slug}>
                                        <TableCell className="pl-panel">
                                            <Link
                                                href={datasetHref(item.slug)}
                                                className="font-semibold hover:underline"
                                            >
                                                {item.name}
                                            </Link>
                                        </TableCell>
                                        <TableCell className="font-mono text-sm text-muted-foreground">
                                            {item.file}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            {count(item.rows)}
                                        </TableCell>
                                        <TableCell className="text-right">{`v${item.version}`}</TableCell>
                                        <TableCell>
                                            {users.length === 0 ? (
                                                <span className="text-muted-foreground">
                                                    No model
                                                </span>
                                            ) : (
                                                users.map((model, index) => (
                                                    <span key={model.slug}>
                                                        {index > 0 && ", "}
                                                        <Link
                                                            href={modelHref(model.slug)}
                                                            className="text-primary hover:underline"
                                                        >
                                                            {model.name}
                                                        </Link>
                                                    </span>
                                                ))
                                            )}
                                        </TableCell>
                                        <TableCell className="pr-panel text-muted-foreground">
                                            {relativeTime(createdAt(item))}
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </PanelSection>
            </PanelSections>
        </Page>
    );
}

const CHECK_TONES: Record<string, "success" | "warning"> = {
    ok: "success",
    warning: "warning",
};

export function FlowDatasetPage() {
    const { dataset: slug } = useParams({ strict: false }) as {
        dataset?: string;
    };
    const state = useFlowState();
    const router = useRouter();
    const toast = useToast();
    const target = useSearchParam("for");
    const item = state.datasets.find((entry) => entry.slug === slug);
    const custom = state.models.filter((model) => model.kind === "custom");
    const [model, setModel] = useState(target ?? state.focus ?? custom[0]?.slug ?? "");
    if (!item) {
        return (
            <Page>
                <p className="text-muted-foreground">No such dataset.</p>
            </Page>
        );
    }
    const users = state.models.filter((entry) => entry.dataset === item.slug);
    const attach = () => {
        attachDataset(model, item.slug);
        toast({
            title: `${item.name} is ${modelName(state.models, model)}'s data`,
            description: "v0 was scored on its held-out rows: 71.2%.",
            tone: "success",
        });
        router.history.push(modelHref(model));
    };
    const total = item.labels.reduce((sum, [, value]) => sum + value, 0);
    return (
        <Page wide>
            <Crumbs items={[{ label: "Data", href: `${FLOW}/data` }, { label: item.name }]} />
            <PageHeader
                title={item.name}
                caption={
                    <span>
                        <span className="font-mono text-sm">{item.file}</span>
                        {` · v${item.version} · ${count(item.rows)} rows`}
                    </span>
                }
                actions={
                    <>
                        <Select value={model} onValueChange={(value) => setModel(String(value))}>
                            <SelectTrigger aria-label="Model" className="w-auto min-w-48">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {custom.map((entry) => (
                                    <SelectItem key={entry.slug} value={entry.slug}>
                                        {entry.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Button disabled={!model} onClick={attach}>
                            Use for this model
                        </Button>
                    </>
                }
            />
            {users.length > 0 && (
                <p className="text-muted-foreground">
                    {"Used by "}
                    {users.map((entry, index) => (
                        <span key={entry.slug}>
                            {index > 0 && ", "}
                            <Link
                                href={modelHref(entry.slug)}
                                className="text-primary hover:underline"
                            >
                                {entry.name}
                            </Link>
                        </span>
                    ))}
                    .
                </p>
            )}
            <div className="grid items-start gap-x-6 gap-y-8 pt-2 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <PanelSection
                    icon={Rows3}
                    title="Preview"
                    description={`First ${item.preview.length} of ${count(item.rows)} rows.`}
                    flush
                >
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="pl-panel">{item.columns[0]}</TableHead>
                                <TableHead className="pr-panel">{item.columns[1]}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {item.preview.map(([text, label]) => (
                                <TableRow key={text}>
                                    <TableCell className="max-w-96 truncate pl-panel" title={text}>
                                        {text}
                                    </TableCell>
                                    <TableCell className="pr-panel font-mono text-sm">
                                        {label}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </PanelSection>
                <div className="flex flex-col gap-8">
                    <PanelSection
                        icon={ShieldCheck}
                        title="Quality"
                        description="Checks run on every new version before a model uses it."
                    >
                        <ul className="flex flex-col gap-1.5">
                            {item.checks.map((check) => (
                                <li
                                    key={check.name}
                                    className="flex flex-wrap items-baseline gap-2"
                                >
                                    <Badge variant={CHECK_TONES[check.state]}>
                                        {check.state === "ok" ? "Passed" : "Warning"}
                                    </Badge>
                                    <span className="font-medium">{check.name}</span>
                                    <span className="text-sm text-muted-foreground">
                                        {check.detail}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </PanelSection>
                    <PanelSection
                        icon={Split}
                        title="Splits"
                        description="Held-out rows are never trained on; every version is scored on them."
                    >
                        <div className="flex flex-col gap-3">
                            <div className="flex gap-8">
                                <Stat label="Train" value={count(item.split[0])} />
                                <Stat label="Held out" value={count(item.split[1])} />
                            </div>
                            <Table>
                                <TableBody>
                                    {item.labels.map(([label, value]) => (
                                        <TableRow key={label}>
                                            <TableCell className="font-mono text-sm">
                                                {label}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                {count(value)}
                                            </TableCell>
                                            <TableCell className="w-20 text-right text-muted-foreground">{`${Math.round((value / total) * 100)}%`}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    </PanelSection>
                </div>
            </div>
        </Page>
    );
}

const LOSS_SERIES: StepSeries[] = [
    { key: "loss", label: "Training loss", color: "var(--primary)" },
    {
        key: "heldOut",
        label: "Held-out loss",
        color: "var(--file-sql)",
        dots: true,
    },
];

const JOB_KINDS: Record<JobKind, string> = {
    train: "Training",
    score: "Scoring",
    judge: "Judge",
    download: "Download",
    import: "Import",
    export: "Export",
};

function reached(job: Job): number {
    return job.status === "failed" ? 0.3 : job.progress;
}

function exportLines(job: Job, start: number): LogEntry[] {
    const format = job.format ?? "adapter";
    const steps = [
        "Loaded the adapter and checked its SHA-256",
        format === "adapter"
            ? "Wrote adapter_model.safetensors"
            : "Loaded base weights (hash checked)",
        format === "adapter" ? "Wrote adapter_config.json" : "Merged the adapter into the base",
        format === "gguf-q4" || format === "gguf-q8"
            ? `Converted to GGUF and quantised to ${format === "gguf-q4" ? "Q4_K_M" : "Q8_0"}`
            : "Wrote the model card",
        "Computed SHA-256 of every file",
    ];
    const reached = Math.floor(job.progress * steps.length);
    return steps.slice(0, Math.max(1, reached)).map((message, index) => ({
        id: index + 1,
        level: "info" as const,
        source: "export",
        message,
        time: start + index * 1200,
    }));
}

function transferLines(job: Job, start: number): LogEntry[] {
    const verb = job.kind === "download" ? "Downloaded" : "Imported";
    return [
        `${job.kind === "download" ? "Fetching" : "Reading"} weights for ${job.model}`,
        `${verb} every shard`,
        "Checked SHA-256 of every file against the catalogue",
    ].map((message, index) => ({
        id: index + 1,
        level: "info" as const,
        source: job.kind,
        message,
        time: start + index * 4000,
    }));
}

function logLines(job: Job, version: FlowVersion | undefined): LogEntry[] {
    const start = new Date(createdAt(job)).getTime();
    if (job.kind === "export") {
        return exportLines(job, start);
    }
    if (job.kind === "download" || job.kind === "import") {
        return transferLines(job, start);
    }
    const settings = version?.settings;
    const rows = settings?.rows ?? version?.data.rows ?? 0;
    const lines: LogEntry[] = [
        {
            id: 1,
            level: "info",
            source: "trainer",
            message: "Loaded base weights (hash checked)",
            time: start,
        },
        {
            id: 2,
            level: "info",
            source: "trainer",
            message: `Data v${version?.data.number ?? 1}: ${count(rows)} train rows, held-out rows kept apart`,
            time: start + 2000,
        },
    ];
    if (settings) {
        lines.push({
            id: 3,
            level: "info",
            source: "trainer",
            message: `Plan: SFT, ${settings.adapter} rank ${settings.rank}, ${settings.epochs} epochs, rate ${rate(settings.learningRate)}, batch ${settings.batch}`,
            time: start + 3000,
        });
    }
    if (job.kind === "judge") {
        lines.push({
            id: 4,
            level: "info",
            source: "judge",
            message: "Rubric: right queue, no invented facts, polite tone; scored 1 to 5",
            time: start + 3000,
        });
    }
    const steps = job.kind === "train" ? Math.floor(reached(job) * 6) : 0;
    for (let index = 1; index <= steps; index += 1) {
        lines.push({
            id: 3 + index,
            level: "info",
            source: "trainer",
            message: `step ${index * 120} of ${LOSS_STEPS} · loss ${(2.2 * Math.exp(-index * 0.7) + 0.32).toFixed(3)}`,
            time: start + 3000 + index * 1600,
        });
    }
    if (job.status === "done") {
        lines.push({
            id: 20,
            level: "info",
            source: "trainer",
            message: "Scored on held-out rows; adapter saved",
            time: start + 14000,
        });
    }
    if (job.error) {
        lines.push({
            id: 21,
            level: "error",
            source: "trainer",
            message: job.error,
            time: start + 9000,
        });
    }
    return lines;
}

function Outcome({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const live = liveVersion(model);
    const zero = findVersion(model, 0);
    const score = version.scores?.[0];
    if (score === undefined) {
        return null;
    }
    const against = [
        live && live.number !== version.number && live.scores
            ? `${points(score - live.scores[0])} vs live v${live.number}`
            : null,
        zero?.scores && zero.number !== version.number
            ? `${points(score - zero.scores[0])} vs baseline v0`
            : null,
    ].filter(Boolean);
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-success/40 bg-success-soft px-4 py-3">
            <span className="tabular-nums">
                <span className="font-semibold">{`v${version.number} scored ${pct(score)}`}</span>
                {against.length > 0 && `: ${against.join(", ")}.`}
            </span>
            <span className="flex gap-2">
                <Button variant="outline" asChild>
                    <Link href={versionHref(model.slug, version.number)}>
                        {`Open v${version.number}`}
                    </Link>
                </Button>
                <MakeLiveButton
                    model={model}
                    version={version}
                    label={`Make v${version.number} live`}
                />
            </span>
        </div>
    );
}

function Inputs({
    model,
    version,
    kind,
}: { model: FlowModel; version: FlowVersion; kind: JobKind }) {
    const dataset = datasetOf(model);
    const since = model.live === version.number ? null : rowsSinceLive(model, version.data.rows);
    const settings = version.settings;
    const items: [string, ReactNode][] = [
        [
            kind === "train" ? "Produced" : "Version",
            <Link
                key="v"
                href={versionHref(model.slug, version.number)}
                className="text-primary hover:underline"
            >
                {`${versionName(version)} of ${model.name}`}
            </Link>,
        ],
        [
            "Data",
            <span key="d" className="tabular-nums">
                {`${dataset?.slug ?? "data"} v${version.data.number} · ${count(version.data.rows)} rows`}
                {since !== null && since !== 0 && (
                    <span className="text-muted-foreground">{`, ${since > 0 ? "+" : "−"}${count(Math.abs(since))} since live`}</span>
                )}
            </span>,
        ],
        ["Base", model.base ?? model.name],
        [
            "Method",
            kind === "judge"
                ? "Judge model Qwen3 8B with the rubric on the Evaluations page"
                : version.kind === "prompt"
                  ? `${BASELINE_HINT}, scored only`
                  : "Supervised fine-tuning (SFT)",
        ],
    ];
    if (settings && kind === "train") {
        const changed = changedSettings(settings);
        items.push(
            [
                "Settings",
                <span key="s" className="tabular-nums">
                    {`${settings.adapter} rank ${settings.rank} · ${settings.epochs} epochs · rate ${rate(settings.learningRate)} · batch ${settings.batch}`}
                    <span className="block text-sm text-muted-foreground">
                        {changed.length === 0
                            ? "The install defaults."
                            : `Changed from the defaults: ${changed.join(", ")}.`}
                    </span>
                </span>,
            ],
            [
                "Training rows",
                <span key="r" className="tabular-nums">
                    {`${count(settings.rows)} train · ${count(model.heldOut)} held out`}
                </span>,
            ],
        );
    }
    return (
        <SettingsAndData>
            <Facts items={items} />
        </SettingsAndData>
    );
}

function SettingsAndData({ children }: { children: ReactNode }) {
    return (
        <PanelSection
            icon={SlidersHorizontal}
            title="Settings and data"
            description="What this job read and the settings it ran with."
        >
            {children}
        </PanelSection>
    );
}

function Run({ job }: { job: Job }) {
    const step = Math.round(reached(job) * LOSS_STEPS);
    return (
        <PanelSection
            icon={Hourglass}
            title="Progress"
            description="Where the job is and the device it runs on."
        >
            <div className="flex flex-col gap-4">
                <JobStatusText job={job} />
                <ProgressBar
                    value={reached(job)}
                    label={`Job ${job.id} progress`}
                    className="w-full"
                />
                <Facts
                    items={[
                        job.kind !== "train"
                            ? [
                                  "Done",
                                  <span key="s" className="tabular-nums">
                                      {`${Math.round(job.progress * 100)}%`}
                                  </span>,
                              ]
                            : [
                                  "Step",
                                  <span key="s" className="tabular-nums">
                                      {`${count(step)} of ${count(LOSS_STEPS)}`}
                                  </span>,
                              ],
                        [
                            "Device",
                            <span key="d" className="font-mono text-sm">
                                {job.device ?? DEVICE}
                            </span>,
                        ],
                        [
                            "Started",
                            <time key="t" dateTime={createdAt(job)} className="tabular-nums">
                                {relativeTime(createdAt(job))}
                            </time>,
                        ],
                        [
                            job.status === "running" ? "Time left" : "Took",
                            <span key="m" className="tabular-nums">
                                {job.status === "running"
                                    ? `${Math.max(1, Math.ceil((1 - job.progress) * 10))} s`
                                    : job.minutes
                                      ? `${job.minutes} min`
                                      : "–"}
                            </span>,
                        ],
                    ]}
                />
            </div>
        </PanelSection>
    );
}

function Failed({ model, version, job }: { model: FlowModel; version: FlowVersion; job: Job }) {
    const router = useRouter();
    const toast = useToast();
    const memory = /memory/i.test(job.error ?? "");
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive-soft px-4 py-3">
            <span className="flex min-w-0 flex-col">
                <span className="font-semibold">{`v${version.number} failed, so it was never scored`}</span>
                <span className="text-sm">{job.error}</span>
            </span>
            {memory && (
                <Button
                    variant="outline"
                    onClick={() => {
                        const number = retryWithQLoRA(model.slug, version.number);
                        const next = jobOfVersion(model.slug, number);
                        toast({ title: `v${number} is training with QLoRA`, tone: "success" });
                        if (next) {
                            router.history.push(jobHref(next));
                        }
                    }}
                >
                    Retry with QLoRA
                </Button>
            )}
        </div>
    );
}

const JOB_VERBS: Record<JobKind, string> = {
    train: "Trains",
    score: "Scores",
    judge: "Judges",
    download: "Downloads",
    import: "Imports",
    export: "Exports",
};

function JobContext({ job, model }: { job: Job; model: FlowModel | undefined }) {
    const link = "text-primary hover:underline";
    if (!model) {
        return <span>{`${JOB_VERBS[job.kind]} ${job.model}`}</span>;
    }
    if (model.kind === "base") {
        const variant = model.variants[0]?.format ?? "BF16";
        return (
            <span>
                {`${JOB_VERBS[job.kind]} `}
                <Link href={modelHref(model.slug)} className={link}>
                    {`${model.name} · ${variant}`}
                </Link>
            </span>
        );
    }
    if (job.version === null) {
        return (
            <span>
                {`${JOB_VERBS[job.kind]} `}
                <Link href={modelHref(model.slug)} className={link}>
                    {model.name}
                </Link>
            </span>
        );
    }
    if (job.kind === "train") {
        return (
            <span>
                {"Trains "}
                <Link href={modelHref(model.slug)} className={link}>
                    {model.name}
                </Link>
                {" → "}
                <Link href={versionHref(model.slug, job.version)} className={link}>
                    {`v${job.version}`}
                </Link>
            </span>
        );
    }
    return (
        <span>
            {`${JOB_VERBS[job.kind]} `}
            <Link href={versionHref(model.slug, job.version)} className={link}>
                {`${model.name} v${job.version}`}
            </Link>
        </span>
    );
}

export function FlowJobPage() {
    const { id } = useParams({ strict: false }) as { id?: string };
    const router = useRouter();
    const pathname = useRouterState({ select: (current) => current.location.pathname });
    const state = useFlowState();
    const job = state.jobs.find((item) => item.id === Number(id));
    const canonical = job ? jobHref(job.id) : null;
    useEffect(() => {
        const here = pathname.replace(/\/$/, "");
        const onThisJob = [`${FLOW}/jobs/${id}`, `${FLOW}/training/${id}`].includes(here);
        if (canonical && onThisJob && here !== canonical) {
            router.history.replace(canonical);
        }
    }, [canonical, pathname, router, id]);
    if (!job) {
        return (
            <Page>
                <Crumbs
                    items={[{ label: "Jobs", href: `${FLOW}/jobs` }, { label: `Job #${id}` }]}
                />
                <p className="text-muted-foreground">No such job.</p>
            </Page>
        );
    }
    const model = state.models.find((item) => item.slug === job.model);
    const version = model && job.version !== null ? findVersion(model, job.version) : undefined;
    const rows = lossCurve(job.version ?? 1).filter((row) => row.step <= LOSS_STEPS * reached(job));
    const artifact = state.exports.find((item) => item.jobId === job.id);
    return (
        <Page>
            <Crumbs
                items={
                    job.kind === "train"
                        ? [
                              { label: "Training", href: `${FLOW}/training` },
                              { label: `Job #${job.id}` },
                          ]
                        : [{ label: "Jobs", href: `${FLOW}/jobs` }, { label: `Job #${job.id}` }]
                }
            />
            <PageHeader
                title={`Job #${job.id}`}
                caption={
                    <span>
                        <JobContext job={job} model={model} />
                        {` · started ${relativeTime(createdAt(job))}`}
                    </span>
                }
                actions={
                    job.status === "running" && (
                        <Button variant="outline" onClick={() => cancelJobs([job.id])}>
                            Cancel
                        </Button>
                    )
                }
            />
            {model &&
                version &&
                job.status === "done" &&
                version.scores &&
                job.kind !== "export" && <Outcome model={model} version={version} />}
            {model && version && job.status === "failed" && (
                <Failed model={model} version={version} job={job} />
            )}
            <PanelSections>
                {model && version && artifact && (
                    <PanelSection
                        icon={Package}
                        title={job.status === "done" ? "Artifact" : "Artifact, when done"}
                        description={`Also listed under Exports on v${version.number}'s page.`}
                        flush
                    >
                        <ul>
                            <ArtifactLine
                                model={model}
                                version={version}
                                artifact={artifact}
                                job={job}
                            />
                        </ul>
                    </PanelSection>
                )}
                <div className="grid items-start gap-x-6 gap-y-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                    <Run job={job} />
                    {model && version && job.kind === "export" && job.format ? (
                        <SettingsAndData>
                            <Facts
                                items={[
                                    [
                                        "Version",
                                        <Link
                                            key="v"
                                            href={versionHref(model.slug, version.number)}
                                            className="text-primary hover:underline"
                                        >
                                            {`${versionName(version)} of ${model.name}`}
                                        </Link>,
                                    ],
                                    ["Base", model.base ?? model.name],
                                    ["Format", exportOption(job.format).label],
                                    ["Size", exportSize(model, version, job.format)],
                                    ["Runs", exportOption(job.format).runs],
                                ]}
                            />
                        </SettingsAndData>
                    ) : model && version ? (
                        <Inputs model={model} version={version} kind={job.kind} />
                    ) : (
                        <SettingsAndData>
                            <p className="text-muted-foreground">
                                <JobContext job={job} model={model} />
                            </p>
                        </SettingsAndData>
                    )}
                </div>
                {job.kind === "train" && (
                    <PanelSection
                        icon={ChartLine}
                        title="Loss"
                        description="Training loss every 24 steps, held-out loss every 120."
                    >
                        <div className="flex flex-col gap-3">
                            <ChartLegend series={LOSS_SERIES} />
                            <StepChart
                                rows={rows}
                                series={LOSS_SERIES}
                                format={(value) => value.toFixed(3)}
                                axisFormat={(value) => value.toFixed(2)}
                                label={`Loss for job ${job.id}`}
                                domain={[0, LOSS_STEPS]}
                                height={220}
                            />
                        </div>
                    </PanelSection>
                )}
                <PanelSection
                    icon={Logs}
                    title="Logs"
                    description="What the job printed, newest at the bottom."
                    bare
                >
                    <LogViewer
                        entries={logLines(job, version)}
                        live={job.status === "running"}
                        label="Job log"
                        maxHeight="16rem"
                    />
                </PanelSection>
            </PanelSections>
        </Page>
    );
}

type Message = { role: "user" | "assistant"; text: string; saved?: boolean };

const REPLY =
    "refund_request. The customer asks for money back for a duplicate charge, so this goes to the refunds queue.";

export function FlowPlaygroundPage() {
    const state = useFlowState();
    const toast = useToast();
    const requested = useSearchParam("model");
    const usable = state.models.filter(
        (model) => model.deployed || model.versions.some((version) => version.status === "ready"),
    );
    const [slug, setSlug] = useState(requested ?? state.focus ?? usable[0]?.slug ?? "");
    const [messages, setMessages] = useState<Message[]>([]);
    const [draft, setDraft] = useState(
        "I was charged twice for my plan, can you send one payment back?",
    );
    const [streaming, setStreaming] = useState(false);
    const timer = useRef<number | null>(null);
    useEffect(
        () => () => {
            if (timer.current) {
                window.clearInterval(timer.current);
            }
        },
        [],
    );
    const [owner, pinned] = slug.split("@");
    const model = state.models.find((item) => item.slug === owner);
    const send = (event: FormEvent) => {
        event.preventDefault();
        if (!draft.trim() || streaming) {
            return;
        }
        const words = REPLY.split(" ");
        let shown = 0;
        setMessages((current) => [
            ...current,
            { role: "user", text: draft.trim() },
            { role: "assistant", text: "" },
        ]);
        setDraft("");
        setStreaming(true);
        countRequest(slug);
        timer.current = window.setInterval(() => {
            shown += 1;
            setMessages((current) => [
                ...current.slice(0, -1),
                { role: "assistant", text: words.slice(0, shown).join(" ") },
            ]);
            if (shown >= words.length && timer.current) {
                window.clearInterval(timer.current);
                setStreaming(false);
            }
        }, 60);
    };
    const save = (index: number) => {
        saveExample();
        setMessages((current) =>
            current.map((message, at) => (at === index ? { ...message, saved: true } : message)),
        );
        toast({
            title: "Saved as a test example",
            description: `${model?.name ?? owner} is checked against it on every new version.`,
            tone: "success",
        });
    };
    return (
        <Page>
            <PageHeader
                title="Playground"
                caption="Chat with any model, or one version as name@N. Answers here are not counted as traffic."
                actions={
                    <Select value={slug} onValueChange={(value) => setSlug(String(value))}>
                        <SelectTrigger aria-label="Model" className="w-auto min-w-64">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {usable.map((item) => (
                                <SelectGroup key={item.slug}>
                                    <SelectLabel>{item.name}</SelectLabel>
                                    <SelectItem value={item.slug}>
                                        {item.kind === "base"
                                            ? item.slug
                                            : `${item.slug}${item.live === null ? "" : ` (live v${item.live})`}`}
                                    </SelectItem>
                                    {[...item.versions]
                                        .filter((version) => version.status === "ready")
                                        .sort((a, b) => b.number - a.number)
                                        .map((version) => (
                                            <SelectItem
                                                key={version.number}
                                                value={`${item.slug}@${version.number}`}
                                            >
                                                {`${item.slug}@${version.number}${version.kind === "prompt" ? " · Baseline" : ""}`}
                                            </SelectItem>
                                        ))}
                                </SelectGroup>
                            ))}
                        </SelectContent>
                    </Select>
                }
            />
            <section className="flex min-h-96 flex-col rounded-lg border bg-card">
                <div className="flex flex-1 flex-col gap-4 p-panel">
                    {messages.length === 0 && (
                        <p className="text-muted-foreground">
                            {model
                                ? `Ask ${pinned ? `${model.slug}@${pinned}` : model.name} something.`
                                : "Pick a model."}
                            {model && (
                                <>
                                    {" "}
                                    <Link
                                        href={modelHref(model.slug)}
                                        className="text-primary hover:underline"
                                    >
                                        Its model page →
                                    </Link>
                                </>
                            )}
                        </p>
                    )}
                    {messages.map((message, index) => (
                        <div
                            key={`${message.role}-${index}`}
                            className={
                                message.role === "user"
                                    ? "max-w-[80%] self-end rounded-lg bg-secondary px-3 py-2"
                                    : "flex max-w-[80%] flex-col gap-2"
                            }
                        >
                            <p>{message.text || "…"}</p>
                            {message.role === "assistant" &&
                                message.text &&
                                !(streaming && index === messages.length - 1) && (
                                    <div>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={message.saved}
                                            onClick={() => save(index)}
                                        >
                                            {message.saved ? <Check aria-hidden="true" /> : null}
                                            {message.saved ? "Saved" : "Save as test example"}
                                        </Button>
                                    </div>
                                )}
                        </div>
                    ))}
                </div>
                <form onSubmit={send} className="flex gap-2 border-t p-3">
                    <Input
                        aria-label="Message"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder="Message"
                    />
                    <Button type="submit" disabled={!draft.trim() || streaming || !model}>
                        <Send aria-hidden="true" />
                        Send
                    </Button>
                </form>
            </section>
            <p className="text-sm text-muted-foreground tabular-nums">{`Test examples saved in this session: ${state.examples}.`}</p>
        </Page>
    );
}

const SLOT_COLORS = ["var(--primary)", "var(--file-sql)", "var(--file-parquet)", "var(--file-tsv)"];
const OTHER_COLOR = "var(--neutral)";
const DAY_MS = 24 * 3600 * 1000;

function totalOf(model: FlowModel): number {
    return model.traffic.reduce((sum, value) => sum + value, 0);
}

type Request = {
    id: string;
    model: FlowModel;
    question: string;
    minutesAgo: number;
    ms: number;
    ok: boolean;
};

function requestLog(models: FlowModel[]): Request[] {
    return models
        .filter((model) => model.deployed)
        .flatMap((model) =>
            model.recent.map((item, index) => ({
                id: `${model.slug}-${index}`,
                model,
                question: item.question,
                minutesAgo: item.minutesAgo,
                ms: Math.round((model.p95 || 200) * (0.45 + index * 0.18)),
                ok: !(model.errors > model.usualErrors * 3 && index === 1),
            })),
        )
        .sort((a, b) => a.minutesAgo - b.minutesAgo);
}

function servedBy(model: FlowModel): string {
    if (model.kind === "base") {
        return model.variants.find((item) => item.live)?.apiName ?? model.slug;
    }
    return `${model.slug}@${model.live ?? 0}`;
}

export function FlowMonitorPage() {
    const state = useFlowState();
    const live = state.models
        .filter((model) => model.deployed)
        .sort((a, b) => totalOf(b) - totalOf(a));
    const top = live.slice(0, SLOT_COLORS.length);
    const rest = live.slice(SLOT_COLORS.length);
    const series: ChartSeries[] = [
        ...top.map((model, index) => ({
            key: model.slug,
            label: model.name,
            color: SLOT_COLORS[index],
        })),
        ...(rest.length > 0
            ? [{ key: "other", label: `${rest.length} others`, color: OTHER_COLOR }]
            : []),
    ];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const rows = Array.from({ length: 7 }, (_, day) => {
        const row: { at: number; [key: string]: number } = {
            at: today.getTime() - (6 - day) * DAY_MS,
        };
        for (const model of top) {
            row[model.slug] = model.traffic[day];
        }
        if (rest.length > 0) {
            row.other = rest.reduce((sum, model) => sum + model.traffic[day], 0);
        }
        return row;
    });
    const log = requestLog(state.models);
    return (
        <Page wide>
            <PageHeader
                title="Monitor"
                caption="Traffic across the deployed models: requests, latency, errors and cost."
            />
            <PanelSections>
                <PanelSection
                    icon={ChartColumn}
                    title="Requests per day"
                    description="Last 7 days, stacked by model."
                >
                    <div className="flex flex-col gap-3">
                        <ChartLegend series={series} />
                        <TimeChart
                            kind="stacked-bars"
                            rows={rows}
                            series={series}
                            format={(value) => count(value)}
                            bucketMs={DAY_MS}
                            label="Requests per day by model"
                        />
                    </div>
                </PanelSection>
                <PanelSection
                    icon={Box}
                    title="By model"
                    description="Each deployed model over the last 7 days, busiest first."
                    flush
                >
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="pl-panel">Model</TableHead>
                                <TableHead className="text-right">Requests, 7 days</TableHead>
                                <TableHead className="text-right">Latency p95</TableHead>
                                <TableHead className="text-right">Errors</TableHead>
                                <TableHead className="text-right">Cost / 1k req.</TableHead>
                                <TableHead className="pr-panel text-right">GPU·s, 7 days</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {live.map((model) => (
                                <TableRow key={model.slug}>
                                    <TableCell className="pl-panel">
                                        <Link
                                            href={modelHref(model.slug, "monitoring")}
                                            className="font-medium hover:underline"
                                        >
                                            {model.name}
                                        </Link>
                                    </TableCell>
                                    <TableCell className="text-right">
                                        {count(totalOf(model))}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        {model.p95 ? `${model.p95} ms` : "–"}
                                    </TableCell>
                                    <TableCell
                                        className={
                                            model.errors > model.usualErrors * 3
                                                ? "text-right text-destructive"
                                                : "text-right"
                                        }
                                    >
                                        {`${(model.errors * 100).toFixed(1)}%`}
                                    </TableCell>
                                    <TableCell className="text-right">{`${model.gpuSeconds.toFixed(1)} GPU·s`}</TableCell>
                                    <TableCell className="pr-panel text-right">
                                        {((totalOf(model) / 1000) * model.gpuSeconds).toFixed(1)}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </PanelSection>
                <PanelSection
                    icon={Logs}
                    title="Request log"
                    description="Newest first. Prompts and answers stay on this install."
                    flush
                >
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead className="pl-panel">Time</TableHead>
                                <TableHead>Model</TableHead>
                                <TableHead>Request</TableHead>
                                <TableHead className="text-right">Latency</TableHead>
                                <TableHead className="pr-panel">Status</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {log.map((item) => (
                                <TableRow key={item.id}>
                                    <TableCell className="pl-panel font-mono text-sm text-muted-foreground">
                                        {`${item.minutesAgo} min ago`}
                                    </TableCell>
                                    <TableCell className="font-mono text-sm">
                                        {servedBy(item.model)}
                                    </TableCell>
                                    <TableCell className="max-w-96 truncate" title={item.question}>
                                        {item.question}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        {item.ok ? `${item.ms} ms` : "30,000 ms"}
                                    </TableCell>
                                    <TableCell className="pr-panel">
                                        <StatusText tone={item.ok ? "success" : "destructive"}>
                                            {item.ok ? "200" : "504 timeout"}
                                        </StatusText>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </PanelSection>
            </PanelSections>
        </Page>
    );
}

const KIND_FILTERS: { key: string; label: string; kinds: JobKind[] }[] = [
    {
        key: "all",
        label: "All",
        kinds: ["train", "score", "judge", "download", "import", "export"],
    },
    { key: "train", label: "Training", kinds: ["train"] },
    { key: "score", label: "Scoring", kinds: ["score"] },
    { key: "judge", label: "Judge", kinds: ["judge"] },
    { key: "download", label: "Downloads", kinds: ["download"] },
    { key: "import", label: "Imports", kinds: ["import"] },
    { key: "export", label: "Exports", kinds: ["export"] },
];

function kindMatches(job: Job, filter: string): boolean {
    return (KIND_FILTERS.find((item) => item.key === filter) ?? KIND_FILTERS[0]).kinds.includes(
        job.kind,
    );
}

function fromControl(event: MouseEvent): boolean {
    return (event.target as HTMLElement).closest("a,button,input,label,[role=checkbox]") !== null;
}

export function FlowJobsPage() {
    const state = useFlowState();
    const toast = useToast();
    const router = useRouter();
    const wanted = useSearchParam("kind");
    const [filter, setFilter] = useState(
        KIND_FILTERS.some((item) => item.key === wanted) ? (wanted ?? "all") : "all",
    );
    const [picked, setPicked] = useState<number[]>([]);
    const jobs = state.jobs.filter((job) => kindMatches(job, filter));
    const chosen = state.jobs.filter((job) => picked.includes(job.id));
    const cancellable = chosen.filter((job) => job.status === "running" || job.status === "queued");
    const retryable = chosen.filter((job) => job.status === "failed" || job.status === "cancelled");
    const toggle = (id: number, on: boolean) =>
        setPicked(on ? [...picked, id] : picked.filter((item) => item !== id));
    const every = jobs.length > 0 && jobs.every((job) => picked.includes(job.id));
    return (
        <Page wide>
            <PageHeader
                title="Jobs"
                caption="Every job on this install: training, scoring, judging, downloads and imports."
            />
            <PanelSections>
                <PanelSection
                    icon={ListChecks}
                    title="Queue and history"
                    description="Open a job for its progress, settings and logs."
                    bare
                >
                    <div className="flex flex-col gap-3">
                        <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2">
                            <Tabs
                                value={filter}
                                onValueChange={(value) => {
                                    setFilter(String(value));
                                    setPicked([]);
                                }}
                            >
                                <TabsList aria-label="Job kind">
                                    {KIND_FILTERS.map((item) => (
                                        <TabsTrigger key={item.key} value={item.key}>
                                            {item.label}
                                            <span className="text-sm text-muted-foreground tabular-nums">
                                                {
                                                    state.jobs.filter((job) =>
                                                        kindMatches(job, item.key),
                                                    ).length
                                                }
                                            </span>
                                        </TabsTrigger>
                                    ))}
                                </TabsList>
                            </Tabs>
                            {picked.length > 0 && (
                                <div className="ml-auto">
                                    <BulkJobs
                                        picked={picked.length}
                                        retryable={retryable}
                                        cancellable={cancellable}
                                        onClear={() => setPicked([])}
                                        onDone={(what, n) => {
                                            setPicked([]);
                                            toast({ title: `${what} ${n} jobs`, tone: "success" });
                                        }}
                                    />
                                </div>
                            )}
                        </div>
                        <div className="overflow-x-auto rounded-xl border bg-card">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className="w-10 pl-4">
                                            <Checkbox
                                                aria-label="Select every job shown"
                                                checked={every}
                                                disabled={jobs.length === 0}
                                                onCheckedChange={(value) =>
                                                    setPicked(
                                                        value === true
                                                            ? jobs.map((job) => job.id)
                                                            : [],
                                                    )
                                                }
                                            />
                                        </TableHead>
                                        <TableHead>Job</TableHead>
                                        <TableHead>Kind</TableHead>
                                        <TableHead>Model</TableHead>
                                        <TableHead>Status</TableHead>
                                        <TableHead>Started</TableHead>
                                        <TableHead className="pr-4 text-right">Took</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {jobs.map((job) => (
                                        <TableRow
                                            key={job.id}
                                            className="cursor-pointer"
                                            data-state={
                                                picked.includes(job.id) ? "selected" : undefined
                                            }
                                            onClick={(event) => {
                                                if (fromControl(event)) {
                                                    return;
                                                }
                                                if (picked.length > 0) {
                                                    toggle(job.id, !picked.includes(job.id));
                                                    return;
                                                }
                                                router.history.push(jobHref(job.id));
                                            }}
                                        >
                                            <TableCell className="pl-4">
                                                <Checkbox
                                                    aria-label={`Select job ${job.id}`}
                                                    checked={picked.includes(job.id)}
                                                    onCheckedChange={(value) =>
                                                        toggle(job.id, value === true)
                                                    }
                                                />
                                            </TableCell>
                                            <TableCell>
                                                <Link
                                                    href={jobHref(job.id)}
                                                    className="font-mono text-sm hover:underline"
                                                >
                                                    {`#${job.id}`}
                                                </Link>
                                            </TableCell>
                                            <TableCell>{`${JOB_KINDS[job.kind]}${job.version !== null ? ` v${job.version}` : ""}`}</TableCell>
                                            <TableCell>
                                                <Link
                                                    href={modelHref(job.model)}
                                                    className="hover:underline"
                                                >
                                                    {modelName(state.models, job.model)}
                                                </Link>
                                            </TableCell>
                                            <TableCell>
                                                <JobStatusText job={job} />
                                            </TableCell>
                                            <TableCell className="text-muted-foreground">
                                                {relativeTime(createdAt(job))}
                                            </TableCell>
                                            <TableCell className="pr-4 text-right">
                                                {job.minutes ? `${job.minutes} min` : "–"}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    </div>
                </PanelSection>
            </PanelSections>
        </Page>
    );
}

export function FlowOldJobsRedirect() {
    const router = useRouter();
    useEffect(() => {
        router.history.replace(`${FLOW}/jobs`);
    }, [router]);
    return null;
}

type ReviewFilter = "pending" | "accepted" | "dismissed";

export function FlowFeedbackPage() {
    const state = useFlowState();
    const toast = useToast();
    const [filter, setFilter] = useState<ReviewFilter>("pending");
    const rows = state.feedback.filter((row) => row.state === filter);
    const tabs = (["pending", "accepted", "dismissed"] as const).map((key) => ({
        key,
        label: key === "pending" ? "To review" : key === "accepted" ? "Accepted" : "Dismissed",
        badge: state.feedback.filter((row) => row.state === key).length,
    }));
    const accept = (id: number, slug: string) => {
        reviewFeedback(id, true);
        const model = state.models.find((item) => item.slug === slug);
        const next = model ? nextStep({ ...model, accepted: model.accepted + 1 }) : null;
        toast({
            title: "Accepted",
            description: next ? `${model?.name}'s next step: ${next.label}.` : undefined,
            tone: "success",
        });
    };
    return (
        <Page wide>
            <PageHeader
                title="Feedback"
                caption="Answers people marked wrong. Accepted rows join the model's next training run."
            />
            <div className="flex min-h-8 items-center">
                <SegmentedTabs
                    tabs={tabs}
                    active={filter}
                    onSelect={(key) => setFilter(key as ReviewFilter)}
                />
            </div>
            <div className="overflow-x-auto rounded-lg border bg-card">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Model</TableHead>
                            <TableHead>Request</TableHead>
                            <TableHead>Answered</TableHead>
                            <TableHead>Should be</TableHead>
                            <TableHead>Received</TableHead>
                            <TableHead />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.length === 0 && (
                            <TableRow>
                                <TableCell
                                    colSpan={6}
                                    className="py-6 text-center text-muted-foreground"
                                >
                                    Nothing here.
                                </TableCell>
                            </TableRow>
                        )}
                        {rows.map((row) => (
                            <TableRow key={row.id}>
                                <TableCell>
                                    <Link
                                        href={modelHref(row.model)}
                                        className="font-medium hover:underline"
                                    >
                                        {modelName(state.models, row.model)}
                                    </Link>
                                </TableCell>
                                <TableCell className="max-w-96 truncate" title={row.question}>
                                    {row.question}
                                </TableCell>
                                <TableCell className="font-mono text-sm text-destructive">
                                    {row.answer}
                                </TableCell>
                                <TableCell className="font-mono text-sm">{row.suggested}</TableCell>
                                <TableCell className="text-muted-foreground">
                                    {relativeTime(createdAt(row))}
                                </TableCell>
                                <TableCell className="text-right">
                                    {row.state === "pending" && (
                                        <span className="inline-flex gap-1">
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                onClick={() => accept(row.id, row.model)}
                                            >
                                                <Check aria-hidden="true" />
                                                Accept
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => reviewFeedback(row.id, false)}
                                            >
                                                Dismiss
                                            </Button>
                                        </span>
                                    )}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </Page>
    );
}

export function FlowInfrastructurePage() {
    return (
        <Page>
            <PageHeader title="Infrastructure" caption="Stub: compute this install can use." />
            <div className="overflow-x-auto rounded-lg border bg-card">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Device</TableHead>
                            <TableHead>Pool</TableHead>
                            <TableHead className="text-right">Memory</TableHead>
                            <TableHead>Does</TableHead>
                            <TableHead>Status</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        <TableRow>
                            <TableCell className="font-mono text-sm">gpu-a10-1</TableCell>
                            <TableCell>gpu</TableCell>
                            <TableCell className="text-right">24 GB</TableCell>
                            <TableCell>Serve and train</TableCell>
                            <TableCell>
                                <StatusText tone="success">Online</StatusText>
                            </TableCell>
                        </TableRow>
                        <TableRow>
                            <TableCell className="font-mono text-sm">cpu-1</TableCell>
                            <TableCell>cpu</TableCell>
                            <TableCell className="text-right">64 GB</TableCell>
                            <TableCell>Serve GGUF</TableCell>
                            <TableCell>
                                <StatusText tone="success">Online</StatusText>
                            </TableCell>
                        </TableRow>
                    </TableBody>
                </Table>
            </div>
        </Page>
    );
}

const PERSONAL = [
    ["Your account", "Name, password and signed-in sessions"],
    ["Appearance", "Light, dark or the system setting"],
];

const ADMIN_SETTINGS = [
    [
        "General",
        "Model catalogue, judge model, safety model, default training recipe, compute prices",
    ],
    ["Security", "Sign-in, proxy headers, session length"],
    ["Accounts", "People and roles"],
    ["Audit log", "Who changed what"],
    ["Data", "Row limit, version retention, check thresholds"],
    ["Storage", "Where weights, adapters and datasets live"],
    ["Connections", "S3, Hugging Face mirror, warehouses"],
    ["This install", "Version, licence, support bundle"],
];

function SettingsList({ title, rows }: { title: string; rows: string[][] }) {
    return (
        <Section title={title}>
            <Facts
                items={rows.map(([label, detail]) => [
                    label,
                    <span key={label} className="text-muted-foreground">
                        {detail}
                    </span>,
                ])}
            />
        </Section>
    );
}

export function FlowSettingsPage() {
    const admin = useCan("admin");
    return (
        <Page>
            <PageHeader
                title="Settings"
                caption={
                    admin
                        ? "Stub: the sections stay as they are today."
                        : "Stub: your own settings. Admins also see the install's sections."
                }
            />
            <SettingsList title="You" rows={PERSONAL} />
            {admin && <SettingsList title="This install" rows={ADMIN_SETTINGS} />}
        </Page>
    );
}
