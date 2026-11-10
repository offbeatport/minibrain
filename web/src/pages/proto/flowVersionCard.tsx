import { useRouter } from "@tanstack/react-router";
import { Download, Play } from "lucide-react";
import {
    Button,
    Link,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    Tabs,
    TabsList,
    TabsTrigger,
    cn,
    useToast,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import { CopyButton } from "~/components/CopyButton";
import { Facts } from "~/components/Facts";
import { ProgressBar, StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { closeVersion, useCan, useOverlays } from "./flowOverlays";
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
    datasetOf,
    findVersion,
    jobHref,
    jobOfVersion,
    liveVersion,
    openIntent,
    pct,
    playgroundHref,
    previousLive,
    retryWithQLoRA,
    rowsSinceLive,
    shortAgo,
    shortHash,
    timeLeft,
    useFlowState,
    verdictOf,
    versionName,
    versionState,
} from "./modelsFlowData";
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

export function versionTitle(model: FlowModel, version: FlowVersion): string {
    return `${versionName(version)} · ${versionState(model, version).label}`;
}

function memoryError(version: FlowVersion): boolean {
    return /memory/i.test(version.error ?? "");
}

export function VersionActions({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const router = useRouter();
    const toast = useToast();
    const can = useCan("builder");
    if (version.status === "failed") {
        return (
            <>
                <Button variant="outline" asChild>
                    <Link href={jobHref(version.jobId)}>{`Job #${version.jobId}`}</Link>
                </Button>
                {can && memoryError(version) && (
                    <Button
                        onClick={() => {
                            const number = retryWithQLoRA(model.slug, version.number);
                            const job = jobOfVersion(model.slug, number);
                            closeVersion();
                            toast({ title: `v${number} is training with QLoRA`, tone: "success" });
                            if (job) {
                                router.history.push(jobHref(job));
                            }
                        }}
                    >
                        Retry with QLoRA
                    </Button>
                )}
            </>
        );
    }
    if (version.status === "training") {
        return (
            <Button variant="outline" asChild>
                <Link href={jobHref(version.jobId)}>{`Job #${version.jobId}`}</Link>
            </Button>
        );
    }
    const live = makeLiveLabel(model, version);
    return (
        <>
            <Button variant="outline" asChild>
                <Link href={playgroundHref(model.slug, version.number)}>
                    <Play aria-hidden="true" />
                    Try in Playground
                </Link>
            </Button>
            {can && live && (
                <Button
                    variant={
                        live === "Make live" && version.passed !== false ? "default" : "outline"
                    }
                    onClick={() =>
                        openIntent({
                            kind: "make-live",
                            slug: model.slug,
                            number: version.number,
                        })
                    }
                >
                    {live === "Make live" ? `Make v${version.number} live` : live}
                </Button>
            )}
        </>
    );
}

function ScoreLine({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const score = version.scores?.[0] ?? null;
    if (score === null) {
        return null;
    }
    return (
        <section className="flex flex-col gap-1">
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
            <p className="text-sm text-muted-foreground tabular-nums">
                {`${model.metrics[0]} on ${count(model.heldOut)} held-out rows it never trained on.`}
            </p>
        </section>
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
    const [open, setOpen] = useState(false);
    const [shown, setShown] = useState<Exclude<Verdict, "same">>("worse");
    const reference = references(model, version)[0];
    const all = answersFor(model);
    if (!version.scores || !reference) {
        return null;
    }
    if (all.length === 0) {
        return (
            <section className="flex flex-col gap-1 border-t pt-5">
                <p className="text-muted-foreground">
                    Example answers are drawn for Support triage only in this prototype.
                </p>
            </section>
        );
    }
    const of = (verdict: Verdict) =>
        all.filter(
            (answer) => verdictOf(answer, version.number, reference.version.number) === verdict,
        );
    const better = of("better");
    const worse = of("worse");
    const rows = shown === "worse" ? worse : better;
    return (
        <section className="flex flex-col gap-3 border-t pt-5">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="flex flex-col">
                    <span className="font-medium tabular-nums">
                        {`Better on ${better.length} ${better.length === 1 ? "example" : "examples"} · worse on ${worse.length}`}
                    </span>
                    <span className="text-sm text-muted-foreground tabular-nums">
                        {`Against ${reference.label}, on ${all.length} held-out rows drawn for review.`}
                    </span>
                </div>
                {worse.length + better.length > 0 && (
                    <Button
                        variant="outline"
                        aria-expanded={open}
                        onClick={() => {
                            setOpen(!open);
                            setShown(worse.length > 0 ? "worse" : "better");
                        }}
                    >
                        {open
                            ? "Hide examples"
                            : worse.length > 0
                              ? `Show the ${worse.length}`
                              : `Show the ${better.length} better`}
                    </Button>
                )}
            </div>
            {open && (
                <div className="flex flex-col gap-3">
                    <Tabs
                        value={shown}
                        onValueChange={(value) => setShown(value as Exclude<Verdict, "same">)}
                    >
                        <TabsList aria-label="Examples to show">
                            <TabsTrigger value="worse">
                                Worse
                                <span className="text-sm text-muted-foreground tabular-nums">
                                    {worse.length}
                                </span>
                            </TabsTrigger>
                            <TabsTrigger value="better">
                                Better
                                <span className="text-sm text-muted-foreground tabular-nums">
                                    {better.length}
                                </span>
                            </TabsTrigger>
                        </TabsList>
                    </Tabs>
                    {rows.length === 0 ? (
                        <p className="text-muted-foreground">None in this group.</p>
                    ) : (
                        <ExampleList rows={rows} mine={version.number} theirs={reference} />
                    )}
                </div>
            )}
        </section>
    );
}

function Progress({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const share = Math.round((version.progress ?? 0) * 100);
    return (
        <section className="flex flex-col gap-2">
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
            <p className="text-sm text-muted-foreground">
                {`Scored against ${liveVersion(model) ? `live v${model.live} and ` : ""}v0 · Baseline when it finishes. Loss and logs are on the job page.`}
            </p>
        </section>
    );
}

function Failure({ version }: { version: FlowVersion }) {
    return (
        <section className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2.5">
            <span className="font-medium">Training failed, so it was never scored</span>
            <span className="text-sm">{version.error}</span>
        </section>
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
        <section className="flex flex-col gap-2 border-t pt-5">
            <h3 className="font-semibold">Made from</h3>
            <Facts items={parts} />
        </section>
    );
}

function Footer({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const toast = useToast();
    const callable = `${model.slug}@${version.number}`;
    return (
        <footer className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-4">
            <span className="flex items-center gap-0.5">
                <span className="font-mono text-sm">{callable}</span>
                <CopyButton value={callable} label={`Copy ${callable}`} />
            </span>
            <Tip tip="Short SHA-256 of the adapter">
                <span className="cursor-help font-mono text-sm text-muted-foreground">
                    {shortHash(model.slug, version.number)}
                </span>
            </Tip>
            <span className="ml-auto flex items-center gap-2">
                <Button variant="outline" asChild>
                    <Link href={cardHref(model.slug, version.number)}>Model card</Link>
                </Button>
                <Button
                    variant="outline"
                    disabled={version.status !== "ready"}
                    onClick={() =>
                        toast({
                            title: "Not in the prototype",
                            description: `Would download the ${version.kind === "prompt" ? "prompt" : "adapter"} for ${callable}.`,
                        })
                    }
                >
                    <Download aria-hidden="true" />
                    Download
                </Button>
            </span>
        </footer>
    );
}

export function ReportCard({ model, version }: { model: FlowModel; version: FlowVersion }) {
    return (
        <div className="flex flex-col gap-5">
            {version.status === "ready" && <ScoreLine model={model} version={version} />}
            {version.status === "training" && <Progress model={model} version={version} />}
            {version.status === "failed" && <Failure version={version} />}
            <Examples model={model} version={version} />
            <MadeFrom model={model} version={version} />
            <Footer model={model} version={version} />
        </div>
    );
}

export function VersionSheet() {
    const { version: target } = useOverlays();
    const state = useFlowState();
    const model = target ? state.models.find((item) => item.slug === target.slug) : undefined;
    const version = model && target ? findVersion(model, target.number) : undefined;
    return (
        <Sheet open={Boolean(version)} onOpenChange={(open) => !open && closeVersion()}>
            <SheetContent className="gap-5 sm:max-w-xl">
                {model && version && (
                    <>
                        <SheetHeader>
                            <SheetTitle className="text-xl font-normal tabular-nums">
                                {versionTitle(model, version)}
                            </SheetTitle>
                            <SheetDescription>
                                {`${model.name} · on ${model.base} · created ${shortAgo(version)}`}
                            </SheetDescription>
                        </SheetHeader>
                        <div className="flex flex-wrap items-center gap-2">
                            <VersionActions model={model} version={version} />
                        </div>
                        <ReportCard model={model} version={version} />
                    </>
                )}
            </SheetContent>
        </Sheet>
    );
}
