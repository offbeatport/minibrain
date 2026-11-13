import { useRouter } from "@tanstack/react-router";
import {
    Button,
    type CompareRow,
    CompareTable,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { useState } from "react";
import type { ModelRow, VersionInfo } from "~/api/client";
import { useAllModels, useVersions } from "~/api/queries";
import { ErrorLine, Page, Section } from "~/components/Section";
import { useCan } from "~/lib/access";
import { count, percent } from "~/lib/format";
import { useSearchParam } from "~/lib/listSearch";
import { metricName } from "~/lib/metrics";
import { modelCompareHref, versionPlaygroundHref } from "~/lib/modelLinks";
import { datasetVersionDiffHref } from "../../data/versionData";
import { CompactHeader, Crumbs, baseNameOf, isDeployed, modelCrumbs } from "./header";
import {
    DeployVersionDialog,
    canGoLive,
    liveBlock,
    liveOf,
    points,
    versionLabel,
} from "./makeLive";
import { ExampleList, useAnswers, verdictOf } from "./version";
import { recipeText } from "./versions";

function columnName(row: ModelRow, versions: VersionInfo[], version: VersionInfo): string {
    const live = isDeployed(row) ? liveOf(versions) : undefined;
    return live?.number === version.number ? `v${version.number} · live` : versionLabel(version);
}

function scoreRows(a: VersionInfo, b: VersionInfo): CompareRow[] {
    const metrics = [
        ...new Set(
            [...(a.held_out?.scores ?? []), ...(b.held_out?.scores ?? [])].map(
                (item) => item.metric,
            ),
        ),
    ];
    const scoreOf = (version: VersionInfo, metric: string) =>
        version.held_out?.scores.find((item) => item.metric === metric)?.value ?? null;
    const rows: CompareRow[] = metrics.map((metric) => {
        const values = [scoreOf(a, metric), scoreOf(b, metric)];
        return {
            id: `metric-${metric}`,
            label: metricName(metric),
            cells: values.map((value, at) => (
                <span key={at === 0 ? "a" : "b"} className="tabular-nums">
                    {percent(value)}
                </span>
            )),
            values,
            differs: values[0] !== values[1],
            formatDelta: (amount) => `${(amount * 100).toFixed(1)} pts`,
            better: "higher",
        };
    });
    const latency = (key: "latency_p50_ms" | "latency_p95_ms", label: string): CompareRow => {
        const values = [a[key], b[key]].map((value) => (value === null ? null : Math.round(value)));
        return {
            id: key,
            label,
            cells: values.map((value, at) => (
                <span key={at === 0 ? "a" : "b"} className="tabular-nums">
                    {value === null ? "–" : `${count(value)} ms`}
                </span>
            )),
            values,
            differs: values[0] !== values[1],
            formatDelta: (amount) => `${count(amount)} ms`,
            better: "lower",
        };
    };
    return [
        ...rows,
        latency("latency_p50_ms", "Latency p50"),
        latency("latency_p95_ms", "Latency p95"),
    ];
}

function textRows(id: string, rows: { label: string; values: [string, string] }[]): CompareRow[] {
    return rows.map((item) => ({
        id: `${id}-${item.label}`,
        label: item.label,
        cells: item.values,
        values: item.values,
        differs: item.values[0] !== item.values[1],
    }));
}

function recipeValue(
    version: VersionInfo,
    key: string,
    format: (value: unknown) => string = String,
): string {
    const recipe = version.recipe as Record<string, unknown>;
    return version.kind === "prompt" || recipe[key] === undefined || recipe[key] === null
        ? "–"
        : format(recipe[key]);
}

function settingRows(a: VersionInfo, b: VersionInfo, base: (key: string) => string): CompareRow[] {
    const pair = (key: string, format?: (value: unknown) => string): [string, string] => [
        recipeValue(a, key, format),
        recipeValue(b, key, format),
    ];
    return textRows("settings", [
        {
            label: "Kind",
            values: [
                a.kind === "prompt" ? "Prompt only" : "Trained",
                b.kind === "prompt" ? "Prompt only" : "Trained",
            ],
        },
        {
            label: "Adapter",
            values: pair("strategy", (value) => (value === "qlora" ? "QLoRA" : "LoRA")),
        },
        { label: "LoRA rank", values: pair("rank") },
        { label: "Epochs", values: pair("epochs") },
        { label: "Learning rate", values: pair("learning_rate") },
        { label: "Rows at most", values: pair("max_rows", (value) => count(Number(value))) },
        { label: "Batch", values: pair("micro_batch") },
        { label: "Sequence length", values: pair("seq_len", (value) => count(Number(value))) },
        { label: "Base", values: [base(a.base_model || ""), base(b.base_model || "")] },
    ]);
}

function dataRows(a: VersionInfo, b: VersionInfo): CompareRow[] {
    const name = (version: VersionInfo) =>
        version.dataset_version_number === null || version.dataset_version_number === undefined
            ? "–"
            : `${version.dataset_slug ?? "data"} v${version.dataset_version_number}`;
    return textRows("data", [
        { label: "Data version", values: [name(a), name(b)] },
        {
            label: "Rows",
            values: [count(a.dataset_version_rows ?? 0), count(b.dataset_version_rows ?? 0)],
        },
    ]);
}

function VersionPick({
    label,
    row,
    versions,
    value,
    other,
    onPick,
}: {
    label: string;
    row: ModelRow;
    versions: VersionInfo[];
    value: number;
    other: number;
    onPick: (number: number) => void;
}) {
    const choices = [...versions]
        .filter((version) => version.score !== null && version.number !== other)
        .sort((x, y) => y.number - x.number);
    return (
        <Select value={String(value)} onValueChange={(next) => onPick(Number(next))}>
            <SelectTrigger aria-label={label} className="w-auto min-w-36">
                <span className="text-muted-foreground">{label}</span>
                <SelectValue className="flex-1 text-left" />
            </SelectTrigger>
            <SelectContent>
                {choices.map((version) => (
                    <SelectItem key={version.number} value={String(version.number)}>
                        {columnName(row, versions, version)}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function target(
    row: ModelRow,
    versions: VersionInfo[],
    a: VersionInfo,
    b: VersionInfo,
): VersionInfo {
    const live = isDeployed(row) ? liveOf(versions)?.number : undefined;
    return live === b.number ? a : b;
}

function Answers({ row, a, b }: { row: ModelRow; a: VersionInfo; b: VersionInfo }) {
    const can = useCan();
    const answers = useAnswers(
        row.key,
        b.number,
        a.number,
        can.build && b.status === "ready" && a.status === "ready",
    );
    if (!can.build) {
        return null;
    }
    const all = answers.data?.examples ?? [];
    const metric = answers.data?.metric;
    const differing = all.filter((answer) => verdictOf(answer, metric) !== "same");
    const fixes = differing.filter((answer) => verdictOf(answer, metric) === "better").length;
    return (
        <Section
            title="Answers that differ"
            caption={
                answers.data
                    ? `${count(differing.length)} of ${count(all.length)} held-out rows: v${b.number} fixes ${count(fixes)} and breaks ${count(differing.length - fixes)}.`
                    : "Held-out answers of both versions, row by row."
            }
        >
            <ErrorLine error={answers.error} />
            {answers.isLoading ? (
                <p className="text-muted-foreground">Comparing answers…</p>
            ) : differing.length === 0 ? (
                <p className="text-muted-foreground">
                    Both versions score every held-out row the same.
                </p>
            ) : (
                <ExampleList
                    rows={differing}
                    mine={`v${b.number}`}
                    theirs={`v${a.number}`}
                    metric={metric}
                />
            )}
        </Section>
    );
}

function DataDiff({ a, b }: { a: VersionInfo; b: VersionInfo }) {
    const same = a.dataset_version_id === b.dataset_version_id;
    const href = same ? null : datasetVersionDiffHref(a, b);
    return (
        <Section
            title="Data diff"
            caption={
                same
                    ? `Both trained on data v${a.dataset_version_number ?? "–"}.`
                    : `Data v${a.dataset_version_number ?? "–"} to v${b.dataset_version_number ?? "–"}: ${count(b.dataset_version_rows ?? 0)} rows against ${count(a.dataset_version_rows ?? 0)}.`
            }
        >
            {same ? (
                <p className="text-muted-foreground">No rows changed.</p>
            ) : href ? (
                <Link href={href} className="text-primary hover:underline">
                    Rows added, removed and relabelled →
                </Link>
            ) : (
                <p className="text-muted-foreground">One of them has no saved data version.</p>
            )}
        </Section>
    );
}

export function CompareView({ row }: { row: ModelRow }) {
    const router = useRouter();
    const can = useCan();
    const versions = useVersions(row.key);
    const models = useAllModels();
    const [promoting, setPromoting] = useState<number | null>(null);
    const first = Number(useSearchParam("a"));
    const second = Number(useSearchParam("b"));
    const list = versions.data ?? [];
    const a = list.find((item) => item.number === first);
    const b = list.find((item) => item.number === second);
    const crumbs = modelCrumbs(row, [
        { label: a && b ? `Compare v${a.number} and v${b.number}` : "Compare" },
    ]);
    if (!a || !b) {
        return (
            <Page wide>
                <Crumbs items={crumbs} />
                <ErrorLine error={versions.error} />
                {versions.data && (
                    <p className="text-muted-foreground">Pick two versions of this model.</p>
                )}
            </Page>
        );
    }
    const pick = (next: { a?: number; b?: number }) =>
        router.history.replace(modelCompareHref(row.key, next.a ?? a.number, next.b ?? b.number));
    const delta = a.score !== null && b.score !== null ? b.score - a.score : null;
    const goal = target(row, list, a, b);
    const liveable = can.build && canGoLive(row, goal) && !liveBlock(row, goal);
    return (
        <Page wide>
            <Crumbs items={crumbs} />
            <CompactHeader
                title={`v${a.number} and v${b.number}`}
                subtitle={
                    delta === null
                        ? row.name
                        : `${row.name} · v${b.number} is ${points(delta)} points on ${metricName(b.main_metric).toLowerCase()} against v${a.number}.`
                }
                actions={
                    <>
                        <VersionPick
                            label="From"
                            row={row}
                            versions={list}
                            value={a.number}
                            other={b.number}
                            onPick={(n) => pick({ a: n })}
                        />
                        <VersionPick
                            label="To"
                            row={row}
                            versions={list}
                            value={b.number}
                            other={a.number}
                            onPick={(n) => pick({ b: n })}
                        />
                        {goal.status === "ready" && (
                            <Button variant="outline" asChild>
                                <Link
                                    href={versionPlaygroundHref(row.key, goal.number)}
                                >{`Try ${row.key}@${goal.number}`}</Link>
                            </Button>
                        )}
                        {liveable && (
                            <Button
                                onClick={() => setPromoting(goal.number)}
                            >{`Deploy v${goal.number}`}</Button>
                        )}
                    </>
                }
            />
            <CompareTable
                label={`v${a.number} against v${b.number}`}
                columns={[
                    { id: "a", header: columnName(row, list, a), label: `v${a.number}` },
                    { id: "b", header: columnName(row, list, b), label: `v${b.number}` },
                ]}
                sections={[
                    {
                        id: "scores",
                        title: `Scores on ${count(b.held_out?.examples ?? a.held_out?.examples ?? 0)} held-out rows`,
                        rows: scoreRows(a, b),
                    },
                    { id: "data", title: "Data", rows: dataRows(a, b) },
                    {
                        id: "settings",
                        title: "Settings",
                        rows: settingRows(a, b, (key) => baseNameOf(models.data, key) || "–"),
                    },
                    {
                        id: "made",
                        title: "Made",
                        rows: textRows("made", [
                            { label: "Recipe", values: [recipeText(a), recipeText(b)] },
                        ]),
                    },
                ]}
                baseline="a"
                labelWidth="14rem"
                columnWidth="16rem"
            />
            <Answers row={row} a={a} b={b} />
            <DataDiff a={a} b={b} />
            <DeployVersionDialog
                row={row}
                versions={list}
                number={promoting}
                onOpenChange={(open) => !open && setPromoting(null)}
            />
        </Page>
    );
}
