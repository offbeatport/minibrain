import { ChartLine } from "lucide-react";
import type { ModelDetail, ModelRow, VersionInfo } from "~/api/client";
import { PanelSection } from "~/components/Section";
import { LineChart, type LineMarker, SERIES_COLORS } from "~/components/charts/LineChart";
import { percent } from "~/lib/format";
import { metricName } from "~/lib/metrics";
import { isDeployed } from "../header";
import { liveOf, versionLabel } from "../makeLive";

const HEIGHT = 240;
const SCORE = "score";
const RULE_OPS = new Set([">=", ">"]);

export function scoredVersions(versions: VersionInfo[]): VersionInfo[] {
    return versions
        .filter((version) => version.status === "ready" && version.score !== null)
        .sort((left, right) => left.number - right.number);
}

function axisPercent(value: number): string {
    return `${Math.round(value)}%`;
}

function readPercent(value: number): string {
    return `${value.toFixed(1)}%`;
}

function ruleLevel(detail: ModelDetail | undefined, metric: string | null): LineMarker | null {
    const threshold = detail?.promotion.thresholds?.find(
        (item) => item.metric === metric && RULE_OPS.has(item.op),
    );
    return threshold
        ? { at: threshold.value * 100, label: `Promotion rule ${percent(threshold.value)}` }
        : null;
}

function lowerBound(values: number[]): number {
    const lowest = Math.min(...values);
    return Math.max(0, Math.floor((lowest - 5) / 10) * 10);
}

function ruleText(version: VersionInfo): { text: string; tone: string } | null {
    if (!version.promotion) {
        return null;
    }
    return version.promotion.passed
        ? { text: "passes the rule", tone: "text-success" }
        : { text: "below the rule", tone: "text-destructive" };
}

function Headline({
    latest,
    deployed,
    scoring,
}: {
    latest: VersionInfo | undefined;
    deployed: VersionInfo | undefined;
    scoring: VersionInfo | undefined;
}) {
    if (!latest) {
        return (
            <p className="text-muted-foreground">
                {scoring ? `v${scoring.number} is being scored` : "Nothing scored"}
            </p>
        );
    }
    const rule = ruleText(latest);
    const parts = [
        <span key="latest" className="font-medium text-foreground">
            {`v${latest.number} · ${percent(latest.score)}`}
        </span>,
        rule && (
            <span key="rule" className={rule.tone}>
                {rule.text}
            </span>
        ),
        deployed?.number === latest.number ? (
            <span key="deployed">deployed</span>
        ) : deployed ? (
            <span key="deployed">{`deployed v${deployed.number} · ${percent(deployed.score)}`}</span>
        ) : (
            <span key="deployed">not deployed</span>
        ),
    ].filter(Boolean);
    return (
        <p className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground tabular-nums">
            {parts.map((part, index) => (
                <span key={part ? String(part.key) : index} className="flex items-baseline gap-2">
                    {index > 0 && <span aria-hidden="true">·</span>}
                    {part}
                </span>
            ))}
        </p>
    );
}

export function ScoresPanel({
    row,
    detail,
    versions,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    versions: VersionInfo[];
}) {
    const scored = scoredVersions(versions);
    const latest = scored.at(-1);
    const deployed = isDeployed(row) ? liveOf(versions) : undefined;
    const metric = latest?.main_metric ?? null;
    const byNumber = new Map(scored.map((version) => [version.number, version]));
    const rows = scored.map((version) => ({
        step: version.number,
        [SCORE]: (version.score ?? 0) * 100,
    }));
    const level = ruleLevel(detail, metric);
    const empty = rows.length === 0;
    const first = scored[0]?.number ?? 0;
    const last = latest?.number ?? 0;
    const values = [...rows.map((item) => item[SCORE]), ...(level ? [level.at] : [])];
    const deployedScored = deployed && byNumber.has(deployed.number) ? deployed : undefined;
    return (
        <PanelSection
            icon={ChartLine}
            anchor="scores"
            title="Scores"
            tip={`${metricName(metric)} of each ready version on the held-out rows it never trained on.`}
        >
            <div className="flex flex-col gap-3">
                <Headline
                    latest={latest}
                    deployed={deployed}
                    scoring={versions.find((version) => version.status === "evaluating")}
                />
                <LineChart
                    rows={rows}
                    series={[
                        {
                            key: SCORE,
                            label: metricName(metric),
                            color: SERIES_COLORS[0],
                            dots: true,
                        },
                    ]}
                    format={readPercent}
                    axisFormat={axisPercent}
                    label={`${metricName(metric)} by version for ${row.name}`}
                    height={HEIGHT}
                    legend={false}
                    domain={first === last ? [first - 1, last + 1] : [first, last]}
                    yDomain={empty ? [0, 100] : [lowerBound(values), 100]}
                    xFormat={(value) => (byNumber.has(value) ? `v${value}` : "")}
                    readoutTitle={(value) => {
                        const version = byNumber.get(value);
                        return version ? versionLabel(version) : `v${value}`;
                    }}
                    readoutNotes={(value) => {
                        const version = byNumber.get(value);
                        const rule = version ? ruleText(version) : null;
                        return [
                            ...(rule
                                ? [`${rule.text.charAt(0).toUpperCase()}${rule.text.slice(1)}`]
                                : []),
                            ...(deployed?.number === value ? ["Deployed"] : []),
                        ];
                    }}
                    markers={
                        deployedScored
                            ? [{ at: deployedScored.number, label: "Deployed" }]
                            : undefined
                    }
                    levels={level && !empty ? [level] : undefined}
                    empty={empty ? { title: "No scores yet" } : null}
                />
            </div>
        </PanelSection>
    );
}
