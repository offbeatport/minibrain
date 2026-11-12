import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ChartLine, Database, GraduationCap, ListChecks, ThumbsUp } from "lucide-react";
import {
    Button,
    Link,
    SegmentedTabs,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import {
    type JobInfo,
    type ModelDetail,
    type ModelRow,
    type VersionInfo,
    api,
    unwrap,
} from "~/api/client";
import { useJobsMetrics } from "~/api/modelPageQueries";
import { isActiveJob, useJobs } from "~/api/queries";
import { FeedbackSince } from "~/components/FeedbackSince";
import { ErrorLine, PanelSection, PanelSections } from "~/components/Section";
import { TestExamples } from "~/components/TestExamples";
import {
    LineChart,
    type LineRow,
    type LineSeries,
    SERIES_COLORS,
} from "~/components/charts/LineChart";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import { useCan } from "~/lib/access";
import { count, percent } from "~/lib/format";
import { jobDuration, useInvalidate } from "~/lib/jobs";
import { useSearchParam } from "~/lib/listSearch";
import { metricName } from "~/lib/metrics";
import { jobHref, modelPageHref, modelVersionHref } from "~/lib/modelLinks";
import { relativeTime } from "~/lib/time";
import { TrainingData as DatasetChoice } from "../../data/TrainingData";
import { ModelDataNotice } from "../../data/versionData";
import { InstructionsSection } from "../InstructionsSection";
import { JudgedSection } from "../JudgedSection";
import { Tip, isDeployed, nextVersion, trainBlock } from "./header";
import { liveOf, versionLabel } from "./makeLive";
import { TrainDialog } from "./train/TrainDialog";
import { recipeText } from "./versions";

type View = "scores" | "loss";

const VIEWS: { key: View; label: string }[] = [
    { key: "scores", label: "Score by version" },
    { key: "loss", label: "Loss curves" },
];

const DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const DATE_TIME = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
});

function finishedAt(version: VersionInfo): number {
    return Date.parse(version.job?.finished_at ?? version.created_at);
}

function niceDomain(values: number[]): [number, number] {
    const floor = Math.floor((Math.min(...values) - 0.01) / 0.05) * 0.05;
    const span = (Math.max(...values) + 0.01 - floor) / 4;
    const step = [0.025, 0.05, 0.1, 0.25].find((item) => item >= span) ?? 0.25;
    const low = Math.max(0, Math.min(floor, 1 - step * 4));
    return [low, low + step * 4];
}

function ruleFloor(
    detail: ModelDetail | undefined,
    metric: string | null | undefined,
): number | null {
    const found = detail?.promotion.thresholds?.find(
        (item) => item.metric === metric && (item.op === ">=" || item.op === ">"),
    );
    return found ? found.value : null;
}

function ScoreChart({
    row,
    detail,
    versions,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    versions: VersionInfo[];
}) {
    const scored = versions
        .filter((version) => version.status === "ready" && version.score !== null)
        .sort((a, b) => finishedAt(a) - finishedAt(b));
    const metric = scored.at(-1)?.main_metric ?? versions[0]?.main_metric;
    const byStep = new Map(scored.map((version) => [finishedAt(version), version]));
    const rows: LineRow[] = scored.map((version) => ({
        step: finishedAt(version),
        score: version.score,
    }));
    const floor = ruleFloor(detail, metric);
    const live = isDeployed(row) ? scored.find((version) => version.current) : undefined;
    const now = Date.now();
    const values = [
        ...scored.map((version) => version.score ?? 0),
        ...(floor === null ? [] : [floor]),
    ];
    const series: LineSeries[] = [
        { key: "score", label: metricName(metric), color: SERIES_COLORS[0], dots: true },
    ];
    return (
        <LineChart
            rows={
                rows.length > 1
                    ? rows
                    : rows.length === 1
                      ? [{ step: rows[0].step - 86400000 }, ...rows]
                      : [{ step: now - 7 * 86400000 }, { step: now }]
            }
            series={series}
            format={(value) => percent(value)}
            axisFormat={(value) => `${Number((value * 100).toFixed(1))}%`}
            label={`${metricName(metric)} by version for ${row.name}`}
            height={220}
            yDomain={values.length > 0 ? niceDomain(values) : undefined}
            levels={floor === null ? [] : [{ at: floor, label: `Rule ${percent(floor)}` }]}
            markers={live ? [{ at: finishedAt(live), label: `v${live.number} live` }] : []}
            xFormat={(value) => DATE.format(new Date(value))}
            readoutTitle={(value) => {
                const version = byStep.get(value);
                return version
                    ? `${versionLabel(version)} · ${DATE_TIME.format(new Date(value))}`
                    : DATE_TIME.format(new Date(value));
            }}
            legend={false}
            empty={rows.length === 0 ? { title: "No scored versions yet" } : null}
        />
    );
}

