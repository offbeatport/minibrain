import type { JobDetail, JobMetrics, TrainingMetrics } from "~/api/client";
import { Section, Stat } from "~/components/Section";
import { StepChart, type StepRow, type StepSeries } from "~/components/charts/StepChart";
import { ChartLegend } from "~/components/charts/TimeChart";
import { count } from "~/lib/format";
import { durationText } from "~/lib/jobs";
import { bytes } from "~/lib/time";

const TRAIN = "var(--primary)";
const HELD_OUT = "var(--file-sql)";
const PREVIOUS = "var(--faint)";
const LR_HEIGHT = 120;
const LOSS = (value: number) => value.toFixed(3);
const LOSS_AXIS = (value: number) => value.toFixed(2);
const RATE = (value: number) => value.toExponential(1);

type Previous = NonNullable<JobMetrics["previous"]>;

function lossRows(training: TrainingMetrics, previous: Previous | null | undefined): StepRow[] {
    const rows = new Map<number, StepRow>();
    const row = (step: number) => {
        const found = rows.get(step) ?? { step, loss: null, eval_loss: null, previous: null };
        rows.set(step, found);
        return found;
    };
    for (const point of training.points) {
        row(point.step).loss = point.loss ?? null;
    }
    for (const point of training.evals) {
        row(point.step).eval_loss = point.eval_loss;
    }
    for (const point of previous?.points ?? []) {
        row(point.step).previous = point.loss ?? null;
    }
    return [...rows.values()].sort((left, right) => left.step - right.step);
}

function rateRows(training: TrainingMetrics): StepRow[] {
    return training.points.map((point) => ({
        step: point.step,
        rate: point.learning_rate ?? null,
    }));
}

function lossSeries(
    training: TrainingMetrics,
    previous: Previous | null | undefined,
): StepSeries[] {
    const series: StepSeries[] = [];
    if (previous && previous.points.length > 0) {
        const name =
            previous.version === null || previous.version === undefined
                ? "Last run"
                : `v${previous.version}`;
        series.push({ key: "previous", label: `${name} training loss`, color: PREVIOUS });
    }
    series.push({ key: "loss", label: "Training loss", color: TRAIN });
    if (training.evals.length > 0) {
        series.push({ key: "eval_loss", label: "Held-out loss", color: HELD_OUT, dots: true });
    }
    return series;
}

const LEGEND = ["loss", "eval_loss", "previous"];

function legendOrder(series: StepSeries[]): StepSeries[] {
    return [...series].sort((left, right) => LEGEND.indexOf(left.key) - LEGEND.indexOf(right.key));
}

function latest(values: (number | null | undefined)[]): number | null {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const value = values[index];
        if (typeof value === "number") {
            return value;
        }
    }
    return null;
}

function stepText(training: TrainingMetrics): string {
    if (training.step === null || training.step === undefined) {
        return "–";
    }
    return training.steps
        ? `${count(training.step)} of ${count(training.steps)}`
        : count(training.step);
}

function OverfitHint({ step }: { step: number }) {
    return (
        <div className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm">
            {`Held-out loss has risen since step ${count(step)} while training loss kept falling: the model is starting to memorise its training rows. Fewer epochs or more varied data usually help.`}
        </div>
    );
}

function TrainingStats({ job, training }: { job: JobDetail; training: TrainingMetrics }) {
    const running = job.status === "running";
    const trainLoss = latest(training.points.map((point) => point.loss));
    const heldOut = latest(training.evals.map((point) => point.eval_loss));
    return (
        <div className="flex flex-wrap gap-x-8 gap-y-3">
            <Stat label="Step" value={stepText(training)} />
            {training.epoch !== null && training.epoch !== undefined && (
                <Stat label="Epoch" value={training.epoch.toFixed(2)} />
            )}
            {running && (
                <Stat
                    label="Time left"
                    value={
                        training.eta_seconds === null || training.eta_seconds === undefined
                            ? "–"
                            : durationText(training.eta_seconds)
                    }
                />
            )}
            <Stat label="Training loss" value={trainLoss === null ? "–" : LOSS(trainLoss)} />
            <Stat label="Held-out loss" value={heldOut === null ? "–" : LOSS(heldOut)} />
            <Stat
                label={running ? "Tokens per second" : "Mean tokens per second"}
                value={count(training.tokens_per_second)}
            />
            <Stat label="Peak memory" value={bytes(training.memory_bytes)} />
        </div>
    );
}

export function TrainingPanel({
    job,
    metrics,
}: { job: JobDetail; metrics: JobMetrics | undefined }) {
    const training = metrics?.training;
    if (!training || training.points.length === 0) {
        return (
            <Section title="Training">
                <p className="text-sm text-muted-foreground">
                    {job.status === "queued" || job.status === "running"
                        ? "Waiting for the first training step."
                        : "This run recorded no training steps."}
                </p>
            </Section>
        );
    }
    const series = lossSeries(training, metrics?.previous);
    const rows = lossRows(training, metrics?.previous);
    const steps = training.steps ?? rows.at(-1)?.step ?? 0;
    const domain: [number, number] = [0, Math.max(steps, rows.at(-1)?.step ?? 0)];
    return (
        <Section title="Training" caption="Loss per step, with held-out loss at each evaluation.">
            <div className="flex flex-col gap-6">
                <TrainingStats job={job} training={training} />
                {training.rising_from !== null && training.rising_from !== undefined && (
                    <OverfitHint step={training.rising_from} />
                )}
                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <h3 className="text-base font-semibold">Loss</h3>
                        <ChartLegend series={legendOrder(series)} />
                    </div>
                    <StepChart
                        rows={rows}
                        series={series}
                        format={LOSS}
                        axisFormat={LOSS_AXIS}
                        label={`Loss by step: training loss ${LOSS(latest(rows.map((row) => row.loss)) ?? 0)} at step ${training.step ?? 0}`}
                        marker={training.rising_from}
                        domain={domain}
                    />
                </div>
                <div className="flex flex-col gap-2">
                    <h3 className="text-base font-semibold">Learning rate</h3>
                    <StepChart
                        rows={rateRows(training)}
                        series={[{ key: "rate", label: "Learning rate", color: TRAIN }]}
                        format={RATE}
                        label="Learning rate by step"
                        height={LR_HEIGHT}
                        domain={domain}
                    />
                </div>
            </div>
        </Section>
    );
}
