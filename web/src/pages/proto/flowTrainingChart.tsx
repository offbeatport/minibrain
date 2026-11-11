import { SegmentedTabs } from "obp-ui";
import { useState } from "react";
import { StepChart, type StepRow, type StepSeries } from "~/components/charts/StepChart";
import { ChartLegend } from "~/components/charts/TimeChart";
import {
    type FlowModel,
    type FlowVersion,
    LOSS_STEPS,
    createdAt,
    lossCurve,
    newestFirst,
    pct,
    trainingVersion,
    versionName,
} from "./modelsFlowData";

type View = "scores" | "loss";

const VIEWS: { key: View; label: string }[] = [
    { key: "scores", label: "Score by version" },
    { key: "loss", label: "Loss curves" },
];

const SLOTS = [
    "var(--flow-series-1)",
    "var(--flow-series-2)",
    "var(--flow-series-3)",
    "var(--flow-series-4)",
];

const DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const DATE_TIME = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
});

function finishedAt(version: FlowVersion): number {
    return Date.parse(createdAt(version));
}

function EmptyOverlay({ text }: { text: string }) {
    return (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center pb-6 pl-14">
            <p className="bg-card px-2 font-medium">{text}</p>
        </div>
    );
}

function niceDomain(values: number[]): [number, number] {
    const floor = Math.floor((Math.min(...values) - 0.01) / 0.05) * 0.05;
    const span = (Math.max(...values) + 0.01 - floor) / 4;
    const step = [0.025, 0.05, 0.1, 0.25].find((item) => item >= span) ?? 0.25;
    const low = Math.max(0, Math.min(floor, 1 - step * 4));
    return [low, low + step * 4];
}

function ScoreChart({ model }: { model: FlowModel }) {
    const scored = model.versions
        .filter((version) => version.status === "ready" && version.scores)
        .sort((a, b) => finishedAt(a) - finishedAt(b));
    const failed = model.versions.filter((version) => version.status === "failed");
    const training = trainingVersion(model);
    const byStep = new Map(scored.map((version) => [finishedAt(version), version]));
    const rows: StepRow[] = scored.map((version) => ({
        step: finishedAt(version),
        score: version.scores?.[0] ?? null,
    }));
    const now = Date.now();
    const values = scored.map((version) => version.scores?.[0] ?? 0);
    const domain = niceDomain([...values, model.rule[0]]);
    const live = scored.find((version) => version.number === model.live);
    const series: StepSeries[] = [
        { key: "score", label: model.metrics[0], color: SLOTS[0], dots: true },
    ];
    const notes = [
        failed.length > 0
            ? `${failed.map((version) => `v${version.number}`).join(", ")} failed and ${failed.length === 1 ? "has" : "have"} no score`
            : null,
        training ? `v${training.number} is training` : null,
    ].filter(Boolean);
    return (
        <>
            <p className="text-sm text-muted-foreground">
                {`${model.metrics[0]} on the held-out set, by the date each version finished. Dashed: the promotion rule.${notes.length > 0 ? ` ${notes.join("; ")}.` : ""}`}
            </p>
            <div className="relative">
                <StepChart
                    rows={rows.length > 0 ? rows : [{ step: now - 7 * 86400000 }, { step: now }]}
                    series={rows.length > 0 ? series : []}
                    format={(value) => pct(value)}
                    axisFormat={(value) => `${Number((value * 100).toFixed(1))}%`}
                    label={`${model.metrics[0]} by version for ${model.name}`}
                    height={220}
                    yDomain={domain}
                    levels={[
                        {
                            at: model.rule[0],
                            label: `Rule ${Math.round(model.rule[0] * 100)}%`,
                        },
                    ]}
                    markers={live ? [{ at: finishedAt(live), label: `v${live.number} live` }] : []}
                    xFormat={(value) => DATE.format(new Date(value))}
                    readoutTitle={(value) => {
                        const version = byStep.get(value);
                        return version
                            ? `${versionName(version)} · ${DATE_TIME.format(new Date(value))}`
                            : DATE_TIME.format(new Date(value));
                    }}
                />
                {rows.length === 0 && <EmptyOverlay text="No scored versions yet" />}
            </div>
        </>
    );
}

function lossOf(version: FlowVersion, until: number): Map<number, number> {
    const level = 1 + (((version.number * 13) % 7) - 3) * 0.07;
    return new Map(
        lossCurve(version.number)
            .filter((row) => row.step <= LOSS_STEPS * until && row.loss !== null)
            .map((row) => [
                Math.round((row.step / LOSS_STEPS) * 100),
                Number(((row.loss ?? 0) * level).toFixed(3)),
            ]),
    );
}

function LossChart({ model }: { model: FlowModel }) {
    const training = trainingVersion(model);
    const finished = newestFirst(model)
        .filter((version) => version.kind === "trained" && version.status === "ready")
        .slice(0, 3);
    const runs = [
        ...[...finished].reverse().map((version, index) => ({
            version,
            until: 1,
            color: SLOTS[finished.length - index],
        })),
        ...(training
            ? [{ version: training, until: training.progress ?? 0, color: SLOTS[0] }]
            : []),
    ];
    const curves = runs.map((run) => ({ ...run, points: lossOf(run.version, run.until) }));
    const steps = [...new Set(curves.flatMap((curve) => [...curve.points.keys()]))].sort(
        (a, b) => a - b,
    );
    const rows: StepRow[] = (steps.length > 0 ? steps : [0, 100]).map((step) => {
        const row: StepRow = { step };
        for (const curve of curves) {
            row[`v${curve.version.number}`] = curve.points.get(step) ?? null;
        }
        return row;
    });
    const series: (StepSeries & { color: string })[] = curves.map((curve) => {
        const running = curve.version.status === "training";
        return {
            key: `v${curve.version.number}`,
            label: running
                ? `v${curve.version.number} running`
                : curve.version.number === model.live
                  ? `v${curve.version.number} live`
                  : `v${curve.version.number}`,
            color: curve.color,
            width: running ? 3 : 1.5,
        };
    });
    return (
        <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-sm text-muted-foreground">
                    {training
                        ? `Training loss of the running job and the last ${finished.length} finished runs.`
                        : `Training loss of the last ${finished.length} finished runs.`}
                </p>
                <ChartLegend series={[...series].reverse()} />
            </div>
            <div className="relative">
                <StepChart
                    rows={rows}
                    series={series}
                    format={(value) => value.toFixed(3)}
                    axisFormat={(value) => value.toFixed(1)}
                    label={`Training loss by version for ${model.name}`}
                    height={220}
                    domain={[0, 100]}
                    yDomain={curves.length === 0 ? [0, 2.5] : undefined}
                    xFormat={(value) => `${value}%`}
                    readoutTitle={(value) => `${value}% of training`}
                />
                {curves.length === 0 && <EmptyOverlay text="No training runs yet" />}
            </div>
        </>
    );
}

export function TrainingChart({ model }: { model: FlowModel }) {
    const [view, setView] = useState<View>("scores");
    return (
        <section
            aria-label={`${model.name} training progress`}
            className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-panel"
        >
            <div className="self-start">
                <SegmentedTabs
                    tabs={VIEWS}
                    active={view}
                    onSelect={(key) => setView(key as View)}
                />
            </div>
            {view === "scores" ? <ScoreChart model={model} /> : <LossChart model={model} />}
        </section>
    );
}
