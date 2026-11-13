import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "@tanstack/react-router";
import {
    BookOpen,
    Copy,
    Download,
    Fingerprint,
    Gauge,
    GitCompare,
    Hourglass,
    MoreHorizontal,
    Package,
    Play,
    SlidersHorizontal,
    Trash2,
} from "lucide-react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    Link,
    cn,
    useToast,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import {
    type ExampleAnswer,
    type JobDetail,
    type JobInfo,
    type ModelRow,
    type VersionInfo,
    api,
    unwrap,
} from "~/api/client";
import { useJobMetrics } from "~/api/jobPageQueries";
import {
    isActiveJob,
    keys,
    useAllModels,
    useJob,
    useJobs,
    useVersionFiles,
    useVersions,
} from "~/api/queries";
import { CopyButton } from "~/components/CopyButton";
import { NotFoundState, QueryError } from "~/components/ErrorState";
import { Facts } from "~/components/Facts";
import { JobLogsSection } from "~/components/JobLogs";
import { PoolLink } from "~/components/PoolLink";
import { ErrorLine, Page, PanelSection, PanelSections } from "~/components/Section";
import { ProgressBar } from "~/components/models/StatusText";
import { useCan } from "~/lib/access";
import { count, percent } from "~/lib/format";
import { durationText } from "~/lib/jobs";
import { metricName } from "~/lib/metrics";
import {
    jobHref,
    modelCardHref,
    modelCompareHref,
    modelPageHref,
    versionPlaygroundHref,
} from "~/lib/modelLinks";
import { bytes, relativeTime } from "~/lib/time";
import { LossSection, RateSection } from "../../jobs/TrainingPanel";
import { ConfirmAction, type Confirmation } from "../dialogs";
import { CompactHeader, Crumbs, Tip, baseNameOf, isDeployed, modelCrumbs } from "./header";
import {
    DeployVersionDialog,
    canGoLive,
    liveBlock,
    liveOf,
    points,
    versionLabel,
} from "./makeLive";
import { VersionStatus, runJob, trainingText } from "./versions";

export function useAnswers(slug: string, number: number, against: number | null, enabled: boolean) {
    return useQuery({
        queryKey: [...keys.answers(slug, number), against],
        queryFn: () =>
            unwrap(
                api.GET("/api/models/{name}/versions/{number}/answers", {
                    params: {
                        path: { name: slug, number },
                        query: against === null ? {} : { against },
                    },
                }),
            ),
        enabled,
        retry: false,
    });
}

export type Verdict = "better" | "worse" | "same";

export function verdictOf(answer: ExampleAnswer, metric: string | null | undefined): Verdict {
    if (!answer.live || !metric) {
        return "same";
    }
    const mine = answer.version.scores[metric] ?? 0;
    const theirs = answer.live.scores[metric] ?? 0;
    if (mine > theirs + 1e-9) {
        return "better";
    }
    return mine < theirs - 1e-9 ? "worse" : "same";
}

function Delta({ value, suffix }: { value: number; suffix: string }) {
    const tone =
        value > 0.0005
            ? "text-success"
            : value < -0.0005
              ? "text-destructive"
              : "text-muted-foreground";
    return (
        <span className={cn("tabular-nums", tone)}>
            {points(value)}
            <span className="text-muted-foreground">{` ${suffix}`}</span>
        </span>
    );
}

type Reference = { version: VersionInfo; label: string };

function references(row: ModelRow, versions: VersionInfo[], version: VersionInfo): Reference[] {
    const live = isDeployed(row) ? liveOf(versions) : undefined;
    const zero = versions.find((item) => item.number === 0);
    const found: Reference[] = [];
    if (live && live.score !== null && live.number !== version.number) {
        found.push({ version: live, label: `live v${live.number}` });
    }
    if (zero && zero.score !== null && zero.number !== version.number) {
        found.push({ version: zero, label: "v0 · Baseline" });
    }
    return found;
}

