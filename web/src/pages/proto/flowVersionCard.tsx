import { useRouter } from "@tanstack/react-router";
import {
    BookOpen,
    Copy,
    Download,
    Fingerprint,
    Gauge,
    GitCompare,
    Hourglass,
    MoreHorizontal,
    Play,
    SlidersHorizontal,
    Trash2,
} from "lucide-react";
import {
    Button,
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
import { CopyButton } from "~/components/CopyButton";
import { Facts } from "~/components/Facts";
import { PanelSection } from "~/components/Section";
import { ProgressBar, StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { ExportDialog } from "./flowExport";
import { useCan } from "./flowOverlays";
import {
    type Answer,
    BASELINE_HINT,
    type FlowModel,
    type FlowVersion,
    type Verdict,
    answerOf,
    answersFor,
    cardHref,
    changedSettings,
    compareHref,
    datasetOf,
    deleteVersions,
    findVersion,
    jobHref,
    jobOfVersion,
    liveVersion,
    modelHref,
    openIntent,
    pct,
    playgroundHref,
    previousLive,
    retryWithQLoRA,
    rowsSinceLive,
    shortHash,
    timeLeft,
    useFlowState,
    verdictOf,
    versionKey,
    versionName,
} from "./modelsFlowData";
import { type Confirm, ConfirmDialog } from "./modelsFlowDialogs";
import { Delta, Tip, makeLiveLabel } from "./modelsFlowParts";

type Reference = { version: FlowVersion; label: string };

function references(model: FlowModel, version: FlowVersion): Reference[] {
    const live = liveVersion(model);
    const zero = findVersion(model, 0);
    const found: Reference[] = [];
    if (live?.scores && live.number !== version.number) {
        found.push({ version: live, label: `live v${live.number}` });
    }
    const before = live?.number === version.number ? previousLive(model) : undefined;
    if (before?.scores && before.number !== 0) {
        found.push({ version: before, label: `previous live v${before.number}` });
    }
    if (zero?.scores && zero.number !== version.number) {
        found.push({ version: zero, label: "baseline v0" });
    }
    return found;
}

function memoryError(version: FlowVersion): boolean {
    return /memory/i.test(version.error ?? "");
}

export function VersionPrimary({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const router = useRouter();
    const toast = useToast();
    if (!useCan("builder")) {
        return null;
    }
    if (version.status === "failed") {
        return memoryError(version) ? (
            <Button
                onClick={() => {
                    const number = retryWithQLoRA(model.slug, version.number);
                    const job = jobOfVersion(model.slug, number);
                    toast({ title: `v${number} is training with QLoRA`, tone: "success" });
                    if (job) {
                        router.history.push(jobHref(job));
                    }
                }}
            >
                Retry with QLoRA
            </Button>
        ) : null;
    }
    const live = makeLiveLabel(model, version);
    if (!live) {
        return null;
    }
    return (
        <Button
            onClick={() =>
                openIntent({ kind: "make-live", slug: model.slug, number: version.number })
            }
        >
            {live}
        </Button>
    );
}

function copyText(value: string): Promise<void> {
    return navigator.clipboard ? navigator.clipboard.writeText(value) : Promise.reject();
}

export function VersionMenu({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const router = useRouter();
    const toast = useToast();
    const can = useCan("builder");
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const [exporting, setExporting] = useState(false);
    const callable = `${model.slug}@${version.number}`;
    const ready = version.status === "ready";
    const exportable = ready && version.kind === "trained";
    const isLive = model.live === version.number;
    const others = model.versions
        .filter((item) => item.number !== version.number && item.status === "ready")
        .sort((x, y) => y.number - x.number);
    const remove = () =>
        setConfirm({
            title: `Delete ${versionName(version)} of ${model.name}?`,
            description: (
                <p>{`${callable} stops answering and its adapter, scores and card are removed.`}</p>
            ),
            label: "Delete version",
            run: () => {
                deleteVersions([versionKey(model.slug, version.number)]);
                toast({ title: `Deleted v${version.number}`, tone: "success" });
                router.history.push(modelHref(model.slug, "versions"));
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
                            router.history.push(playgroundHref(model.slug, version.number))
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
                                            compareHref(
                                                model.slug,
                                                Math.min(item.number, version.number),
                                                Math.max(item.number, version.number),
                                            ),
                                        )
                                    }
                                >
                                    {versionName(item)}
                                    {model.live === item.number && (
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
                        onSelect={() => router.history.push(cardHref(model.slug, version.number))}
                    >
                        <BookOpen />
                        Model card
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        disabled={!exportable}
                        className={exportable ? undefined : "items-start"}
                        onSelect={() => setExporting(true)}
                    >
                        <Download className={exportable ? undefined : "mt-0.5"} />
                        <span className="flex flex-col">
                            <span>Export…</span>
                            {!exportable && (
                                <span className="text-sm whitespace-normal text-muted-foreground">
                                    {version.kind === "prompt"
                                        ? "A baseline has no weights of its own."
                                        : "Only a ready version can be exported."}
                                </span>
                            )}
                        </span>
                    </DropdownMenuItem>
                    {can && (
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
            <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
            <ExportDialog
                model={model}
                version={version}
                open={exporting}
                onClose={() => setExporting(false)}
            />
        </>
    );
}

function ScoreLine({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const score = version.scores?.[0] ?? null;
    if (score === null) {
        return null;
    }
    return (
        <PanelSection
            icon={Gauge}
            title="Score"
            description={`${model.metrics[0]} on ${count(model.heldOut)} held-out rows it never trained on.`}
        >
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                <span className="text-3xl tabular-nums">{pct(score)}</span>
                {references(model, version).map((reference) => (
                    <span key={reference.label} className="tabular-nums">
                        <Delta
                            value={score - (reference.version.scores?.[0] ?? 0)}
                            suffix={`vs ${reference.label} (${pct(reference.version.scores?.[0])})`}
                        />
                    </span>
                ))}
            </div>
        </PanelSection>
    );
}

function Answered({ label, value, expected }: { label: string; value: string; expected: string }) {
    const right = value === expected;
    return (
        <div className="flex min-w-0 flex-col">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span
                className={cn(
                    "truncate font-mono text-sm",
                    right ? "text-foreground" : "text-destructive",
                )}
            >
                {value}
                <span className="sr-only">{right ? " (right)" : " (wrong)"}</span>
            </span>
        </div>
    );
}

function ExampleList({
    rows,
    mine,
    theirs,
}: {
    rows: Answer[];
    mine: number;
    theirs: Reference;
}) {
    return (
        <ul className="flex flex-col divide-y rounded-md border">
            {rows.map((answer) => (
                <li key={answer.id} className="flex flex-col gap-2 px-3 py-2.5">
                    <span className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0">{answer.text}</span>
                        <span className="shrink-0 font-mono text-sm text-muted-foreground">
                            {`#${answer.id}`}
                        </span>
                    </span>
                    <div className="grid grid-cols-3 gap-3">
                        <Answered
                            label="Expected"
                            value={answer.expected}
                            expected={answer.expected}
                        />
                        <Answered
                            label={`This version, v${mine}`}
                            value={answerOf(answer, mine)}
                            expected={answer.expected}
                        />
                        <Answered
                            label={`${theirs.label.charAt(0).toUpperCase()}${theirs.label.slice(1)}`}
                            value={answerOf(answer, theirs.version.number)}
                            expected={answer.expected}
                        />
                    </div>
                </li>
            ))}
        </ul>
    );
}

function Examples({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const [shown, setShown] = useState<Exclude<Verdict, "same"> | null>(null);
    const reference = references(model, version)[0];
    const all = answersFor(model);
    if (!version.scores || !reference) {
        return null;
    }
    if (all.length === 0) {
        return (
            <PanelSection
                icon={GitCompare}
                title="Where it differs"
                description={`Held-out answers where it beats or trails ${reference.label}.`}
            >
                <p className="text-muted-foreground">
                    Example answers are drawn for Support triage only in this prototype.
                </p>
            </PanelSection>
        );
    }
    const of = (verdict: Verdict) =>
        all.filter(
            (answer) => verdictOf(answer, version.number, reference.version.number) === verdict,
        );
    const groups = { better: of("better"), worse: of("worse") };
    const toggle = (verdict: Exclude<Verdict, "same">) => (
        <Button
            variant="link"
            className="h-auto p-0 tabular-nums"
            aria-expanded={shown === verdict}
            onClick={() => setShown(shown === verdict ? null : verdict)}
        >
            {shown === verdict ? "Hide them" : `Show the ${groups[verdict].length}`}
        </Button>
    );
    const line = (verdict: Exclude<Verdict, "same">, label: string) => (
        <span className="flex items-baseline gap-2">
            <span className="font-medium tabular-nums">{`${label} on ${groups[verdict].length} ${groups[verdict].length === 1 ? "example" : "examples"}`}</span>
            {groups[verdict].length > 0 && toggle(verdict)}
        </span>
    );
    return (
        <PanelSection
            icon={GitCompare}
            title="Where it differs"
            description={`Against ${reference.label}, on ${all.length} held-out rows drawn for review.`}
        >
            <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                    {line("better", "Better")}
                    {line("worse", "Worse")}
                </div>
                {shown && (
                    <ExampleList rows={groups[shown]} mine={version.number} theirs={reference} />
                )}
            </div>
        </PanelSection>
    );
}

function Progress({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const share = Math.round((version.progress ?? 0) * 100);
    return (
        <PanelSection
            icon={Hourglass}
            title="Progress"
            description={`Scored against ${liveVersion(model) ? `live v${model.live} and ` : ""}v0 · Baseline when it finishes; loss and logs are on the job page.`}
        >
            <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <StatusText tone="info">
                        <span className="tabular-nums">{`Training · ${share}%`}</span>
                    </StatusText>
                    <span className="text-sm text-muted-foreground tabular-nums">
                        {`${timeLeft(version)} left`}
                    </span>
                </div>
                <ProgressBar
                    value={version.progress ?? 0}
                    label={`v${version.number} progress`}
                    className="w-full"
                />
            </div>
        </PanelSection>
    );
}

function Failure({ version }: { version: FlowVersion }) {
    return (
        <PanelSection
            icon={Gauge}
            title="Score"
            description="Training failed, so it was never scored."
        >
            <div className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5">
                <span className="font-medium">Training failed</span>
                <span className="text-sm">{version.error}</span>
            </div>
        </PanelSection>
    );
}

function MadeFrom({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const state = useFlowState();
    const dataset = datasetOf(model);
    const since = model.live === version.number ? null : rowsSinceLive(model, version.data.rows);
    const job = state.jobs.find((item) => item.id === version.jobId);
    const settings = version.settings;
    const changes = settings ? changedSettings(settings) : [];
    const took =
        job?.status === "running"
            ? "running"
            : job?.status === "failed"
              ? "failed"
              : job?.minutes
                ? `${job.minutes} min`
                : null;
    const parts: [string, ReactNode][] = [
        [
            "Data",
            <span key="data" className="tabular-nums">
                {`${dataset ? `${dataset.slug} ` : ""}v${version.data.number} · ${count(version.data.rows)} rows${since !== null && since !== 0 ? `, ${since > 0 ? "+" : "−"}${count(Math.abs(since))} since live` : ""}`}
            </span>,
        ],
        [
            "Method",
            version.kind === "prompt" ? (
                <span key="method">{BASELINE_HINT}</span>
            ) : (
                <Tip
                    key="method"
                    tip="Supervised fine-tuning: it learns to answer like your labelled rows."
                >
                    <span className="cursor-help underline decoration-dotted underline-offset-4">
                        Supervised fine-tuning (SFT)
                    </span>
                </Tip>
            ),
        ],
    ];
    if (settings) {
        parts.push([
            "Settings",
            <span key="settings">
                {changes.length === 0
                    ? "Default settings"
                    : `${changes.join(", ")}; the rest default`}
            </span>,
        ]);
    }
    parts.push([
        "Job",
        <Link key="job" href={jobHref(version.jobId)} className="text-primary hover:underline">
            {`${version.kind === "prompt" ? "Scoring" : "Training"} job #${version.jobId}${took ? ` · ${took}` : ""} →`}
        </Link>,
    ]);
    return (
        <PanelSection
            icon={SlidersHorizontal}
            title="Made from"
            description="The data, method and settings that built this version."
        >
            <Facts items={parts} />
        </PanelSection>
    );
}

function Footer({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const callable = `${model.slug}@${version.number}`;
    return (
        <PanelSection
            icon={Fingerprint}
            title="Identifiers"
            description="Call this version by its name; the short SHA-256 identifies its adapter."
        >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="flex items-center gap-0.5">
                    <span className="font-mono text-sm">{callable}</span>
                    <CopyButton value={callable} label={`Copy ${callable}`} />
                </span>
                <Tip tip="Short SHA-256 of the adapter">
                    <span className="cursor-help font-mono text-sm text-muted-foreground">
                        {shortHash(model.slug, version.number)}
                    </span>
                </Tip>
            </div>
        </PanelSection>
    );
}

export function ReportCard({ model, version }: { model: FlowModel; version: FlowVersion }) {
    return (
        <>
            {version.status === "ready" && <ScoreLine model={model} version={version} />}
            {version.status === "training" && <Progress model={model} version={version} />}
            {version.status === "failed" && <Failure version={version} />}
            <Examples model={model} version={version} />
            <MadeFrom model={model} version={version} />
            <Footer model={model} version={version} />
        </>
    );
}
