import { useParams, useRouter } from "@tanstack/react-router";
import {
    type CompareRow,
    CompareTable,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "obp-ui";
import { useState } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section } from "~/components/Section";
import { count } from "~/lib/format";
import { useSearchParam } from "~/lib/listSearch";
import { AnswersTable, DeployButton, dataRows, settingsRows, verdictOf } from "./ModelsFlowVersion";
import {
    type FlowModel,
    type FlowVersion,
    ROWS_ADDED,
    ROWS_REMOVED,
    type RowDiff,
    answersFor,
    compareHref,
    findVersion,
    flowHref,
    liveVersion,
    newestFirst,
    pct,
    points,
    useFlowModel,
} from "./modelsFlowData";
import { Crumbs, DeployDialog, type DeployIntent } from "./modelsFlowParts";

function columnName(model: FlowModel, version: FlowVersion): string {
    return liveVersion(model)?.number === version.number
        ? `v${version.number} · live`
        : `v${version.number}`;
}

function scoreRows(model: FlowModel, a: FlowVersion, b: FlowVersion): CompareRow[] {
    const rows: CompareRow[] = model.metrics.map((metric, index) => {
        const values = [a.scores?.[index] ?? null, b.scores?.[index] ?? null];
        return {
            id: `metric-${index}`,
            label: metric,
            cells: values.map((value, at) => (
                <span key={at === 0 ? "a" : "b"} className="tabular-nums">
                    {pct(value)}
                </span>
            )),
            values,
            differs: values[0] !== values[1],
            formatDelta: (amount) => `${(amount * 100).toFixed(1)} pts`,
            better: "higher",
        };
    });
    const latency = [a.p50, b.p50];
    rows.push({
        id: "p50",
        label: "Latency p50",
        cells: latency.map((value, at) => (
            <span key={at === 0 ? "a" : "b"} className="tabular-nums">
                {value === null ? "–" : `${value} ms`}
            </span>
        )),
        values: latency,
        differs: latency[0] !== latency[1],
        formatDelta: (amount) => `${amount} ms`,
        better: "lower",
    });
    return rows;
}

function textRows(
    id: string,
    rows: { label: string; before: string; after: string }[],
): CompareRow[] {
    return rows.map((row) => ({
        id: `${id}-${row.label}`,
        label: row.label,
        cells: [row.before, row.after],
        values: [row.before, row.after],
        differs: row.before !== row.after,
    }));
}

function RowList({
    title,
    rows,
    total,
    sign,
}: { title: string; rows: RowDiff[]; total: number; sign: string }) {
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <h3 className="font-semibold">
                {title}
                <span className="pl-2 font-normal text-muted-foreground tabular-nums">{`${sign}${count(total)}`}</span>
            </h3>
            <div className="overflow-x-auto rounded-md border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Text</TableHead>
                            <TableHead>Label</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => (
                            <TableRow key={row.text}>
                                <TableCell className="max-w-80 truncate" title={row.text}>
                                    {row.text}
                                </TableCell>
                                <TableCell className="font-mono text-sm">{row.label}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
            {total > rows.length && (
                <p className="text-sm text-muted-foreground tabular-nums">{`${rows.length} of ${count(total)} shown`}</p>
            )}
        </div>
    );
}