function ScoreSection({
    row,
    versions,
    version,
}: {
    row: ModelRow;
    versions: VersionInfo[];
    version: VersionInfo;
}) {
    if (version.score === null) {
        return null;
    }
    const held = version.held_out?.examples ?? 0;
    return (
        <PanelSection
            icon={Gauge}
            title="Score"
            tip={`${metricName(version.main_metric)} on ${count(held)} held-out rows it never trained on.`}
        >
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                <span className="text-3xl tabular-nums">{percent(version.score)}</span>
                {references(row, versions, version).map((reference) => (
                    <Delta
                        key={reference.label}
                        value={(version.score ?? 0) - (reference.version.score ?? 0)}
                        suffix={`vs ${reference.label} (${percent(reference.version.score)})`}
                    />
                ))}
            </div>
        </PanelSection>
    );
}

function Answered({
    label,
    value,
    right,
}: { label: string; value: string; right: boolean | null }) {
    return (
        <div className="flex min-w-0 flex-col">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span
                className={cn(
                    "line-clamp-3 font-mono text-sm break-words",
                    right === false ? "text-destructive" : "text-foreground",
                )}
            >
                {value || "–"}
                {right !== null && (
                    <span className="sr-only">{right ? " (right)" : " (wrong)"}</span>
                )}
            </span>
        </div>
    );
}

function inputOf(answer: ExampleAnswer): string {
    return answer.messages.filter((turn) => turn.role === "user").at(-1)?.content ?? "";
}

export function ExampleList({
    rows,
    mine,
    theirs,
    metric,
}: {
    rows: ExampleAnswer[];
    mine: string;
    theirs: string;
    metric: string | null | undefined;
}) {
    const right = (scores: Record<string, number>) =>
        metric && metric in scores ? scores[metric] >= 0.999 : null;
    return (
        <ul className="flex flex-col divide-y rounded-md border">
            {rows.map((answer, index) => (
                <li key={`${index}-${answer.expected}`} className="flex flex-col gap-2 px-3 py-2.5">
                    <span className="line-clamp-2 min-w-0 break-words">{inputOf(answer)}</span>
                    <div className="grid gap-3 sm:grid-cols-3">
                        <Answered label="Expected" value={answer.expected} right={null} />
                        <Answered
                            label={mine}
                            value={answer.version.answer}
                            right={right(answer.version.scores)}
                        />
                        <Answered
                            label={theirs}
                            value={answer.live?.answer ?? ""}
                            right={answer.live ? right(answer.live.scores) : null}
                        />
                    </div>
                </li>
            ))}
        </ul>
    );
}

function Differs({
    row,
    versions,
    version,
}: {
    row: ModelRow;
    versions: VersionInfo[];
    version: VersionInfo;
}) {
    const reference = references(row, versions, version)[0];
    const [shown, setShown] = useState<"better" | "worse" | null>(null);
    const can = useCan();
    const ready =
        can.build && version.status === "ready" && version.score !== null && Boolean(reference);
    const answers = useAnswers(row.key, version.number, reference?.version.number ?? null, ready);
    if (!ready || !reference) {
        return null;
    }
    const all = answers.data?.examples ?? [];
    const metric = answers.data?.metric;
    const groups = {
        better: all.filter((answer) => verdictOf(answer, metric) === "better"),
        worse: all.filter((answer) => verdictOf(answer, metric) === "worse"),
    };
    const line = (verdict: "better" | "worse", label: string) => (
        <span className="flex items-baseline gap-2">
            <span className="font-medium tabular-nums">
                {`${label} on ${groups[verdict].length} ${groups[verdict].length === 1 ? "example" : "examples"}`}
            </span>
            {groups[verdict].length > 0 && (
                <Button
                    variant="link"
                    className="h-auto p-0 tabular-nums"
                    aria-expanded={shown === verdict}
                    onClick={() => setShown(shown === verdict ? null : verdict)}
                >
                    {shown === verdict ? "Hide them" : `Show the ${groups[verdict].length}`}
                </Button>
            )}
        </span>
    );
    return (
        <PanelSection
            icon={GitCompare}
            title="Where it differs"
            tip={`Against ${reference.label}, on ${count(all.length)} held-out rows.`}
        >
            <div className="flex flex-col gap-3">
                <ErrorLine error={answers.error} onRetry={answers.refetch} />
                {answers.isLoading ? (
                    <p className="text-muted-foreground">Comparing answers…</p>
                ) : (
                    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                        {line("better", "Better")}
                        {line("worse", "Worse")}
                    </div>
                )}
                {shown && (
                    <ExampleList
                        rows={groups[shown]}
                        mine={`This version, v${version.number}`}
                        theirs={reference.label.charAt(0).toUpperCase() + reference.label.slice(1)}
                        metric={metric}
                    />
                )}
            </div>
        </PanelSection>
    );
}

