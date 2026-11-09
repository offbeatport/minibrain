import { useParams, useRouter } from "@tanstack/react-router";
import { ChevronDown, Download, MoreHorizontal, Play, Rocket, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Link,
    TabNav,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tabs,
    TabsList,
    TabsTrigger,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
    useToast,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import { Facts } from "~/components/Facts";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section } from "~/components/Section";
import { StepChart, type StepSeries } from "~/components/charts/StepChart";
import { ChartLegend } from "~/components/charts/TimeChart";
import { count } from "~/lib/format";
import { exactTime, relativeTime } from "~/lib/time";
import {
    type Answer,
    type FlowModel,
    type FlowVersion,
    KIND_LABELS,
    LOSS_STEPS,
    answerOf,
    answersFor,
    compareHref,
    createdAt,
    findVersion,
    flowHref,
    jobHref,
    liveVersion,
    lossCurve,
    newestFirst,
    pct,
    points,
    previousVersion,
    useFlowModel,
} from "./modelsFlowData";
import {
    Crumbs,
    Delta,
    DeployDialog,
    type DeployIntent,
    StateBadge,
    deployBlocked,
    deployLabel,
} from "./modelsFlowParts";

type Tab = "summary" | "answers" | "training" | "card";

const TABS: { id: Tab; label: string }[] = [
    { id: "summary", label: "Summary" },
    { id: "answers", label: "Answers" },
    { id: "training", label: "Training" },
    { id: "card", label: "Model card" },
];

const TRAIN = "var(--primary)";
const HELD_OUT = "var(--file-sql)";
const LOSS_SERIES: StepSeries[] = [
    { key: "loss", label: "Training loss", color: TRAIN },
    { key: "heldOut", label: "Held-out loss", color: HELD_OUT, dots: true },
];

function rate(value: number): string {
    return value.toExponential(0);
}

function baselineOf(model: FlowModel, version: FlowVersion): FlowVersion | undefined {
    const live = liveVersion(model);
    if (live && live.number !== version.number) {
        return live;
    }
    return previousVersion(model, version);
}

