import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "obp-ui";
import type { ComponentType } from "react";
import type { VersionInfo } from "~/api/client";
import { percent } from "~/lib/format";
import { metricName } from "~/lib/metrics";

type Split = NonNullable<VersionInfo["held_out"]>;
type Decision = NonNullable<VersionInfo["promotion"]>;

const MATRIX_LABELS = 10;
const NOT_A_LABEL = "Not a label";

export function GraderScores({ split, main }: { split: Split; main: string | null | undefined }) {
    const others = split.scores.filter((item) => item.metric !== main);
    if (others.length === 0) {
        return null;
    }
    return (
        <div className="flex flex-wrap gap-x-8 gap-y-2">
            {others.map((item) => (
                <div key={`${item.grader}:${item.metric}`} className="min-w-24">
                    <div className="text-sm text-muted-foreground">{metricName(item.metric)}</div>
                    <div className="text-base font-semibold tabular-nums">
                        {item.metric === "macro_f1" ? item.value.toFixed(3) : percent(item.value)}
                    </div>
                </div>
            ))}
        </div>
    );
}

export function ScoredBy({ version }: { version: VersionInfo }) {
    const graders = [
        ...new Set(
            (version.held_out?.scores ?? []).map((item) => `${item.grader} v${item.version}`),
        ),
    ];
    if (graders.length === 0) {
        return null;
    }
    return <p className="text-sm text-muted-foreground">{`Scored by ${graders.join(", ")}`}</p>;
}

export function PromotionDecision({ decision }: { decision: Decision }) {
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold">Promotion rule</h3>
                <Badge variant={decision.passed ? "success" : "warning"}>
                    {decision.passed ? "Passes" : "Does not pass"}
                </Badge>
            </div>
            {decision.checks.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    The rule has no thresholds, so any ready version can go live.
                </p>
            ) : (
                <ul className="flex flex-col gap-1">
                    {decision.checks.map((check) => (
                        <li
                            key={check.name}
                            className="flex flex-wrap items-baseline gap-2 text-sm"
                        >
                            <Badge variant={check.passed ? "success" : "destructive"}>
                                {check.passed ? "Met" : "Not met"}
                            </Badge>
                            <span className="font-mono">{check.name}</span>
                            <span className="text-muted-foreground">{check.detail}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function confusionCount(split: Split, gold: string, predicted: string | null): number {
    if (gold === predicted) {
        return split.labels?.find((item) => item.label === gold)?.correct ?? 0;
    }
    return (
        split.confusion?.find((item) => item.gold === gold && item.predicted === predicted)
            ?.count ?? 0
    );
}

function ConfusionMatrix({ split }: { split: Split }) {
    const labels = (split.labels ?? []).map((item) => item.label);
    const invalid = (split.confusion ?? []).some((item) => item.predicted === null);
    const columns: (string | null)[] = invalid ? [...labels, null] : labels;
    return (
        <div className="overflow-x-auto rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Expected</TableHead>
                        {columns.map((label) => (
                            <TableHead key={label ?? NOT_A_LABEL} className="text-right">
                                {label ?? NOT_A_LABEL}
                            </TableHead>
                        ))}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {labels.map((gold) => (
                        <TableRow key={gold}>
                            <TableCell className="font-mono">{gold}</TableCell>
                            {columns.map((predicted) => {
                                const value = confusionCount(split, gold, predicted);
                                const right = gold === predicted;
                                return (
                                    <TableCell
                                        key={predicted ?? NOT_A_LABEL}
                                        className={`text-right ${value === 0 ? "text-faint" : right ? "text-success" : "text-destructive"}`}
                                    >
                                        {value}
                                    </TableCell>
                                );
                            })}
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

function ConfusionList({ split }: { split: Split }) {
    const items = (split.confusion ?? []).slice(0, 20);
    if (items.length === 0) {
        return (
            <p className="text-sm text-muted-foreground">
                No held-out row went to the wrong label.
            </p>
        );
    }
    return (
        <div className="overflow-x-auto rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Expected</TableHead>
                        <TableHead>Answered</TableHead>
                        <TableHead className="text-right">Rows</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {items.map((item) => (
                        <TableRow key={`${item.gold}→${item.predicted ?? ""}`}>
                            <TableCell className="font-mono">{item.gold}</TableCell>
                            <TableCell className="font-mono">
                                {item.predicted ?? NOT_A_LABEL}
                            </TableCell>
                            <TableCell className="text-right">{item.count}</TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

function LabelCounts({ split }: { split: Split }) {
    return (
        <div className="overflow-x-auto rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Label</TableHead>
                        <TableHead className="text-right">Rows</TableHead>
                        <TableHead className="text-right">Answered</TableHead>
                        <TableHead className="text-right">Right</TableHead>
                        <TableHead className="text-right">Precision</TableHead>
                        <TableHead className="text-right">Recall</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {(split.labels ?? []).map((item) => (
                        <TableRow key={item.label}>
                            <TableCell className="font-mono">{item.label}</TableCell>
                            <TableCell className="text-right">{item.support}</TableCell>
                            <TableCell className="text-right">{item.predicted}</TableCell>
                            <TableCell className="text-right">{item.correct}</TableCell>
                            <TableCell className="text-right">{percent(item.precision)}</TableCell>
                            <TableCell className="text-right">{percent(item.recall)}</TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

function ClassifyResults({ version }: { version: VersionInfo }) {
    const split = version.held_out;
    if (!split || (split.labels ?? []).length === 0) {
        return null;
    }
    return (
        <div className="flex min-w-0 flex-col gap-4">
            <div className="flex min-w-0 flex-col gap-2">
                <div>
                    <h3 className="text-base font-semibold">Labels</h3>
                    <p className="text-sm text-muted-foreground">
                        Held-out rows per label and how many it got right.
                    </p>
                </div>
                <LabelCounts split={split} />
            </div>
            <div className="flex min-w-0 flex-col gap-2">
                <div>
                    <h3 className="text-base font-semibold">Confusion</h3>
                    <p className="text-sm text-muted-foreground">
                        Which label it answered for each expected one.
                    </p>
                </div>
                {(split.labels ?? []).length <= MATRIX_LABELS ? (
                    <ConfusionMatrix split={split} />
                ) : (
                    <ConfusionList split={split} />
                )}
            </div>
        </div>
    );
}

const VIEWS: Record<string, ComponentType<{ version: VersionInfo }>> = {
    classify: ClassifyResults,
};

export function PresetResults({ version }: { version: VersionInfo }) {
    const View = version.view ? VIEWS[version.view] : undefined;
    return View ? <View version={version} /> : null;
}