function VersionPick({
    label,
    model,
    value,
    other,
    onPick,
}: {
    label: string;
    model: FlowModel;
    value: number;
    other: number;
    onPick: (number: number) => void;
}) {
    const choices = newestFirst(model).filter(
        (version) => version.scores && version.number !== other,
    );
    return (
        <Select value={String(value)} onValueChange={(next) => onPick(Number(next))}>
            <SelectTrigger aria-label={label} className="w-auto min-w-36">
                <span className="text-muted-foreground">{label}</span>
                <SelectValue className="flex-1 text-left" />
            </SelectTrigger>
            <SelectContent>
                {choices.map((version) => (
                    <SelectItem key={version.number} value={String(version.number)}>
                        {columnName(model, version)}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function deployTarget(model: FlowModel, a: FlowVersion, b: FlowVersion): FlowVersion {
    const live = liveVersion(model)?.number;
    if (live === b.number) {
        return a;
    }
    return b;
}

export function ModelsFlowComparePage() {
    const { model: slug } = useParams({ strict: false }) as { model?: string };
    const router = useRouter();
    const model = useFlowModel(slug);
    const aParam = Number(useSearchParam("a"));
    const bParam = Number(useSearchParam("b"));
    const wantsDeploy = useSearchParam("deploy") === "1";
    const a = model ? findVersion(model, aParam) : undefined;
    const b = model ? findVersion(model, bParam) : undefined;
    const [deploy, setDeploy] = useState<DeployIntent>(
        wantsDeploy && model && a && b ? { model, version: deployTarget(model, a, b) } : null,
    );
    if (!model || !a || !b) {
        return (
            <Page>
                <Crumbs items={[{ label: "Models", href: flowHref() }, { label: "Compare" }]} />
                <p className="text-muted-foreground">Pick two versions of one model.</p>
            </Page>
        );
    }
    const pick = (next: { a?: number; b?: number }) =>
        router.history.replace(compareHref(model.slug, next.a ?? a.number, next.b ?? b.number));
    const answers = answersFor(model);
    const differing = answers.filter((answer) => verdictOf(answer, b.number, a.number) !== "same");
    const fixes = differing.filter(
        (answer) => verdictOf(answer, b.number, a.number) === "better",
    ).length;
    const breaks = differing.length - fixes;
    const delta = a.scores && b.scores ? b.scores[0] - a.scores[0] : null;
    const sameData = a.data.number === b.data.number;
    const target = deployTarget(model, a, b);
    return (
        <Page wide>
            <Crumbs
                items={[
                    { label: "Models", href: flowHref() },
                    { label: model.name, href: flowHref(model.slug) },
                    { label: `Compare v${a.number} and v${b.number}` },
                ]}
            />
            <PageHeader
                title={`v${a.number} and v${b.number}`}
                caption={
                    delta === null
                        ? model.name
                        : `${model.name} · v${b.number} is ${points(delta)} points on ${model.metrics[0].toLowerCase()} against v${a.number}.`
                }
                actions={
                    <>
                        <VersionPick
                            label="Baseline"
                            model={model}
                            value={a.number}
                            other={b.number}
                            onPick={(n) => pick({ a: n })}
                        />
                        <VersionPick
                            label="Against"
                            model={model}
                            value={b.number}
                            other={a.number}
                            onPick={(n) => pick({ b: n })}
                        />
                        <DeployButton model={model} version={target} onDeploy={setDeploy} />
                    </>
                }
            />
            <CompareTable
                label={`v${a.number} against v${b.number}`}
                columns={[
                    { id: "a", header: columnName(model, a), label: `v${a.number}` },
                    { id: "b", header: columnName(model, b), label: `v${b.number}` },
                ]}
                sections={[
                    {
                        id: "scores",
                        title: `Scores on ${count(model.heldOut)} held-out rows`,
                        rows: scoreRows(model, a, b),
                    },
                    { id: "data", title: "Data", rows: textRows("data", dataRows(a, b)) },
                    {
                        id: "settings",
                        title: "Settings",
                        rows: textRows("settings", settingsRows(a, b)),
                    },
                ]}
                baseline="a"
                labelWidth="14rem"
                columnWidth="16rem"
            />
            <Section
                title="Answers that differ"
                caption={
                    answers.length === 0
                        ? "Answers are drawn for Support triage only in this prototype."
                        : `${differing.length} of ${answers.length} drawn rows: v${b.number} fixes ${fixes} and breaks ${breaks}.`
                }
            >
                {differing.length === 0 ? (
                    <p className="text-muted-foreground">
                        Both versions answer every drawn row the same.
                    </p>
                ) : (
                    <AnswersTable
                        rows={differing}
                        mine={b.number}
                        theirs={a.number}
                        theirsLabel={columnName(model, a)}
                    />
                )}
            </Section>
            <Section
                title="Data diff"
                caption={
                    sameData
                        ? `Both trained on data v${a.data.number}.`
                        : `Data v${a.data.number} to v${b.data.number}: +${count(b.data.added)} rows, −${count(b.data.removed)} rows, ${count(b.data.relabelled)} relabelled.`
                }
            >
                {sameData ? (
                    <p className="text-muted-foreground">No rows changed.</p>
                ) : (
                    <div className="grid gap-4 lg:grid-cols-2">
                        <RowList title="Added" rows={ROWS_ADDED} total={b.data.added} sign="+" />
                        <RowList
                            title="Removed"
                            rows={ROWS_REMOVED}
                            total={b.data.removed}
                            sign="−"
                        />
                    </div>
                )}
            </Section>
            <DeployDialog intent={deploy} onOpenChange={(open) => !open && setDeploy(null)} />
        </Page>
    );
}