function ScoresTable({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const live = liveVersion(model);
    const zero = findVersion(model, 0);
    const columns = [
        { version, label: `v${version.number} · this` },
        ...(live && live.number !== version.number
            ? [{ version: live, label: `v${live.number} · live` }]
            : []),
        ...(zero && zero.number !== version.number && zero.number !== live?.number
            ? [{ version: zero, label: "v0 · prompt only" }]
            : []),
    ];
    return (
        <div className="overflow-x-auto rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Metric</TableHead>
                        {columns.map((column, index) => (
                            <TableHead
                                key={column.label}
                                className="text-right"
                                colSpan={index === 0 ? 1 : 2}
                            >
                                {column.label}
                            </TableHead>
                        ))}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {model.metrics.map((metric, position) => (
                        <TableRow key={metric}>
                            <TableCell>{metric}</TableCell>
                            {columns.map((column, index) => {
                                const value = column.version.scores?.[position] ?? null;
                                const mine = version.scores?.[position] ?? null;
                                return [
                                    <TableCell
                                        key={`${column.label}-value`}
                                        className={cn("text-right", index === 0 && "font-semibold")}
                                    >
                                        {pct(value)}
                                    </TableCell>,
                                    index > 0 && (
                                        <TableCell
                                            key={`${column.label}-delta`}
                                            className="w-32 text-right text-sm"
                                        >
                                            {value !== null && mine !== null && (
                                                <Delta
                                                    value={mine - value}
                                                    suffix={`vs v${column.version.number}`}
                                                />
                                            )}
                                        </TableCell>
                                    ),
                                ];
                            })}
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

type Check = { label: string; value: string; met: boolean };

function ruleChecks(model: FlowModel, version: FlowVersion): Check[] {
    if (!version.scores) {
        return [];
    }
    const live = liveVersion(model);
    const [floor, slack] = model.rule;
    const checks: Check[] = [
        {
            label: `${model.metrics[0]} is at least ${pct(floor)}`,
            value: pct(version.scores[0]),
            met: version.scores[0] >= floor,
        },
    ];
    if (live?.scores && live.number !== version.number) {
        const drop = version.scores[1] - live.scores[1];
        checks.push({
            label: `${model.metrics[1]} is no more than ${(slack * 100).toFixed(1)} points below live (v${live.number})`,
            value: `${points(drop)} points`,
            met: drop >= -slack,
        });
    }
    return checks;
}

function verdict(model: FlowModel, version: FlowVersion, checks: Check[]): string {
    const live = liveVersion(model);
    if (version.status === "training") {
        return "Still training; the rule is checked once it is scored.";
    }
    if (version.status === "failed") {
        return "It failed before it was scored, so the rule was never checked.";
    }
    if (live?.number === version.number) {
        return "This is the live version.";
    }
    const missed = checks.filter((check) => !check.met);
    if (missed.length > 0) {
        return `Rejected: ${missed.map((check) => check.label.charAt(0).toLowerCase() + check.label.slice(1)).join(" and ")} is not met. It cannot be deployed.`;
    }
    const delta = live?.scores && version.scores ? version.scores[0] - live.scores[0] : null;
    if (delta !== null && delta > 0) {
        return `Passed, and it beats live by ${points(delta)} points on ${model.metrics[0].toLowerCase()}. Ready to deploy.`;
    }
    return "Passed the rule but scores below live, so deploying it would lower quality.";
}

function PromotionPanel({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const checks = ruleChecks(model, version);
    const passed = version.passed;
    return (
        <Section
            title="Promotion rule"
            caption={verdict(model, version, checks)}
            actions={
                passed !== null && (
                    <Badge variant={passed ? "success" : "warning"}>
                        {passed ? "Can go live" : "Cannot go live"}
                    </Badge>
                )
            }
        >
            {checks.length === 0 ? (
                <p className="text-muted-foreground">No scores yet.</p>
            ) : (
                <ul className="flex flex-col gap-1.5">
                    {checks.map((check) => (
                        <li key={check.label} className="flex flex-wrap items-baseline gap-2">
                            <Badge variant={check.met ? "success" : "destructive"}>
                                {check.met ? "Met" : "Not met"}
                            </Badge>
                            <span>{check.label}</span>
                            <span className="text-muted-foreground tabular-nums">
                                {check.value}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </Section>
    );
}

type DiffRow = { label: string; before: string; after: string };

function DiffTable({ rows, before, after }: { rows: DiffRow[]; before: string; after: string }) {
    return (
        <div className="overflow-x-auto rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead />
                        <TableHead className="text-right">{before}</TableHead>
                        <TableHead className="text-right">{after}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row) => {
                        const same = row.before === row.after;
                        return (
                            <TableRow key={row.label}>
                                <TableCell
                                    className={same ? "text-muted-foreground" : "font-medium"}
                                >
                                    {row.label}
                                </TableCell>
                                <TableCell className="text-right text-muted-foreground">
                                    {row.before}
                                </TableCell>
                                <TableCell
                                    className={cn(
                                        "text-right",
                                        same ? "text-muted-foreground" : "font-semibold",
                                    )}
                                >
                                    {same ? "Same" : row.after}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}

export function dataRows(a: FlowVersion, b: FlowVersion): DiffRow[] {
    return [
        { label: "Data version", before: `v${a.data.number}`, after: `v${b.data.number}` },
        { label: "Rows", before: count(a.data.rows), after: count(b.data.rows) },
    ];
}

export function settingsRows(a: FlowVersion, b: FlowVersion): DiffRow[] {
    const of = (version: FlowVersion, pick: (s: NonNullable<FlowVersion["settings"]>) => string) =>
        version.settings ? pick(version.settings) : "—";
    return [
        { label: "Kind", before: KIND_LABELS[a.kind], after: KIND_LABELS[b.kind] },
        {
            label: "LoRA rank",
            before: of(a, (s) => String(s.rank)),
            after: of(b, (s) => String(s.rank)),
        },
        {
            label: "Epochs",
            before: of(a, (s) => String(s.epochs)),
            after: of(b, (s) => String(s.epochs)),
        },
        {
            label: "Learning rate",
            before: of(a, (s) => rate(s.learningRate)),
            after: of(b, (s) => rate(s.learningRate)),
        },
        {
            label: "Training rows",
            before: of(a, (s) => count(s.rows)),
            after: of(b, (s) => count(s.rows)),
        },
        {
            label: "Batch",
            before: of(a, (s) => String(s.batch)),
            after: of(b, (s) => String(s.batch)),
        },
    ];
}

function dataChange(version: FlowVersion): string {
    const { added, removed, relabelled } = version.data;
    if (added === 0 && removed === 0 && relabelled === 0) {
        return "No row changes";
    }
    const parts = [`+${count(added)} rows`, `−${count(removed)} rows`];
    if (relabelled > 0) {
        parts.push(`${count(relabelled)} relabelled`);
    }
    return parts.join(" · ");
}

function ChangesPanel({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const previous = previousVersion(model, version);
    if (!previous) {
        return (
            <Section title="What changed">
                <p className="text-muted-foreground">This is the first version.</p>
            </Section>
        );
    }
    const before = `v${previous.number}`;
    const after = `v${version.number}`;
    return (
        <Section
            title={`What changed since ${before}`}
            caption={`Data: ${dataChange(version)} since data v${previous.data.number}.`}
            actions={
                version.scores &&
                previous.scores && (
                    <Button variant="outline" asChild>
                        <Link href={compareHref(model.slug, previous.number, version.number)}>
                            {`Compare with ${before}`}
                        </Link>
                    </Button>
                )
            }
        >
            <div className="grid gap-4 lg:grid-cols-2">
                <div className="flex flex-col gap-2">
                    <h3 className="font-semibold">Data</h3>
                    <DiffTable rows={dataRows(previous, version)} before={before} after={after} />
                </div>
                <div className="flex flex-col gap-2">
                    <h3 className="font-semibold">Settings</h3>
                    <DiffTable
                        rows={settingsRows(previous, version)}
                        before={before}
                        after={after}
                    />
                </div>
            </div>
        </Section>
    );
}

function SummaryTab({ model, version }: { model: FlowModel; version: FlowVersion }) {
    return (
        <div className="flex flex-col gap-4">
            <Section
                title="Scores"
                caption={`On the held-out set: ${count(model.heldOut)} rows this version never trained on.`}
            >
                {version.scores ? (
                    <ScoresTable model={model} version={version} />
                ) : (
                    <p className="text-muted-foreground">
                        {version.status === "training"
                            ? "Scored when training finishes."
                            : "Not scored: training failed."}
                    </p>
                )}
            </Section>
            <PromotionPanel model={model} version={version} />
            <ChangesPanel model={model} version={version} />
        </div>
    );
}

export type Verdict = "worse" | "better" | "same";

export function verdictOf(answer: Answer, mine: number, theirs: number): Verdict {
    const a = answerOf(answer, mine) === answer.expected;
    const b = answerOf(answer, theirs) === answer.expected;
    return a === b ? "same" : a ? "better" : "worse";
}

const VERDICT_BADGES: Record<
    Verdict,
    { variant: "success" | "warning" | "neutral"; label: string }
> = {
    better: { variant: "success", label: "Better" },
    worse: { variant: "warning", label: "Worse" },
    same: { variant: "neutral", label: "Same" },
};

function Label({ value, expected }: { value: string; expected: string }) {
    const right = value === expected;
    return (
        <span className={cn("font-mono text-sm", right ? "text-foreground" : "text-destructive")}>
            {value}
            <span className="sr-only">{right ? " (right)" : " (wrong)"}</span>
        </span>
    );
}

export function AnswersTable({
    rows,
    mine,
    theirs,
    theirsLabel,
}: {
    rows: Answer[];
    mine: number;
    theirs: number;
    theirsLabel: string;
}) {
    return (
        <div className="overflow-x-auto rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="w-20">Row</TableHead>
                        <TableHead>Input</TableHead>
                        <TableHead>Expected</TableHead>
                        <TableHead>{`v${mine}`}</TableHead>
                        <TableHead>{theirsLabel}</TableHead>
                        <TableHead className="text-right">{`Score v${mine}`}</TableHead>
                        <TableHead className="text-right">{`Score v${theirs}`}</TableHead>
                        <TableHead className="w-24" />
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((answer) => {
                        const verdict = verdictOf(answer, mine, theirs);
                        const score = (number: number) =>
                            answerOf(answer, number) === answer.expected ? "1.00" : "0.00";
                        return (
                            <TableRow key={answer.id}>
                                <TableCell className="font-mono text-sm text-muted-foreground">
                                    {`#${answer.id}`}
                                </TableCell>
                                <TableCell className="max-w-72 truncate" title={answer.text}>
                                    {answer.text}
                                </TableCell>
                                <TableCell className="font-mono text-sm">
                                    {answer.expected}
                                </TableCell>
                                <TableCell>
                                    <Label
                                        value={answerOf(answer, mine)}
                                        expected={answer.expected}
                                    />
                                </TableCell>
                                <TableCell>
                                    <Label
                                        value={answerOf(answer, theirs)}
                                        expected={answer.expected}
                                    />
                                </TableCell>
                                <TableCell className="text-right">{score(mine)}</TableCell>
                                <TableCell className="text-right text-muted-foreground">
                                    {score(theirs)}
                                </TableCell>
                                <TableCell className="text-right">
                                    <Badge variant={VERDICT_BADGES[verdict].variant}>
                                        {VERDICT_BADGES[verdict].label}
                                    </Badge>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}

type Filter = Verdict | "all";

const FILTERS: { id: Filter; label: string }[] = [
    { id: "worse", label: "Worse than live" },
    { id: "better", label: "Better" },
    { id: "same", label: "Same" },
    { id: "all", label: "All" },
];

function AnswersTab({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const baseline = baselineOf(model, version);
    const all = answersFor(model);
    const [filter, setFilter] = useState<Filter>("worse");
    if (!version.scores || !baseline || all.length === 0) {
        return (
            <Section title="Answers">
                <p className="text-muted-foreground">
                    {all.length === 0
                        ? "Answers are drawn for Support triage only in this prototype."
                        : "No answers until it is scored."}
                </p>
            </Section>
        );
    }
    const live = liveVersion(model)?.number === baseline.number;
    const counts = (id: Filter) =>
        id === "all"
            ? all.length
            : all.filter((a) => verdictOf(a, version.number, baseline.number) === id).length;
    const rows =
        filter === "all"
            ? all
            : all.filter((a) => verdictOf(a, version.number, baseline.number) === filter);
    const label = (item: (typeof FILTERS)[number]) =>
        item.id === "worse" && !live ? `Worse than v${baseline.number}` : item.label;
    return (
        <Section
            title="Answers"
            caption={`Held-out rows answered by v${version.number} and ${live ? `live (v${baseline.number})` : `v${baseline.number}`}, with the expected label. ${all.length} of ${count(model.heldOut)} rows drawn.`}
        >
            <div className="flex flex-col gap-3">
                <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
                    <TabsList aria-label="Show rows">
                        {FILTERS.map((item) => (
                            <TabsTrigger key={item.id} value={item.id}>
                                {label(item)}
                                <span className="text-sm text-muted-foreground tabular-nums">
                                    {counts(item.id)}
                                </span>
                            </TabsTrigger>
                        ))}
                    </TabsList>
                </Tabs>
                {rows.length === 0 ? (
                    <p className="text-muted-foreground">No rows in this group.</p>
                ) : (
                    <AnswersTable
                        rows={rows}
                        mine={version.number}
                        theirs={baseline.number}
                        theirsLabel={live ? `v${baseline.number} · live` : `v${baseline.number}`}
                    />
                )}
            </div>
        </Section>
    );
}

function TrainingTab({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const previous = previousVersion(model, version);
    if (version.kind === "prompt" || !version.settings) {
        return (
            <Section title="Training">
                <p className="text-muted-foreground">
                    Prompt-only versions are not trained: v0 scores the instructions on the base as
                    it is.
                </p>
            </Section>
        );
    }
    const settings = version.settings;
    const was = (value: string, before: string | undefined) =>
        before === undefined || before === value ? (
            value
        ) : (
            <span className="tabular-nums">
                {value}
                <span className="text-muted-foreground">{` (v${previous?.number}: ${before})`}</span>
            </span>
        );
    const before = previous?.settings;
    const stop =
        version.status === "training"
            ? LOSS_STEPS * (version.progress ?? 0)
            : version.status === "failed"
              ? LOSS_STEPS * 0.3
              : LOSS_STEPS;
    const rows = lossCurve(version.number).filter((row) => row.step <= stop);
    return (
        <div className="flex flex-col gap-4">
            <div className="grid gap-4 lg:grid-cols-2">
                <Section
                    title="Data"
                    caption={`What v${version.number} trained and was scored on.`}
                >
                    <Facts
                        items={[
                            ["Dataset", "Support tickets"],
                            [
                                "Version",
                                <span
                                    key="v"
                                    className="tabular-nums"
                                >{`v${version.data.number} · ${count(version.data.rows)} rows`}</span>,
                            ],
                            ["Since previous", dataChange(version)],
                            [
                                "Split",
                                <span
                                    key="s"
                                    className="tabular-nums"
                                >{`${count(settings.rows)} train · ${count(model.heldOut)} held out`}</span>,
                            ],
                        ]}
                    />
                </Section>
                <Section
                    title="Settings"
                    caption={
                        previous ? `Changes against v${previous.number} in brackets.` : undefined
                    }
                >
                    <Facts
                        items={[
                            ["Method", "LoRA"],
                            [
                                "Rank",
                                was(
                                    String(settings.rank),
                                    before ? String(before.rank) : undefined,
                                ),
                            ],
                            [
                                "Epochs",
                                was(
                                    String(settings.epochs),
                                    before ? String(before.epochs) : undefined,
                                ),
                            ],
                            [
                                "Learning rate",
                                was(
                                    rate(settings.learningRate),
                                    before ? rate(before.learningRate) : undefined,
                                ),
                            ],
                            [
                                "Training rows",
                                was(count(settings.rows), before ? count(before.rows) : undefined),
                            ],
                        ]}
                    />
                </Section>
            </div>
            <Section
                title="Loss"
                caption={
                    version.status === "training"
                        ? `Step ${count(stop)} of ${count(LOSS_STEPS)}; the chart grows while it trains.`
                        : "Training loss every 24 steps, held-out loss every 120."
                }
                actions={
                    <Button variant="outline" asChild>
                        <Link href={jobHref(version.jobId)}>{`Job #${version.jobId}`}</Link>
                    </Button>
                }
            >
                <div className="flex flex-col gap-3">
                    {version.status === "failed" && (
                        <div className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2">
                            {version.error}
                        </div>
                    )}
                    <ChartLegend series={LOSS_SERIES} />
                    <StepChart
                        rows={rows}
                        series={LOSS_SERIES}
                        format={(value) => value.toFixed(3)}
                        axisFormat={(value) => value.toFixed(2)}
                        label={`Training and held-out loss for ${model.name} v${version.number}`}
                        domain={[0, LOSS_STEPS]}
                        height={240}
                    />
                </div>
            </Section>
        </div>
    );
}

function CardBlock({ title, items }: { title: string; items: [string, ReactNode][] }) {
    return (
        <section className="flex flex-col gap-2 border-t pt-4 first:border-t-0 first:pt-0">
            <h3 className="font-semibold">{title}</h3>
            <Facts items={items} />
        </section>
    );
}

function CardTab({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const toast = useToast();
    const live = liveVersion(model);
    const download = (format: string) =>
        toast({
            title: "Not in the prototype",
            description: `Would download the model card as ${format}.`,
        });
    const sha = `9f2c${(version.number * 7919).toString(16).padStart(4, "0")}e1b04d7a5c3e88f0a12bd6c4e9f7031a2b5d8c6e4f9a0b1c2d3e4f5a6b7c8d9e`;
    return (
        <Section
            title="Model card"
            caption={`Generated for v${version.number}; read-only. Edit purpose and limits on the model page.`}
            actions={
                <>
                    <Button variant="outline" onClick={() => download("Markdown")}>
                        <Download aria-hidden="true" />
                        Markdown
                    </Button>
                    <Button variant="outline" onClick={() => download("JSON")}>
                        <Download aria-hidden="true" />
                        JSON
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-4">
                <CardBlock
                    title="Purpose"
                    items={[
                        ["Task", model.description || "Chat assistant"],
                        [
                            "Output",
                            "One label from six: billing, refund_request, account_access, bug_report, shipping, feature_request",
                        ],
                    ]}
                />
                <CardBlock
                    title="Intended use"
                    items={[
                        ["Use", "Route inbound tickets before a person reads them."],
                        ["Not for", "Deciding refunds or account actions on its own."],
                        ["Owner", "Support operations"],
                    ]}
                />
                <CardBlock
                    title="Base and licence"
                    items={[
                        ["Base", model.base ?? model.name],
                        ["Licence", "Apache 2.0 · commercial use allowed"],
                        ["Method", KIND_LABELS[version.kind]],
                    ]}
                />
                <CardBlock
                    title="Data"
                    items={[
                        ["Dataset", `Support tickets v${version.data.number}`],
                        [
                            "Rows",
                            <span key="r" className="tabular-nums">
                                {count(version.data.rows)}
                            </span>,
                        ],
                        ["Checks", "Passed: no duplicates, no leakage, personal data scrubbed"],
                    ]}
                />
                <CardBlock
                    title="Training"
                    items={[
                        [
                            "Settings",
                            version.settings
                                ? `LoRA rank ${version.settings.rank}, ${version.settings.epochs} epochs, rate ${rate(version.settings.learningRate)}`
                                : "Not trained",
                        ],
                        [
                            "Job",
                            <Link
                                key="j"
                                href={jobHref(version.jobId)}
                                className="text-primary hover:underline"
                            >{`#${version.jobId}`}</Link>,
                        ],
                    ]}
                />
                <CardBlock
                    title="Evaluation"
                    items={model.metrics.map((metric, index) => [
                        metric,
                        <span key={metric} className="tabular-nums">
                            {pct(version.scores?.[index])}
                        </span>,
                    ])}
                />
                <CardBlock
                    title="Known limits"
                    items={[
                        [
                            "From the scores",
                            "Confuses billing with refund_request when a ticket asks for money back without the word refund.",
                        ],
                        [
                            "Written by the team",
                            "English only. Not tested on tickets longer than 2,000 characters.",
                        ],
                    ]}
                />
                <CardBlock
                    title="Approvals"
                    items={[
                        [
                            "Promotion rule",
                            version.passed === null
                                ? "Not checked"
                                : version.passed
                                  ? "Passed"
                                  : "Rejected",
                        ],
                        [
                            "Deployed",
                            live?.number === version.number
                                ? `Live since ${relativeTime(createdAt(version))}`
                                : version.wasLive
                                  ? "Was live"
                                  : "Never",
                        ],
                    ]}
                />
                <CardBlock
                    title="Integrity"
                    items={[
                        [
                            "Adapter SHA-256",
                            <span key="h" className="font-mono text-sm break-all">
                                {sha}
                            </span>,
                        ],
                    ]}
                />
            </div>
        </Section>
    );
}

function CompareWith({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const router = useRouter();
    const live = liveVersion(model);
    const others = newestFirst(model).filter((other) => other.number !== version.number);
    const blocked = !version.scores;
    const trigger = (
        <Button variant="outline" disabled={blocked}>
            Compare with…
            <ChevronDown aria-hidden="true" />
        </Button>
    );
    if (blocked) {
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="inline-flex">{trigger}</span>
                </TooltipTrigger>
                <TooltipContent>Nothing to compare until it is scored.</TooltipContent>
            </Tooltip>
        );
    }
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>{`Compare v${version.number} with`}</DropdownMenuLabel>
                {others.map((other) => (
                    <DropdownMenuItem
                        key={other.number}
                        disabled={!other.scores}
                        onSelect={() =>
                            router.history.push(
                                compareHref(model.slug, other.number, version.number),
                            )
                        }
                    >
                        <span className="w-8 font-medium tabular-nums">{`v${other.number}`}</span>
                        <span className="flex-1 text-muted-foreground">
                            {other.number === live?.number
                                ? "Live"
                                : other.scores
                                  ? KIND_LABELS[other.kind]
                                  : other.status === "training"
                                    ? "Training"
                                    : "Failed"}
                        </span>
                        <span className="tabular-nums">{pct(other.scores?.[0])}</span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function DeployButton({
    model,
    version,
    onDeploy,
}: {
    model: FlowModel;
    version: FlowVersion;
    onDeploy: (intent: DeployIntent) => void;
}) {
    const label = deployLabel(model, version);
    const blocked = deployBlocked(version);
    if (!label) {
        return null;
    }
    const button = (
        <Button disabled={Boolean(blocked)} onClick={() => onDeploy({ model, version })}>
            <Rocket aria-hidden="true" />
            {label}
        </Button>
    );
    if (!blocked) {
        return button;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex">{button}</span>
            </TooltipTrigger>
            <TooltipContent>{blocked}</TooltipContent>
        </Tooltip>
    );
}

function VersionMenu({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const toast = useToast();
    const live = liveVersion(model)?.number === version.number;
    const note = (what: string) =>
        toast({ title: "Not in the prototype", description: `Would ${what}.` });
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`More actions for v${version.number}`}
                >
                    <MoreHorizontal />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                    disabled={version.status !== "ready"}
                    onSelect={() => note("open the playground")}
                >
                    <Play />
                    {`Test v${version.number}`}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => note("download the model card")}>
                    <Download />
                    Download model card
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    variant="destructive"
                    disabled={live}
                    onSelect={() => note(`delete v${version.number}`)}
                >
                    <Trash2 />
                    {live ? `v${version.number} is live` : `Delete v${version.number}`}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function tabOf(value: string | undefined): Tab {
    return TABS.find((tab) => tab.id === value)?.id ?? "summary";
}

export function ModelsFlowVersionPage() {
    const params = useParams({ strict: false }) as {
        model?: string;
        version?: string;
        tab?: string;
    };
    const model = useFlowModel(params.model);
    const number = Number((params.version ?? "").replace(/^v/, ""));
    const version = model ? findVersion(model, number) : undefined;
    const [deploy, setDeploy] = useState<DeployIntent>(null);
    const tab = tabOf(params.tab);
    if (!model || !version) {
        return (
            <Page>
                <Crumbs
                    items={[
                        { label: "Models", href: flowHref() },
                        { label: `${params.model} ${params.version}` },
                    ]}
                />
                <p className="text-muted-foreground">No such version.</p>
            </Page>
        );
    }
    const base = flowHref(model.slug, version.number);
    const created = createdAt(version);
    return (
        <Page>
            <Crumbs
                items={[
                    { label: "Models", href: flowHref() },
                    { label: model.name, href: flowHref(model.slug) },
                    { label: `v${version.number}` },
                ]}
            />
            <PageHeader
                title={`v${version.number}`}
                badge={
                    <span className="flex items-center gap-2">
                        <Badge variant="outline">{KIND_LABELS[version.kind]}</Badge>
                        <StateBadge model={model} version={version} />
                    </span>
                }
                caption={
                    <span>
                        {`${model.name} on ${model.base} · created `}
                        <time dateTime={created} title={exactTime(created)}>
                            {relativeTime(created)}
                        </time>
                        {` · data v${version.data.number}`}
                    </span>
                }
                actions={
                    <>
                        <CompareWith model={model} version={version} />
                        <DeployButton model={model} version={version} onDeploy={setDeploy} />
                        <VersionMenu model={model} version={version} />
                    </>
                }
            />
            <TabNav
                label={`v${version.number} pages`}
                tabs={TABS.map((item) => ({
                    href: item.id === "summary" ? base : `${base}/${item.id}`,
                    label: item.label,
                }))}
            />
            <div className="pt-2">
                {tab === "summary" && <SummaryTab model={model} version={version} />}
                {tab === "answers" && <AnswersTab model={model} version={version} />}
                {tab === "training" && <TrainingTab model={model} version={version} />}
                {tab === "card" && <CardTab model={model} version={version} />}
            </div>
            <DeployDialog intent={deploy} onOpenChange={(open) => !open && setDeploy(null)} />
        </Page>
    );
}