function trainJobs(jobs: JobInfo[]): JobInfo[] {
    return jobs.filter((job) => job.kind === "train");
}

function LossChart({
    row,
    jobs,
    versions,
}: { row: ModelRow; jobs: JobInfo[]; versions: VersionInfo[] }) {
    const trains = trainJobs(jobs);
    const running = trains.find((job) => isActiveJob(job));
    const finished = trains
        .filter((job) => job.status === "done" || job.status === "succeeded")
        .slice(0, 3);
    const runs = [...(running ? [running] : []), ...finished];
    const metrics = useJobsMetrics(
        runs.map((job) => job.id),
        (id) => id === running?.id,
    );
    const live = isDeployed(row) ? liveOf(versions)?.number : undefined;
    const curves = runs.map((job, index) => {
        const points = metrics[index]?.data?.training?.points ?? [];
        const last = Math.max(1, ...points.map((point) => point.step));
        const total = metrics[index]?.data?.training?.steps ?? last;
        return {
            job,
            color: SERIES_COLORS[index] ?? SERIES_COLORS[3],
            points: new Map(
                points
                    .filter((point) => point.loss !== null && point.loss !== undefined)
                    .map((point) => [
                        Math.round((point.step / Math.max(total, 1)) * 100),
                        point.loss as number,
                    ]),
            ),
        };
    });
    const steps = [...new Set(curves.flatMap((curve) => [...curve.points.keys()]))].sort(
        (a, b) => a - b,
    );
    const rows: LineRow[] = (steps.length > 0 ? steps : [0, 100]).map((step) => {
        const item: LineRow = { step };
        for (const curve of curves) {
            item[`job${curve.job.id}`] = curve.points.get(step) ?? null;
        }
        return item;
    });
    const series: LineSeries[] = curves
        .filter((curve) => curve.points.size > 0)
        .map((curve) => {
            const name = curve.job.version === null ? `#${curve.job.id}` : `v${curve.job.version}`;
            const active = curve.job.id === running?.id;
            return {
                key: `job${curve.job.id}`,
                label: active
                    ? `${name} running`
                    : curve.job.version === live
                      ? `${name} live`
                      : name,
                color: curve.color,
                width: active ? 3 : 1.5,
            };
        })
        .reverse();
    return (
        <LineChart
            rows={rows}
            series={series}
            legendSeries={[...series].reverse()}
            format={(value) => value.toFixed(3)}
            axisFormat={(value) => value.toFixed(1)}
            label={`Training loss by run for ${row.name}`}
            height={220}
            domain={[0, 100]}
            xFormat={(value) => `${value}%`}
            readoutTitle={(value) => `${value}% of training`}
            empty={series.length === 0 ? { title: "No training runs yet" } : null}
        />
    );
}

