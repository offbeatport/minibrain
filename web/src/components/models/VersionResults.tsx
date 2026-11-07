import {
    Badge,
    Button,
    Switch,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "obp-ui";
import { type ComponentType, useState } from "react";
import type { AnswerSide, ExampleAnswer, VersionInfo } from "~/api/client";
import { useVersionAnswers } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { useCan } from "~/lib/access";
import { percent } from "~/lib/format";
import { checkSentence } from "~/lib/judging";
import { metricName } from "~/lib/metrics";

type Split = NonNullable<VersionInfo["held_out"]>;
type Decision = NonNullable<VersionInfo["promotion"]>;

const MATRIX_LABELS = 10;
const NOT_A_LABEL = "Not a label";
const ANSWERS_PAGE = 10;
const ROLE_NAMES: Record<string, string> = { user: "User", assistant: "Assistant" };

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
            (version.held_out?.scores ?? []).map(
                (item) => `${metricName(item.grader).toLowerCase()} v${item.version}`,
            ),
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
                <h3 className="text-base font-semibold">Can it go live?</h3>
                <Badge variant={decision.passed ? "success" : "warning"}>
                    {decision.passed ? "Yes" : "Not yet"}
                </Badge>
            </div>
            {decision.checks.length === 0 ? (
                <p className="text-muted-foreground">
                    The promotion rule asks for nothing, so any ready version can go live.
                </p>
            ) : (
                <ul className="flex flex-col gap-1">
                    {decision.checks.map((check) => (
                        <li key={check.name} className="flex flex-wrap items-baseline gap-2">
                            <Badge variant={check.passed ? "success" : "destructive"}>
                                {check.passed ? "Met" : "Not met"}
                            </Badge>
                            <span>{checkSentence(check)}</span>
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
        return <p className="text-muted-foreground">No held-out row went to the wrong label.</p>;
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

function SideScores({ side, main }: { side: AnswerSide; main: string | null | undefined }) {
    const ordered = Object.entries(side.scores).sort(([left], [right]) =>
        left === main ? -1 : right === main ? 1 : left.localeCompare(right),
    );
    return (
        <p className="flex flex-wrap gap-x-3 text-sm text-muted-foreground tabular-nums">
            {ordered.map(([metric, value]) => (
                <span key={metric} className={metric === main ? "text-foreground" : undefined}>
                    {`${metricName(metric)} ${percent(value)}`}
                </span>
            ))}
        </p>
    );
}

function AnswerColumn({
    title,
    side,
    text,
    main,
}: {
    title: string;
    side?: AnswerSide | null;
    text?: string;
    main?: string | null;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <span className="font-medium">{title}</span>
            {side && <SideScores side={side} main={main} />}
            <p className="whitespace-pre-wrap break-words text-base">
                {side ? side.answer || "(empty)" : (text ?? "–")}
            </p>
            {side?.reason && (
                <p className="text-sm text-muted-foreground">{`Judge: ${side.reason}`}</p>
            )}
        </div>
    );
}

function Conversation({ example }: { example: ExampleAnswer }) {
    return (
        <div className="flex flex-col gap-1">
            {example.messages.map((turn, index) => (
                <p
                    key={`${index}:${turn.role}`}
                    className="whitespace-pre-wrap break-words text-base"
                >
                    <span className="font-medium">{`${ROLE_NAMES[turn.role] ?? turn.role}: `}</span>
                    {turn.content}
                </p>
            ))}
        </div>
    );
}

function AnswerRow({
    example,
    number,
    live,
    main,
}: {
    example: ExampleAnswer;
    number: number;
    live: number | null | undefined;
    main: string | null | undefined;
}) {
    return (
        <li className="flex flex-col gap-3 py-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <Conversation example={example} />
                {example.worse && <Badge variant="warning">Worse than live</Badge>}
            </div>
            <div className="grid gap-4 md:grid-cols-3">
                <AnswerColumn title="Expected" text={example.expected} />
                <AnswerColumn title={`v${number}`} side={example.version} main={main} />
                <AnswerColumn
                    title={live === null || live === undefined ? "Live" : `Live, v${live}`}
                    side={example.live}
                    text={
                        live === null || live === undefined
                            ? "No version is live."
                            : "Not answered on this row."
                    }
                    main={main}
                />
            </div>
        </li>
    );
}

function FreeTextResults({ slug, version }: { slug: string; version: VersionInfo }) {
    const can = useCan();
    const scored = version.status === "ready" && Boolean(version.held_out);
    const answers = useVersionAnswers(slug, version.number, can.build && scored);
    const [worseOnly, setWorseOnly] = useState(false);
    const [shown, setShown] = useState(ANSWERS_PAGE);
    if (!scored) {
        return null;
    }
    if (!can.build) {
        return <p className="text-muted-foreground">Reading the answers needs the Builder role.</p>;
    }
    const found = answers.data;
    const worse = (found?.examples ?? []).filter((example) => example.worse);
    const rows = worseOnly ? worse : (found?.examples ?? []);
    return (
        <div data-wide className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h3 className="text-base font-semibold">Answers</h3>
                    <p className="text-sm text-muted-foreground">
                        {found?.live === null || found?.live === undefined
                            ? "Each held-out conversation with the expected answer and this version's, with its scores and the judge's reason."
                            : `Each held-out conversation with the expected answer, this version's and the live v${found.live}'s, with their scores and the judge's reasons.`}
                    </p>
                </div>
                <label htmlFor="worse-only" className="flex items-center gap-2">
                    <Switch
                        id="worse-only"
                        checked={worseOnly}
                        disabled={found?.live === null || found?.live === undefined}
                        onCheckedChange={(checked) => {
                            setWorseOnly(checked);
                            setShown(ANSWERS_PAGE);
                        }}
                    />
                    <span className="tabular-nums">{`Worse than live (${worse.length})`}</span>
                </label>
            </div>
            <ErrorLine error={answers.error} />
            {answers.isLoading && <p className="text-muted-foreground">Loading…</p>}
            {found && rows.length === 0 && (
                <p className="text-muted-foreground">
                    {worseOnly
                        ? "No answer scores below the live version's."
                        : "No answers were kept for this version."}
                </p>
            )}
            {rows.length > 0 && (
                <ul className="flex flex-col divide-y rounded-md border px-4">
                    {rows.slice(0, shown).map((example, index) => (
                        <AnswerRow
                            key={`${index}:${example.expected}`}
                            example={example}
                            number={version.number}
                            live={found?.live}
                            main={found?.metric}
                        />
                    ))}
                </ul>
            )}
            {rows.length > shown && (
                <Button
                    variant="outline"
                    className="self-start"
                    onClick={() => setShown(shown + ANSWERS_PAGE)}
                >
                    {`Show ${Math.min(ANSWERS_PAGE, rows.length - shown)} more of ${rows.length - shown}`}
                </Button>
            )}
        </div>
    );
}

type ViewProps = { slug: string; version: VersionInfo };

const VIEWS: Record<string, ComponentType<ViewProps>> = {
    classify: ClassifyResults,
    free_text: FreeTextResults,
};

export function PresetResults({ slug, version }: ViewProps) {
    const View = version.view ? VIEWS[version.view] : undefined;
    return View ? <View slug={slug} version={version} /> : null;
}
