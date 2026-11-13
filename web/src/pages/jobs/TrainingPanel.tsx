import { ChartLine, TrendingDown } from "lucide-react";
import type { ReactNode } from "react";
import type { JobDetail, JobMetrics, TrainingMetrics } from "~/api/client";
import { PanelSection } from "~/components/Section";
import { StepChart, type StepRow, type StepSeries } from "~/components/charts/StepChart";
import { ChartLegend } from "~/components/charts/TimeChart";
import { count } from "~/lib/format";
import { durationText } from "~/lib/jobs";
import { bytes } from "~/lib/time";

const TRAIN = "var(--primary)";
const HELD_OUT = "var(--file-sql)";
const PREVIOUS = "var(--faint)";
const LR_HEIGHT = 160;
const LOSS = (value: number) => value.toFixed(3);
const LOSS_AXIS = (value: number) => value.toFixed(2);
const RATE = (value: number) => value.toExponential(1);
const LEGEND = ["loss", "eval_loss", "previous"];

type Previous = NonNullable<JobMetrics["previous"]>;
type Fact = [string, ReactNode];

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

function domainOf(training: TrainingMetrics, rows: StepRow[]): [number, number] {
    const last = rows.at(-1)?.step ?? 0;
    return [0, Math.max(training.steps ?? last, last)];
}

function lossText(value: number | null): string {
    return value === null ? "–" : LOSS(value);
}

function Figure({ children }: { children: ReactNode }) {
    return <span className="tabular-nums">{children}</span>;
}

export function trainingFacts(
    job: JobDetail,
    training: TrainingMetrics | null | undefined,
): Fact[] {
    if (!training || training.points.length === 0) {
        return [];
    }
    const running = job.status === "running";
    const facts: Fact[] = [["Step", <Figure key="step">{stepText(training)}</Figure>]];
    if (training.epoch !== null && training.epoch !== undefined) {
        facts.push(["Epoch", <Figure key="epoch">{training.epoch.toFixed(2)}</Figure>]);
    }
    if (running) {
        const eta = training.eta_seconds;
        facts.push([
            "Time left",
            <Figure key="eta">
                {eta === null || eta === undefined ? "–" : durationText(eta)}
            </Figure>,
        ]);
    }
    facts.push(
        [
            "Training loss",
            <Figure key="loss">
                {lossText(latest(training.points.map((point) => point.loss)))}
            </Figure>,
        ],
        [
            "Held-out loss",
            <Figure key="held">
                {lossText(latest(training.evals.map((point) => point.eval_loss)))}
            </Figure>,
        ],
        [
            running ? "Tokens per second" : "Mean tokens per second",
            <Figure key="speed">{count(training.tokens_per_second)}</Figure>,
        ],
        ["Peak memory", <Figure key="memory">{bytes(training.memory_bytes)}</Figure>],
    );
    return facts;
}

function OverfitHint({ step }: { step: number }) {
    return (
        <div className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2">
            {`Held-out loss has risen since step ${count(step)} while training loss kept falling: the model is starting to memorise its training rows. Fewer epochs or more varied data usually help.`}
        </div>
    );
}

function waiting(job: JobDetail): string {
    return job.status === "queued" || job.status === "running"
        ? "Waiting for the first training step."
        : "This run recorded no training steps.";
}

export function LossSection({ job, metrics }: { job: JobDetail; metrics: JobMetrics | undefined }) {
    const training = metrics?.training;
    const previous = metrics?.previous;
    const recorded = training && training.points.length > 0;
    return (
        <PanelSection
            icon={ChartLine}
            title="Loss"
            tip={
                previous && previous.points.length > 0
                    ? "Training and held-out loss per step, with the previous run behind them."
                    : "Training loss per step, held-out loss at each evaluation."
            }
        >
            {recorded ? (
                <LossChart job={job} training={training} previous={previous} />
            ) : (
                <p className="text-muted-foreground">{waiting(job)}</p>
            )}
        </PanelSection>
    );
}

function LossChart({
    job,
    training,
    previous,
}: { job: JobDetail; training: TrainingMetrics; previous: Previous | null | undefined }) {
    const series = lossSeries(training, previous);
    const rows = lossRows(training, previous);
    return (
        <div className="flex flex-col gap-3">
            {training.rising_from !== null && training.rising_from !== undefined && (
                <OverfitHint step={training.rising_from} />
            )}
            <ChartLegend series={legendOrder(series)} />
            <StepChart
                rows={rows}
                series={series}
                format={LOSS}
                axisFormat={LOSS_AXIS}
                label={`Loss by step for job ${job.id}: training loss ${lossText(latest(rows.map((row) => row.loss)))} at step ${training.step ?? 0}`}
                marker={training.rising_from}
                domain={domainOf(training, rows)}
            />
        </div>
    );
}

export function RateSection({ metrics }: { metrics: JobMetrics | undefined }) {
    const training = metrics?.training;
    if (!training || !training.points.some((point) => typeof point.learning_rate === "number")) {
        return null;
    }
    const rows = rateRows(training);
    const peak = Math.max(...rows.map((row) => row.rate ?? 0));
    return (
        <PanelSection
            icon={TrendingDown}
            title="Learning rate"
            tip="How far each step moves the weights: it warms up, then decays."
        >
            <StepChart
                rows={rows}
                series={[{ key: "rate", label: "Learning rate", color: TRAIN }]}
                format={RATE}
                label="Learning rate by step"
                height={LR_HEIGHT}
                domain={domainOf(training, rows)}
                yDomain={[0, peak]}
            />
        </PanelSection>
    );
}