function scoreNote(versions: VersionInfo[], detail: ModelDetail | undefined): string {
    const metric = versions.find((version) => version.main_metric)?.main_metric;
    const failed = versions.filter((version) => version.status === "failed");
    const training = versions.find((version) => version.status === "training");
    const notes = [
        failed.length > 0
            ? `${failed.map((version) => `v${version.number}`).join(", ")} failed and ${failed.length === 1 ? "has" : "have"} no score`
            : null,
        training ? `v${training.number} is training` : null,
    ].filter(Boolean);
    const rule = ruleFloor(detail, metric) === null ? "" : " Dashed: the promotion rule.";
    return `${metricName(metric)} on the held-out rows, by the date each version finished.${rule}${notes.length > 0 ? ` ${notes.join("; ")}.` : ""}`;
}

function TrainingChart({
    row,
    detail,
    versions,
    jobs,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    versions: VersionInfo[];
    jobs: JobInfo[];
}) {
    const [view, setView] = useState<View>("scores");
    const running = trainJobs(jobs).some(isActiveJob);
    return (
        <PanelSection
            icon={ChartLine}
            title={view === "scores" ? "Score by version" : "Loss curves"}
            description={
                view === "scores"
                    ? scoreNote(versions, detail)
                    : `Training loss of ${running ? "the running job and " : ""}the last finished runs, by share of training done.`
            }
            actions={
                <SegmentedTabs
                    tabs={VIEWS}
                    active={view}
                    onSelect={(key) => setView(key as View)}
                />
            }
        >
            {view === "scores" ? (
                <ScoreChart row={row} detail={detail} versions={versions} />
            ) : (
                <LossChart row={row} jobs={jobs} versions={versions} />
            )}
        </PanelSection>
    );
}

const JOB_STATUS: Record<string, { tone: Tone; label: string }> = {
    running: { tone: "info", label: "Running" },
    queued: { tone: "neutral", label: "Queued" },
    done: { tone: "success", label: "Done" },
    succeeded: { tone: "success", label: "Done" },
    failed: { tone: "destructive", label: "Failed" },
    cancelled: { tone: "neutral", label: "Cancelled" },
};

function JobStatusText({ job }: { job: JobInfo }) {
    const status = JOB_STATUS[job.status] ?? { tone: "neutral" as const, label: job.status };
    const running = job.status === "running";
    return (
        <span className="flex items-center gap-2">
            <StatusText tone={status.tone}>
                {status.label}
                {running && (
                    <span className="tabular-nums">{` · ${Math.round(job.progress * 100)}%`}</span>
                )}
            </StatusText>
            {running && (
                <ProgressBar value={job.progress} label={`Job ${job.id}`} className="w-16" />
            )}
        </span>
    );
}