function Progress({
    row,
    versions,
    version,
}: { row: ModelRow; versions: VersionInfo[]; version: VersionInfo }) {
    const progress = version.job?.progress ?? 0;
    const live = isDeployed(row) ? liveOf(versions) : undefined;
    return (
        <PanelSection
            icon={Hourglass}
            title="Progress"
            tip={`Scored against ${live ? `deployed v${live.number} and ` : ""}v0 · Baseline when it finishes.`}
        >
            <div className="flex flex-col gap-2">
                <VersionStatus row={row} version={version} />
                <ProgressBar
                    value={progress}
                    label={`v${version.number} progress`}
                    className="w-full"
                />
            </div>
        </PanelSection>
    );
}

function Failure({ version }: { version: VersionInfo }) {
    return (
        <PanelSection icon={Gauge} title="Score">
            <div className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5">
                <span className="font-medium">Training failed</span>
                <span className="text-sm">{version.job?.error ?? "No reason was recorded."}</span>
            </div>
        </PanelSection>
    );
}

const SETTING_NAMES: Record<string, (recipe: Record<string, unknown>) => string> = {
    rank: (recipe) => `rank ${recipe.rank}`,
    epochs: (recipe) => `${recipe.epochs} ${recipe.epochs === 1 ? "epoch" : "epochs"}`,
    learning_rate: (recipe) => `learning rate ${recipe.learning_rate}`,
    max_rows: (recipe) => `${count(Number(recipe.max_rows))} rows at most`,
    strategy: (recipe) => (recipe.strategy === "qlora" ? "QLoRA" : "LoRA"),
    checkpointing: (recipe) => `checkpointing ${recipe.checkpointing ? "on" : "off"}`,
    micro_batch: (recipe) => `batch ${recipe.micro_batch}`,
    seq_len: (recipe) => `sequence ${count(Number(recipe.seq_len))} tokens`,
    alpha: (recipe) => `alpha ${recipe.alpha}`,
    grad_accum: (recipe) => `accumulation ${recipe.grad_accum}`,
    eval_every: (recipe) => `scored every ${recipe.eval_every} steps`,
    seed: (recipe) => `seed ${recipe.seed}`,
};

function settingsText(version: VersionInfo): string {
    const recipe = version.recipe as Record<string, unknown>;
    const overrides = Array.isArray(recipe.overrides) ? (recipe.overrides as string[]) : [];
    const changed = overrides.map((name) => SETTING_NAMES[name]?.(recipe) ?? name);
    return changed.length === 0 ? "Default settings" : `${changed.join(", ")}; the rest default`;
}

function jobText(job: JobInfo): string {
    const seconds =
        job.started_at && job.finished_at
            ? (Date.parse(job.finished_at) - Date.parse(job.started_at)) / 1000
            : null;
    const took =
        job.status === "running"
            ? "running"
            : job.status === "failed"
              ? "failed"
              : seconds
                ? durationText(seconds)
                : null;
    return `${job.kind === "train" ? "Training" : "Scoring"} job #${job.id}${took ? ` · ${took}` : ""} →`;
}

type RanOn = { pool: string | null; machine: string | null };

