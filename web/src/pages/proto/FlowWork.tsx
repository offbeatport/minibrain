import { useParams, useRouter } from "@tanstack/react-router";
import { Check, RotateCcw, Send, X } from "lucide-react";
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
    TabNav,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    useToast,
} from "obp-ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Facts } from "~/components/Facts";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section, Stat } from "~/components/Section";
import { StepChart, type StepSeries } from "~/components/charts/StepChart";
import { ChartLegend, type ChartSeries, TimeChart } from "~/components/charts/TimeChart";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { useSearchParam } from "~/lib/listSearch";
import { relativeTime } from "~/lib/time";
import {
    FLOW,
    type FlowModel,
    type Job,
    type JobKind,
    type JobStatus,
    LOSS_STEPS,
    SAMPLE_FILE,
    attachDataset,
    cancelJobs,
    countRequest,
    createdAt,
    datasetHref,
    findVersion,
    jobHref,
    lossCurve,
    modelHref,
    nextStep,
    pct,
    retryJobs,
    reviewFeedback,
    saveExample,
    uploadSample,
    useFlowState,
    versionHref,
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
            <div className="overflow-x-auto rounded-lg border bg-card">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Dataset</TableHead>
                            <TableHead>File</TableHead>
                            <TableHead className="text-right">Rows</TableHead>
                            <TableHead className="text-right">Version</TableHead>
                            <TableHead>Used by</TableHead>
                            <TableHead>Updated</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {state.datasets.map((item) => {
                            const users = state.models.filter(
                                (model) => model.dataset === item.slug,
                            );
                            return (
                                <TableRow key={item.slug}>
                                    <TableCell>
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
                                    <TableCell className="text-right">{count(item.rows)}</TableCell>
                                    <TableCell className="text-right">{`v${item.version}`}</TableCell>
                                    <TableCell>
                                        {users.length === 0 ? (
                                            <span className="text-muted-foreground">No model</span>
                                        ) : (
                                            users.map((model, index) => (
                                                <span key={model.slug}>
                                                    {index > 0 && ", "}
                                                    <Link
                                                        href={modelHref(model.slug, "training")}
                                                        className="text-primary hover:underline"
                                                    >
                                                        {model.name}
                                                    </Link>
                                                </span>
                                            ))
                                        )}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {relativeTime(createdAt(item))}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
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
        router.history.push(modelHref(model, "training"));
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
            <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <Section
                    title="Preview"
                    caption={`First ${item.preview.length} of ${count(item.rows)} rows.`}
                >
                    <div className="overflow-x-auto rounded-md border">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>{item.columns[0]}</TableHead>
                                    <TableHead>{item.columns[1]}</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {item.preview.map(([text, label]) => (
                                    <TableRow key={text}>
                                        <TableCell className="max-w-96 truncate" title={text}>
                                            {text}
                                        </TableCell>
                                        <TableCell className="font-mono text-sm">{label}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                </Section>
                <div className="flex flex-col gap-4">
                    <Section title="Quality">
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
                    </Section>
                    <Section
                        title="Splits"
                        caption="Held-out rows are never trained on; every version is scored on them."
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
                    </Section>
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
    download: "Download",
    import: "Import",
};

const JOB_STATUS: Record<JobStatus, { tone: Tone; label: string }> = {
    running: { tone: "info", label: "Running" },
    queued: { tone: "neutral", label: "Queued" },
    done: { tone: "success", label: "Done" },
    failed: { tone: "destructive", label: "Failed" },
    cancelled: { tone: "neutral", label: "Cancelled" },
};

function JobStatusText({ job }: { job: Job }) {
    const status = JOB_STATUS[job.status];
    return (
        <span className="flex items-center gap-2">
            <StatusText tone={status.tone}>
                {status.label}
                {job.status === "running" && (
                    <span className="tabular-nums">{` · ${Math.round(job.progress * 100)}%`}</span>
                )}
            </StatusText>
            {job.status === "running" && (
                <ProgressBar value={job.progress} label={`Job ${job.id}`} className="w-16" />
            )}
        </span>
    );
}

function logLines(job: Job): LogEntry[] {
    const start = new Date(createdAt(job)).getTime();
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
            message: "Split: 1,926 train · 214 held out",
            time: start + 2000,
        },
        {
            id: 3,
            level: "info",
            source: "trainer",
            message: "Plan: LoRA rank 16, batch 8, gradient checkpointing off",
            time: start + 3000,
        },
    ];
    const steps = Math.floor(job.progress * 6);
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

export function FlowJobPage() {
    const { id } = useParams({ strict: false }) as { id?: string };
    const state = useFlowState();
    const job = state.jobs.find((item) => item.id === Number(id));
    if (!job) {
        return (
            <Page>
                <Crumbs
                    items={[
                        { label: "Monitor", href: `${FLOW}/monitor/jobs` },
                        { label: `Job #${id}` },
                    ]}
                />
                <p className="text-muted-foreground">No such job.</p>
            </Page>
        );
    }
    const model = state.models.find((item) => item.slug === job.model);
    const version = model && job.version !== null ? findVersion(model, job.version) : undefined;
    const zero = model ? findVersion(model, 0) : undefined;
    const subject = `${JOB_KINDS[job.kind]}${job.version !== null ? ` v${job.version}` : ""} of ${model?.name ?? job.model}`;
    const rows = lossCurve(job.version ?? 1).filter((row) => row.step <= LOSS_STEPS * job.progress);
    const finished = job.status === "done" && job.kind === "train" && version?.scores;
    return (
        <Page>
            <Crumbs
                items={[
                    { label: "Monitor", href: `${FLOW}/monitor/jobs` },
                    { label: `Job #${job.id}` },
                ]}
            />
            <PageHeader
                title={`Job #${job.id}`}
                caption={
                    <span>
                        {model ? (
                            <Link
                                href={modelHref(model.slug)}
                                className="text-primary hover:underline"
                            >
                                {subject}
                            </Link>
                        ) : (
                            subject
                        )}
                        {` · started ${relativeTime(createdAt(job))}`}
                    </span>
                }
                actions={
                    <>
                        {model && version && job.kind === "train" && (
                            <Button variant="outline" asChild>
                                <Link href={versionHref(model.slug, version.number, "training")}>
                                    {`v${version.number} Training tab`}
                                </Link>
                            </Button>
                        )}
                        {job.status === "running" && (
                            <Button variant="outline" onClick={() => cancelJobs([job.id])}>
                                Cancel
                            </Button>
                        )}
                    </>
                }
            />
            {finished && model && version?.scores && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-success/40 bg-success-soft px-4 py-3">
                    <span>
                        <span className="font-semibold">{`v${version.number} scored ${pct(version.scores[0])}`}</span>
                        {zero?.scores &&
                            `, beats v0 Baseline (${pct(zero.scores[0])}) by ${((version.scores[0] - zero.scores[0]) * 100).toFixed(1)} points.`}
                    </span>
                    <span className="flex gap-2">
                        <Button variant="outline" asChild>
                            <Link
                                href={versionHref(model.slug, version.number)}
                            >{`Open v${version.number}`}</Link>
                        </Button>
                        <MakeLiveButton
                            model={model}
                            version={version}
                            label={`Make live v${version.number}`}
                        />
                    </span>
                </div>
            )}
            <Section title="Progress">
                <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
                        <JobStatusText job={job} />
                        <Stat
                            label="Step"
                            value={`${count(Math.round(job.progress * LOSS_STEPS))} of ${count(LOSS_STEPS)}`}
                        />
                        <Stat label="Worker" value="gpu-a10-1" />
                        <Stat
                            label={job.status === "running" ? "Time left" : "Took"}
                            value={
                                job.status === "running"
                                    ? `${Math.ceil((1 - job.progress) * 10)} s`
                                    : job.minutes
                                      ? `${job.minutes} min`
                                      : "–"
                            }
                        />
                    </div>
                    <ProgressBar
                        value={job.progress}
                        label={`Job ${job.id} progress`}
                        className="w-full"
                    />
                </div>
            </Section>
            {job.kind === "train" && (
                <Section
                    title="Loss"
                    caption="Training loss every 24 steps, held-out loss every 120."
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
                </Section>
            )}
            <LogViewer
                entries={logLines(job)}
                live={job.status === "running"}
                label="Job log"
                maxHeight="16rem"
            />
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

function MonitorTabs() {
    return (
        <TabNav
            label="Monitor pages"
            tabs={[
                { href: `${FLOW}/monitor`, label: "Traffic" },
                { href: `${FLOW}/monitor/jobs`, label: "Jobs" },
            ]}
        />
    );
}

export function FlowMonitorPage() {
    const state = useFlowState();
    const live = state.models
        .filter((model) => model.deployed)
        .sort(
            (a, b) => b.traffic.reduce((s, v) => s + v, 0) - a.traffic.reduce((s, v) => s + v, 0),
        );
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
    return (
        <Page wide>
            <PageHeader
                title="Monitor"
                caption="Traffic across live models, and every job on this install."
            />
            <MonitorTabs />
            <Section title="Requests per day" caption="Last 7 days, stacked by model.">
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
            </Section>
            <div className="overflow-x-auto rounded-lg border bg-card">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Model</TableHead>
                            <TableHead className="text-right">Requests, 7 days</TableHead>
                            <TableHead className="text-right">Latency p95</TableHead>
                            <TableHead className="text-right">Errors</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {live.map((model) => (
                            <TableRow key={model.slug}>
                                <TableCell>
                                    <Link
                                        href={modelHref(model.slug)}
                                        className="font-medium hover:underline"
                                    >
                                        {model.name}
                                    </Link>
                                </TableCell>
                                <TableCell className="text-right">
                                    {count(model.traffic.reduce((sum, value) => sum + value, 0))}
                                </TableCell>
                                <TableCell className="text-right">
                                    {model.p95 ? `${model.p95} ms` : "–"}
                                </TableCell>
                                <TableCell
                                    className={
                                        model.errors > 0.01
                                            ? "text-right text-destructive"
                                            : "text-right"
                                    }
                                >
                                    {`${(model.errors * 100).toFixed(1)}%`}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </Page>
    );
}

const KIND_FILTERS = [
    { key: "all", label: "All" },
    { key: "train", label: "Training" },
    { key: "score", label: "Scoring" },
    { key: "transfer", label: "Downloads and imports" },
];

function kindMatches(job: Job, filter: string): boolean {
    if (filter === "all") {
        return true;
    }
    if (filter === "transfer") {
        return job.kind === "download" || job.kind === "import";
    }
    return job.kind === filter;
}

export function FlowJobsPage() {
    const state = useFlowState();
    const toast = useToast();
    const [filter, setFilter] = useState("all");
    const [picked, setPicked] = useState<number[]>([]);
    const jobs = state.jobs.filter((job) => kindMatches(job, filter));
    const chosen = state.jobs.filter((job) => picked.includes(job.id));
    const cancellable = chosen.filter((job) => job.status === "running" || job.status === "queued");
    const retryable = chosen.filter((job) => job.status === "failed" || job.status === "cancelled");
    const tabs = KIND_FILTERS.map((item) => ({
        ...item,
        badge: state.jobs.filter((job) => kindMatches(job, item.key)).length,
    }));
    const toggle = (id: number, on: boolean) =>
        setPicked(on ? [...picked, id] : picked.filter((item) => item !== id));
    return (
        <Page wide>
            <PageHeader
                title="Monitor"
                caption="Traffic across live models, and every job on this install."
            />
            <MonitorTabs />
            {picked.length > 0 ? (
                <div className="flex min-h-8 flex-wrap items-center gap-2">
                    <span className="font-medium tabular-nums">{`${picked.length} selected`}</span>
                    <Button variant="outline" onClick={() => setPicked([])}>
                        <X aria-hidden="true" />
                        Clear selection
                    </Button>
                    <div className="ml-auto flex gap-2">
                        <Button
                            variant="outline"
                            disabled={retryable.length === 0}
                            onClick={() => {
                                retryJobs(retryable.map((job) => job.id));
                                setPicked([]);
                                toast({
                                    title: `Retrying ${retryable.length} jobs`,
                                    tone: "success",
                                });
                            }}
                        >
                            <RotateCcw aria-hidden="true" />
                            Retry
                        </Button>
                        <Button
                            variant="destructive"
                            disabled={cancellable.length === 0}
                            onClick={() => {
                                cancelJobs(cancellable.map((job) => job.id));
                                setPicked([]);
                                toast({
                                    title: `Cancelled ${cancellable.length} jobs`,
                                    tone: "success",
                                });
                            }}
                        >
                            Cancel jobs
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="flex min-h-8 items-center">
                    <SegmentedTabs
                        tabs={tabs.map((tab) => ({
                            key: tab.key,
                            label: tab.label,
                            badge: tab.badge,
                        }))}
                        active={filter}
                        onSelect={setFilter}
                    />
                </div>
            )}
            <div className="overflow-x-auto rounded-lg border bg-card">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-10" />
                            <TableHead>Job</TableHead>
                            <TableHead>Kind</TableHead>
                            <TableHead>Model</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Started</TableHead>
                            <TableHead className="text-right">Took</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {jobs.map((job) => (
                            <TableRow
                                key={job.id}
                                data-state={picked.includes(job.id) ? "selected" : undefined}
                            >
                                <TableCell>
                                    <Checkbox
                                        aria-label={`Select job ${job.id}`}
                                        checked={picked.includes(job.id)}
                                        onCheckedChange={(value) => toggle(job.id, value === true)}
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
                                    <Link href={modelHref(job.model)} className="hover:underline">
                                        {modelName(state.models, job.model)}
                                    </Link>
                                </TableCell>
                                <TableCell>
                                    <JobStatusText job={job} />
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                    {relativeTime(createdAt(job))}
                                </TableCell>
                                <TableCell className="text-right">
                                    {job.minutes ? `${job.minutes} min` : "–"}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </Page>
    );
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
        const next = model ? nextStep(state, { ...model, accepted: model.accepted + 1 }) : null;
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

const SETTINGS = [
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

export function FlowSettingsPage() {
    return (
        <Page>
            <PageHeader title="Settings" caption="Stub: the sections stay as they are today." />
            <Section title="Sections">
                <Facts
                    items={SETTINGS.map(([label, detail]) => [
                        label,
                        <span key={label} className="text-muted-foreground">
                            {detail}
                        </span>,
                    ])}
                />
            </Section>
        </Page>
    );
}