function RunsSection({
    row,
    jobs,
    versions,
    actions,
}: {
    row: ModelRow;
    jobs: JobInfo[];
    versions: VersionInfo[];
    actions: ReactNode;
}) {
    const router = useRouter();
    const runs = jobs.filter((job) => job.kind === "train" || job.kind === "eval");
    const byNumber = new Map(versions.map((version) => [version.number, version]));
    return (
        <PanelSection
            icon={GraduationCap}
            title="Training runs"
            description={`Each run trained or scored one version of ${row.name}; open one for its loss and logs.`}
            actions={actions}
            flush
        >
            {runs.length === 0 ? (
                <p className="p-panel text-muted-foreground">No training runs yet.</p>
            ) : (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="pl-panel">Job</TableHead>
                            <TableHead>Version</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Score</TableHead>
                            <TableHead>Method</TableHead>
                            <TableHead className="text-right">Duration</TableHead>
                            <TableHead className="pr-panel">Started</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {runs.map((job) => {
                            const version =
                                job.version === null ? undefined : byNumber.get(job.version);
                            return (
                                <TableRow
                                    key={job.id}
                                    className="cursor-pointer"
                                    onClick={(event) => {
                                        if (!(event.target as HTMLElement).closest("a,button")) {
                                            router.history.push(jobHref(job));
                                        }
                                    }}
                                >
                                    <TableCell className="pl-panel">
                                        <Link
                                            href={jobHref(job)}
                                            className="font-mono text-sm hover:underline"
                                        >
                                            {`#${job.id}`}
                                        </Link>
                                    </TableCell>
                                    <TableCell>
                                        {version ? (
                                            <Link
                                                href={modelVersionHref(row.key, version.number)}
                                                className="font-medium hover:underline"
                                            >
                                                {versionLabel(version)}
                                            </Link>
                                        ) : (
                                            <span className="text-muted-foreground">
                                                {job.version === null ? "–" : `v${job.version}`}
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        <JobStatusText job={job} />
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {version?.score === null || version?.score === undefined
                                            ? "–"
                                            : percent(version.score)}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {job.kind === "eval"
                                            ? "Scoring"
                                            : version
                                              ? recipeText(version).split(" · data")[0]
                                              : "SFT"}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                        {jobDuration(job)}
                                    </TableCell>
                                    <TableCell className="pr-panel text-muted-foreground tabular-nums">
                                        {relativeTime(job.started_at ?? job.created_at)}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            )}
        </PanelSection>
    );
}

function AddData({ detail }: { detail: ModelDetail }) {
    const slug = detail.slug;
    const invalidate = useInvalidate(slug);
    const [dataset, setDataset] = useState(detail.dataset ?? "");
    const prepare = useMutation({
        mutationFn: async () => {
            const path = { params: { path: { name: slug } } };
            await unwrap(api.PUT("/api/models/{name}/dataset", { ...path, body: { dataset } }));
            return unwrap(api.POST("/api/models/{name}/dataset-versions", path));
        },
        onSettled: invalidate,
    });
    return (
        <div className="flex flex-col gap-4">
            <DatasetChoice dataset={dataset} onDataset={setDataset} />
            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
                <Button onClick={() => prepare.mutate()} disabled={!dataset || prepare.isPending}>
                    {prepare.isPending ? "Saving…" : "Use this dataset"}
                </Button>
                <span className="text-sm text-muted-foreground">
                    Models train on a saved version of the dataset, split into training, held-out
                    and test rows.
                </span>
            </div>
            <ErrorLine error={prepare.error} />
        </div>
    );
}

function DataSection({ row, detail }: { row: ModelRow; detail: ModelDetail }) {
    const can = useCan();
    const client = useQueryClient();
    const [changing, setChanging] = useState(false);
    const save = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/models/{name}/dataset-versions", {
                    params: { path: { name: row.key } },
                }),
            ),
        onSettled: () => client.invalidateQueries(),
    });
    const version = detail.dataset_version;
    const counts = version?.counts;
    return (
        <PanelSection
            icon={Database}
            anchor="training-data"
            title="Training data"
            description="The saved dataset version the next run trains and is scored on."
            actions={
                can.build &&
                version && (
                    <>
                        <Button variant="outline" onClick={() => setChanging(!changing)}>
                            {changing ? "Done" : "Change dataset"}
                        </Button>
                        {detail.changed && (
                            <Button
                                variant="outline"
                                disabled={save.isPending}
                                onClick={() => save.mutate()}
                            >
                                Save a new version
                            </Button>
                        )}
                    </>
                )
            }
        >
            {!version || changing ? (
                can.build ? (
                    <AddData detail={detail} />
                ) : (
                    <p className="text-muted-foreground">No training data yet.</p>
                )
            ) : (
                <div className="flex flex-col gap-3">
                    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-4">
                        <div className="flex min-w-0 flex-col gap-0.5">
                            <dt className="text-sm text-muted-foreground">Dataset</dt>
                            <dd className="truncate">
                                {detail.dataset ? (
                                    <Link
                                        href={`/data?item=${encodeURIComponent(`dataset:${detail.dataset}`)}`}
                                        className="text-primary hover:underline"
                                    >
                                        {`${detail.dataset_name ?? detail.dataset} v${version.number ?? "–"}`}
                                    </Link>
                                ) : (
                                    (detail.source?.file ?? "Uploaded file")
                                )}
                            </dd>
                        </div>
                        <div className="flex min-w-0 flex-col gap-0.5">
                            <dt className="text-sm text-muted-foreground">Rows</dt>
                            <dd className="tabular-nums">
                                {`${count(counts?.train ?? 0)} train · ${count(counts?.eval ?? 0)} held out · ${count(counts?.golden ?? 0)} test`}
                            </dd>
                        </div>
                        <div className="flex min-w-0 flex-col gap-0.5">
                            <dt className="text-sm text-muted-foreground">Labels</dt>
                            <dd className="truncate tabular-nums">
                                {version.labels.length > 0
                                    ? `${count(version.labels.length)} labels`
                                    : "Free text"}
                            </dd>
                        </div>
                        <div className="flex min-w-0 flex-col gap-0.5">
                            <dt className="text-sm text-muted-foreground">Saved</dt>
                            <dd className="tabular-nums">
                                {relativeTime(version.taken_at ?? version.created_at)}
                            </dd>
                        </div>
                    </dl>
                    <ModelDataNotice slug={row.key} />
                    <ErrorLine error={save.error} />
                </div>
            )}
        </PanelSection>
    );
}

function TrainButton({
    row,
    detail,
    onTrain,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    onTrain: () => void;
}) {
    const blocked = trainBlock(row, detail);
    return (
        <Tip tip={blocked}>
            <Button disabled={Boolean(blocked)} onClick={onTrain}>
                {`Train v${nextVersion(row)}`}
            </Button>
        </Tip>
    );
}

function ScoreButton({ row, detail }: { row: ModelRow; detail: ModelDetail | undefined }) {
    const client = useQueryClient();
    const score = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/models/{name}/versions", {
                    params: { path: { name: row.key } },
                    body: { kind: "prompt" },
                }),
            ),
        onSettled: () => client.invalidateQueries(),
    });
    return (
        <Tip
            tip={
                detail?.dataset_version
                    ? "Score the base with today's instructions, no training."
                    : "Add training data first."
            }
        >
            <Button
                variant="outline"
                disabled={!detail?.dataset_version || score.isPending}
                onClick={() => score.mutate()}
            >
                Score prompt only
            </Button>
        </Tip>
    );
}