function ranOn(version: VersionInfo, job: JobDetail | undefined): RanOn | null {
    const parts = [job?.host, job?.device].filter(Boolean);
    if (parts.length > 0) {
        return { pool: job?.pool ?? null, machine: parts.join(" · ") };
    }
    const plan = (version.recipe as { plan?: { machine?: unknown; pool?: unknown } }).plan;
    const machine = typeof plan?.machine === "string" ? plan.machine : null;
    const pool = typeof plan?.pool === "string" && plan.pool ? plan.pool : null;
    return machine || pool ? { pool, machine } : null;
}

function RanOnText({ place }: { place: RanOn }) {
    if (!place.pool) {
        return <span className="font-mono text-sm">{place.machine}</span>;
    }
    return <PoolLink name={place.pool} machine={place.machine} />;
}

function MadeFrom({
    row,
    versions,
    version,
    job,
    detail,
}: {
    row: ModelRow;
    versions: VersionInfo[];
    version: VersionInfo;
    job: JobInfo | undefined;
    detail: JobDetail | undefined;
}) {
    const live = isDeployed(row) ? liveOf(versions) : undefined;
    const since =
        live && live.number !== version.number && live.dataset_version_rows
            ? (version.dataset_version_rows ?? 0) - live.dataset_version_rows
            : 0;
    const data =
        version.dataset_version_number !== null && version.dataset_version_number !== undefined
            ? `${version.dataset_slug ? `${version.dataset_slug} ` : ""}v${version.dataset_version_number} · ${count(version.dataset_version_rows ?? 0)} rows${since !== 0 ? `, ${since > 0 ? "+" : "−"}${count(Math.abs(since))} since live` : ""}`
            : "No data";
    const parts: [string, ReactNode][] = [
        [
            "Data",
            <span key="data" className="tabular-nums">
                {data}
            </span>,
        ],
        [
            "Method",
            version.kind === "prompt" ? (
                <span key="method">
                    Instructions only: the base with its instructions, no training
                </span>
            ) : (
                <Tip
                    key="method"
                    tip="Supervised fine-tuning: it learns to answer like your labelled rows."
                >
                    <span className="cursor-default underline decoration-dotted underline-offset-4">
                        Supervised fine-tuning (SFT)
                    </span>
                </Tip>
            ),
        ],
    ];
    parts.push(["Training", <span key="training">{trainingText(version)}</span>]);
    if (version.kind !== "prompt") {
        parts.push(["Settings", <span key="settings">{settingsText(version)}</span>]);
    }
    const place = ranOn(version, detail);
    if (place) {
        parts.push(["Pool", <RanOnText key="pool" place={place} />]);
    }
    if (version.duplicated_from) {
        parts.push([
            "Copied from",
            <Link
                key="copy"
                href={modelPageHref(version.duplicated_from.slug)}
                className="text-primary hover:underline"
            >
                {`${version.duplicated_from.name} v${version.duplicated_from.number}`}
            </Link>,
        ]);
    }
    if (job) {
        parts.push([
            "Job",
            <Link key="job" href={jobHref(job)} className="text-primary hover:underline">
                {jobText(job)}
            </Link>,
        ]);
    }
    return (
        <PanelSection icon={SlidersHorizontal} title="Made from">
            <Facts items={parts} />
        </PanelSection>
    );
}

function Identifiers({ row, version }: { row: ModelRow; version: VersionInfo }) {
    const callable = `${row.key}@${version.number}`;
    const files = useVersionFiles(
        row.key,
        version.kind === "lora" && version.status === "ready" ? version.number : null,
    );
    const sha = files.data?.artifact_id;
    return (
        <PanelSection
            icon={Fingerprint}
            title="Identifiers"
            tip="The short SHA-256 identifies its adapter."
        >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="flex items-center gap-0.5">
                    <span className="font-mono text-sm">{callable}</span>
                    <CopyButton value={callable} label={`Copy ${callable}`} />
                </span>
                {sha && (
                    <Tip tip={sha}>
                        <span className="cursor-default font-mono text-sm text-muted-foreground">
                            {sha.slice(0, 12)}
                        </span>
                    </Tip>
                )}
            </div>
        </PanelSection>
    );
}

