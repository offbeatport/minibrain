import {
    EmptyState,
    Link,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "obp-ui";
import { Section, Stat } from "~/components/Section";
import { ChartLegend, type ChartSeries, TimeChart } from "~/components/charts/TimeChart";
import { count } from "~/lib/format";
import { FLOW, type FlowModel, versionHref } from "./modelsFlowData";

type Slice = {
    key: string;
    label: string;
    href?: string;
    share: number;
    daily: number[];
    p95: number | null;
    errors: number;
};

const COLORS = ["var(--primary)", "var(--file-sql)", "var(--file-parquet)", "var(--file-tsv)"];
const DAY_MS = 24 * 3600 * 1000;

function scaled(values: number[], share: number): number[] {
    return values.map((value) => Math.round((value * share) / 100));
}

export function slicesOf(model: FlowModel): Slice[] {
    if (model.kind === "base") {
        const total = model.traffic.reduce((sum, value) => sum + value, 0) || 1;
        return model.variants
            .filter((item) => item.live)
            .map((item) => ({
                key: item.id,
                label: item.format,
                share: Math.round(
                    (item.traffic.reduce((sum, value) => sum + value, 0) * 100) / total,
                ),
                daily: item.traffic,
                p95: item.p95,
                errors: model.errors,
            }));
    }
    if (model.live === null || !model.deployed) {
        return [];
    }
    const slices: Slice[] = [];
    const canary = model.canary;
    const liveErrors = canary ? model.usualErrors : model.errors;
    slices.push({
        key: `v${model.live}`,
        label: `v${model.live}`,
        href: versionHref(model.slug, model.live),
        share: canary ? 100 - canary.share : 100,
        daily: scaled(model.traffic, canary ? 100 - canary.share : 100),
        p95: model.p95 || null,
        errors: liveErrors,
    });
    if (canary) {
        const share = canary.share / 100;
        slices.push({
            key: `v${canary.version}`,
            label: `v${canary.version} canary`,
            href: versionHref(model.slug, canary.version),
            share: canary.share,
            daily: scaled(model.traffic, canary.share),
            p95: model.p95 ? Math.round(model.p95 * 1.6) : null,
            errors: Math.max(0, (model.errors - model.usualErrors * (1 - share)) / share),
        });
    }
    return slices;
}

function rate(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

function rowsOf(slices: Slice[]) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, day) => {
        const row: { at: number; [key: string]: number } = {
            at: today.getTime() - (6 - day) * DAY_MS,
        };
        for (const slice of slices) {
            row[slice.key] = slice.daily[day] ?? 0;
        }
        return row;
    });
}

function Overview({ model, slices }: { model: FlowModel; slices: Slice[] }) {
    const total = slices.reduce(
        (sum, slice) => sum + slice.daily.reduce((all, value) => all + value, 0),
        0,
    );
    const errors =
        slices.reduce(
            (sum, slice) => sum + slice.errors * slice.daily.reduce((all, v) => all + v, 0),
            0,
        ) / Math.max(1, total);
    const high = errors > model.usualErrors * 3;
    const p95 = Math.max(0, ...slices.map((slice) => slice.p95 ?? 0));
    return (
        <div className="flex flex-wrap gap-x-10 gap-y-3 rounded-lg border bg-card px-panel py-4">
            <Stat label="Requests, 7 days" value={count(total)} />
            <Stat label="Latency p95" value={p95 ? `${p95} ms` : "–"} />
            <Stat
                label="Errors"
                value={
                    <span className={high ? "text-destructive" : undefined}>
                        {rate(errors)}
                        {high && (
                            <span className="font-normal text-muted-foreground">{` · usually ${rate(model.usualErrors)}`}</span>
                        )}
                    </span>
                }
            />
            <Stat label="Cost / 1k requests" value={`${model.gpuSeconds.toFixed(1)} GPU·s`} />
        </div>
    );
}

function SliceTable({ slices, noun }: { slices: Slice[]; noun: string }) {
    return (
        <div className="overflow-x-auto rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>{noun}</TableHead>
                        <TableHead className="text-right">Share</TableHead>
                        <TableHead className="text-right">Requests, 7 days</TableHead>
                        <TableHead className="text-right">p95</TableHead>
                        <TableHead className="text-right">Errors</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {slices.map((slice) => (
                        <TableRow key={slice.key}>
                            <TableCell>
                                {slice.href ? (
                                    <Link href={slice.href} className="font-medium hover:underline">
                                        {slice.label}
                                    </Link>
                                ) : (
                                    slice.label
                                )}
                            </TableCell>
                            <TableCell className="text-right">{`${slice.share}%`}</TableCell>
                            <TableCell className="text-right">
                                {count(slice.daily.reduce((sum, value) => sum + value, 0))}
                            </TableCell>
                            <TableCell className="text-right">
                                {slice.p95 ? `${slice.p95} ms` : "–"}
                            </TableCell>
                            <TableCell
                                className={
                                    slice.errors > 0.05
                                        ? "text-right text-destructive"
                                        : "text-right"
                                }
                            >
                                {rate(slice.errors)}
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

function Charts({ slices, label }: { slices: Slice[]; label: string }) {
    const series: ChartSeries[] = slices.map((slice, index) => ({
        key: slice.key,
        label: slice.label,
        color: COLORS[index % COLORS.length],
    }));
    return (
        <div className="flex flex-col gap-3">
            <ChartLegend series={series} />
            <TimeChart
                kind="stacked-bars"
                rows={rowsOf(slices)}
                series={series}
                format={(value) => count(value)}
                bucketMs={DAY_MS}
                label={label}
            />
        </div>
    );
}

export function ModelMonitoring({ model }: { model: FlowModel }) {
    const slices = slicesOf(model);
    if (slices.length === 0) {
        return (
            <EmptyState variant="panel" title="No traffic to show">
                {model.live === null
                    ? "Nothing is live yet, so its name answers nothing. Make a version live and switch it on the API."
                    : `${model.name} is off the API, so nothing calls it. Switch it on in the header.`}
            </EmptyState>
        );
    }
    const noun = model.kind === "base" ? "Format" : "Version";
    return (
        <div className="flex flex-col gap-4">
            <Overview model={model} slices={slices} />
            <Section
                title="Requests per day"
                caption={
                    model.canary
                        ? `Last 7 days. The live pointer splits traffic: v${model.live} ${100 - model.canary.share}% · v${model.canary.version} ${model.canary.share}%.`
                        : "Last 7 days, by the version that answered."
                }
                actions={
                    <Link href={`${FLOW}/monitor`} className="text-sm text-primary hover:underline">
                        All models in Monitor →
                    </Link>
                }
            >
                <Charts slices={slices} label={`Requests per day for ${model.name}`} />
            </Section>
            <Section title={`By ${noun.toLowerCase()}`}>
                <SliceTable slices={slices} noun={noun} />
            </Section>
        </div>
    );
}