export function TrainingTab({
    row,
    detail,
    versions,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    versions: VersionInfo[];
}) {
    const router = useRouter();
    const jobs = useJobs(row.key);
    const wanted = useSearchParam("train") === "1";
    const [open, setOpen] = useState(false);
    const shown = (open || wanted) && !trainBlock(row, detail);
    const close = () => {
        setOpen(false);
        if (wanted) {
            router.history.replace(modelPageHref(row.key, "training"));
        }
    };
    const list = jobs.data ?? [];
    return (
        <PanelSections>
            <TrainingChart row={row} detail={detail} versions={versions} jobs={list} />
            <RunsSection
                row={row}
                jobs={list}
                versions={versions}
                actions={
                    <>
                        <ScoreButton row={row} detail={detail} />
                        <TrainButton row={row} detail={detail} onTrain={() => setOpen(true)} />
                    </>
                }
            />
            {detail && <DataSection row={row} detail={detail} />}
            {detail && <InstructionsSection detail={detail} />}
            {detail && <JudgedSection detail={detail} />}
            <PanelSection
                icon={ThumbsUp}
                title="Feedback"
                description="Answers marked right or wrong since the last version. Accepted ones join the next run's training rows."
            >
                <FeedbackSince slug={row.key} />
            </PanelSection>
            <PanelSection
                icon={ListChecks}
                anchor="test-examples"
                title="Test examples"
                description="Conversations saved from the Playground with the answer they should get. Each joins the held-out rows of the next version's data, so that version is scored on it."
                bare
            >
                <TestExamples slug={row.key} />
            </PanelSection>
            <TrainDialog
                row={row}
                detail={detail}
                versions={versions}
                open={shown}
                onClose={close}
            />
        </PanelSections>
    );
}