function artifactHref(id: string): string {
    return `/api/artifacts/${id}`;
}

function Exports({ row, version }: { row: ModelRow; version: VersionInfo }) {
    const can = useCan();
    const models = useAllModels();
    const files = useVersionFiles(
        row.key,
        version.kind === "lora" && version.status === "ready" ? version.number : null,
    );
    const sha = files.data?.artifact_id;
    if (!sha) {
        return null;
    }
    return (
        <PanelSection icon={Package} title="Exports" flush>
            <ul className="divide-y">
                <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-panel py-3">
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-medium">Adapter only</span>
                            <span className="text-sm text-muted-foreground tabular-nums">
                                {`${bytes(files.data?.size)} · safetensors in a tar · loads on ${baseNameOf(models.data, version.base_model || row.base_model)} in minibrain, vLLM or PEFT`}
                            </span>
                        </span>
                        <span className="flex min-w-0 items-center gap-1">
                            <span className="shrink-0 text-sm text-muted-foreground">SHA-256</span>
                            <span className="truncate font-mono text-sm" title={sha}>
                                {sha}
                            </span>
                            <span className="-my-1.5 shrink-0">
                                <CopyButton value={sha} label="Copy SHA-256" />
                            </span>
                        </span>
                    </span>
                    {can.build && (
                        <Button variant="outline" asChild>
                            <a href={artifactHref(sha)} download>
                                <Download aria-hidden="true" />
                                Download
                            </a>
                        </Button>
                    )}
                </li>
            </ul>
        </PanelSection>
    );
}

const FORMATS = [
    {
        id: "adapter",
        label: "Adapter only",
        file: "safetensors",
        runs: "Loads on the same base in minibrain, vLLM or PEFT.",
        ready: true,
    },
    {
        id: "merged",
        label: "Merged full model",
        file: "safetensors",
        runs: "The base with the adapter folded in; runs on any server for Hugging Face models.",
        ready: false,
    },
    {
        id: "gguf",
        label: "Merged and quantised GGUF",
        file: "GGUF",
        runs: "For llama.cpp or Ollama, on a laptop or CPU server.",
        ready: false,
    },
];

function ExportDialog({
    row,
    version,
    open,
    onOpenChange,
}: {
    row: ModelRow;
    version: VersionInfo;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const files = useVersionFiles(row.key, open ? version.number : null);
    const sha = files.data?.artifact_id;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{`Export v${version.number}`}</DialogTitle>
                    <DialogDescription>
                        {`Files of ${row.name} v${version.number} you can run elsewhere. Each carries its SHA-256.`}
                    </DialogDescription>
                </DialogHeader>
                <ul className="flex flex-col divide-y rounded-md border">
                    {FORMATS.map((item) => (
                        <li key={item.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="flex flex-wrap items-baseline gap-x-3">
                                    <span
                                        className={cn(
                                            "font-medium",
                                            !item.ready && "text-muted-foreground",
                                        )}
                                    >
                                        {item.label}
                                    </span>
                                    <span className="text-sm text-muted-foreground">
                                        {item.ready && files.data
                                            ? `${item.file} · ${bytes(files.data.size)}`
                                            : item.file}
                                    </span>
                                </span>
                                <span className="text-sm text-muted-foreground">{item.runs}</span>
                            </span>
                            {item.ready ? (
                                <Button variant="outline" disabled={!sha} asChild={Boolean(sha)}>
                                    {sha ? (
                                        <a href={artifactHref(sha)} download>
                                            <Download aria-hidden="true" />
                                            Download
                                        </a>
                                    ) : (
                                        "Download"
                                    )}
                                </Button>
                            ) : (
                                <Badge variant="neutral">Coming soon</Badge>
                            )}
                        </li>
                    ))}
                </ul>
                <DialogFooter>
                    <Button onClick={() => onOpenChange(false)}>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function copyText(value: string): Promise<void> {
    return navigator.clipboard
        ? navigator.clipboard.writeText(value)
        : Promise.reject(new Error("blocked"));
}

function VersionMenu({
    row,
    versions,
    version,
}: { row: ModelRow; versions: VersionInfo[]; version: VersionInfo }) {
    const router = useRouter();
    const toast = useToast();
    const can = useCan();
    const client = useQueryClient();
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [exporting, setExporting] = useState(false);
    const callable = `${row.key}@${version.number}`;
    const ready = version.status === "ready";
    const exportable = ready && version.kind === "lora";
    const isLive = isDeployed(row) && row.current_version === version.number;
    const others = versions
        .filter((item) => item.number !== version.number && item.status === "ready")
        .sort((a, b) => b.number - a.number);
    const remove = () =>
        setConfirmation({
            title: `Delete ${versionLabel(version)} of ${row.name}?`,
            description: (
                <p>{`${callable} stops answering and its adapter, scores and card are removed.`}</p>
            ),
            confirmLabel: "Delete version",
            destructive: true,
            run: async () => {
                await unwrap(
                    api.DELETE("/api/models/{name}/versions/{number}", {
                        params: {
                            path: { name: row.key, number: version.number },
                            query: { cancel_jobs: true },
                        },
                    }),
                );
                await client.invalidateQueries();
                toast({ title: `Deleted v${version.number}`, tone: "success" });
                router.history.push(modelPageHref(row.key, "versions"));
            },
        });
    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        size="icon"
                        aria-label={`More actions for v${version.number}`}
                    >
                        <MoreHorizontal />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                    <DropdownMenuItem
                        disabled={!ready}
                        onSelect={() =>
                            router.history.push(versionPlaygroundHref(row.key, version.number))
                        }
                    >
                        <Play />
                        Try in Playground
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger disabled={!ready || others.length === 0}>
                            <GitCompare />
                            Compare with…
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-48">
                            {others.map((item) => (
                                <DropdownMenuItem
                                    key={item.number}
                                    onSelect={() =>
                                        router.history.push(
                                            modelCompareHref(
                                                row.key,
                                                Math.min(item.number, version.number),
                                                Math.max(item.number, version.number),
                                            ),
                                        )
                                    }
                                >
                                    {versionLabel(item)}
                                    {item.current && isDeployed(row) && (
                                        <span className="ml-auto text-sm text-muted-foreground">
                                            Live
                                        </span>
                                    )}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuItem
                        onSelect={() =>
                            copyText(callable).then(
                                () => toast({ title: `Copied ${callable}` }),
                                () => toast({ title: "This browser blocks copying here" }),
                            )
                        }
                    >
                        <Copy />
                        <span>
                            Copy <span className="font-mono">{callable}</span>
                        </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onSelect={() => router.history.push(modelCardHref(row.key, version.number))}
                    >
                        <BookOpen />
                        Model card
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        disabled={!exportable || !can.build}
                        className={exportable ? undefined : "items-start"}
                        onSelect={() => setExporting(true)}
                    >
                        <Download className={exportable ? undefined : "mt-0.5"} />
                        <span className="flex flex-col">
                            <span>Export…</span>
                            {!exportable && (
                                <span className="text-sm whitespace-normal text-muted-foreground">
                                    {version.kind === "prompt"
                                        ? "A prompt-only version has no weights of its own."
                                        : "Only a ready version can be exported."}
                                </span>
                            )}
                        </span>
                    </DropdownMenuItem>
                    {can.build && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                variant="destructive"
                                disabled={isLive}
                                onSelect={remove}
                            >
                                <Trash2 />
                                {isLive ? "Delete version (live)" : "Delete version"}
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
            <ExportDialog
                row={row}
                version={version}
                open={exporting}
                onOpenChange={setExporting}
            />
        </>
    );
}

function LiveButton({
    row,
    versions,
    version,
}: { row: ModelRow; versions: VersionInfo[]; version: VersionInfo }) {
    const can = useCan();
    const [open, setOpen] = useState(false);
    if (!can.build || !canGoLive(row, version)) {
        return null;
    }
    const blocked = liveBlock(row, version);
    return (
        <>
            <Tip tip={blocked}>
                <Button disabled={Boolean(blocked)} onClick={() => setOpen(true)}>
                    {`Deploy v${version.number}`}
                </Button>
            </Tip>
            <DeployVersionDialog
                row={row}
                versions={versions}
                number={open ? version.number : null}
                onOpenChange={setOpen}
            />
        </>
    );
}

function Curves({ job }: { job: JobDetail }) {
    const metrics = useJobMetrics(job.id, isActiveJob(job));
    return (
        <>
            <ErrorLine error={metrics.error} onRetry={metrics.refetch} />
            <LossSection job={job} metrics={metrics.data} />
            <RateSection metrics={metrics.data} />
        </>
    );
}

export function VersionView({ row, number }: { row: ModelRow; number: number }) {
    const models = useAllModels();
    const versions = useVersions(row.key);
    const jobs = useJobs(row.key);
    const list = versions.data ?? [];
    const version = list.find((item) => item.number === number);
    const run = version ? runJob(version, jobs.data ?? []) : undefined;
    const runDetail = useJob(run?.id ?? null);
    const job = runDetail.data;
    const crumbs = modelCrumbs(row, [{ label: `v${number}` }]);
    if (!version) {
        return (
            <Page wide>
                <Crumbs items={crumbs} />
                {versions.isLoading ? (
                    <p className="text-muted-foreground">Loading…</p>
                ) : versions.error ? (
                    <QueryError error={versions.error} retry={versions.refetch} />
                ) : (
                    <NotFoundState
                        title="Version not found"
                        primary={{
                            label: "Go to Versions",
                            href: modelPageHref(row.key, "versions"),
                        }}
                        secondary={{ label: `Go to ${row.name}`, href: modelPageHref(row.key) }}
                    >
                        {Number.isInteger(number) && number >= 0
                            ? `${row.name} has no v${number}. It may have been deleted.`
                            : `${row.name} has no version with that number.`}
                    </NotFoundState>
                )}
            </Page>
        );
    }
    const live = isDeployed(row) ? liveOf(list) : undefined;
    const delta =
        version.status === "ready" &&
        live &&
        live.number !== version.number &&
        live.score !== null &&
        version.score !== null
            ? version.score - live.score
            : null;
    const base = baseNameOf(models.data, version.base_model || row.base_model);
    return (
        <Page wide>
            <Crumbs items={crumbs} />
            <CompactHeader
                title={versionLabel(version)}
                facts={[
                    <VersionStatus key="status" row={row} version={version} />,
                    delta !== null ? <Delta key="delta" value={delta} suffix="vs live" /> : null,
                ]}
                subtitle={`${row.name} on ${base} · created ${relativeTime(version.created_at)}`}
                actions={
                    <>
                        <LiveButton row={row} versions={list} version={version} />
                        <VersionMenu row={row} versions={list} version={version} />
                    </>
                }
            />
            <PanelSections>
                {version.status === "ready" && (
                    <ScoreSection row={row} versions={list} version={version} />
                )}
                {["training", "evaluating", "queued"].includes(version.status) && (
                    <Progress row={row} versions={list} version={version} />
                )}
                {version.status === "failed" && <Failure version={version} />}
                {job?.kind === "train" && <Curves key={job.id} job={job} />}
                <Differs row={row} versions={list} version={version} />
                <MadeFrom row={row} versions={list} version={version} job={run} detail={job} />
                <Identifiers row={row} version={version} />
                <Exports row={row} version={version} />
                {run && <JobLogsSection key={run.id} job={job ?? run} anchor="logs" />}
            </PanelSections>
        </Page>
    );
}

export function useVersionNumber(): number {
    const { number } = useParams({ strict: false }) as { number?: string };
    return Number((number ?? "").replace(/^v/, ""));
}
