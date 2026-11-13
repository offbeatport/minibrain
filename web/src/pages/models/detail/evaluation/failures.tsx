import type { ColumnDef } from "@tanstack/react-table";
import { SearchX } from "lucide-react";
import {
    DataGrid,
    SegmentedTabs,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    cn,
} from "obp-ui";
import { useState } from "react";
import type { ExampleAnswer, ModelRow, VersionInfo } from "~/api/client";
import { ErrorLine, PanelSection } from "~/components/Section";
import { count, percent } from "~/lib/format";
import { isDeployed } from "../header";
import { liveOf, versionLabel } from "../makeLive";
import { inputOf, useAnswers, verdictOf } from "../version";
import { AnswerSheet, type Change, type FailureRow, rightOf } from "./answerSheet";
import { scoredVersions } from "./scores";

type Mode = "wrong" | "changed";

function changeOf(answer: ExampleAnswer, metric: string | null | undefined): Change | null {
    const verdict = verdictOf(answer, metric);
    if (verdict === "same") {
        return null;
    }
    const mine = rightOf(answer.version.scores, metric);
    const theirs = answer.live ? rightOf(answer.live.scores, metric) : null;
    if (verdict === "better") {
        return mine === true && theirs === false ? "newly right" : "better";
    }
    return mine === false && theirs === true ? "newly wrong" : "worse";
}

function failuresOf(
    answers: ExampleAnswer[],
    metric: string | null | undefined,
    mode: Mode,
): FailureRow[] {
    return answers.flatMap((answer, index): FailureRow[] => {
        if (mode === "changed") {
            const change = changeOf(answer, metric);
            return change ? [{ id: String(index), answer, change }] : [];
        }
        return rightOf(answer.version.scores, metric) === false
            ? [{ id: String(index), answer, change: null }]
            : [];
    });
}

function Clipped({ text, tone }: { text: string; tone?: string }) {
    return (
        <span title={text} className={cn("block max-w-72 truncate", tone)}>
            {text || "–"}
        </span>
    );
}

function sentence(text: string): string {
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

const CHANGE_TONE: Record<Change, string> = {
    "newly right": "text-success",
    better: "text-success",
    "newly wrong": "text-destructive",
    worse: "text-destructive",
};

function columnsFor(
    metric: string | null | undefined,
    mode: Mode,
    picked: number,
    against: number | null,
): ColumnDef<FailureRow, unknown>[] {
    const input: ColumnDef<FailureRow, unknown> = {
        id: "input",
        header: "Input",
        enableHiding: false,
        accessorFn: (item) => inputOf(item.answer),
        cell: ({ row }) => <Clipped text={inputOf(row.original.answer)} />,
    };
    const expected: ColumnDef<FailureRow, unknown> = {
        id: "expected",
        header: "Expected",
        accessorFn: (item) => item.answer.expected,
        cell: ({ row }) => <Clipped text={row.original.answer.expected} />,
    };
    const actual: ColumnDef<FailureRow, unknown> = {
        id: "actual",
        header: mode === "changed" ? `v${picked}` : "Answer",
        accessorFn: (item) => item.answer.version.answer,
        cell: ({ row }) => <Clipped text={row.original.answer.version.answer} />,
    };
    if (mode === "changed") {
        return [
            input,
            expected,
            actual,
            {
                id: "deployed",
                header: against === null ? "Deployed" : `Deployed v${against}`,
                accessorFn: (item) => item.answer.live?.answer ?? "",
                cell: ({ row }) => <Clipped text={row.original.answer.live?.answer ?? ""} />,
            },
            {
                id: "change",
                header: "Change",
                accessorFn: (item) => item.change ?? "",
                cell: ({ row }) => {
                    const change = row.original.change;
                    return change ? (
                        <span className={CHANGE_TONE[change]}>{sentence(change)}</span>
                    ) : null;
                },
            },
        ];
    }
    return [
        input,
        expected,
        actual,
        {
            id: "verdict",
            header: "Verdict",
            accessorFn: (item) => (metric ? (item.answer.version.scores[metric] ?? 0) : 0),
            cell: ({ row }) => {
                const side = row.original.answer.version;
                const score = metric ? side.scores[metric] : undefined;
                return (
                    <span className="flex min-w-0 items-baseline gap-2">
                        <span className="text-destructive tabular-nums">
                            {score === undefined || score === 0 ? "Wrong" : percent(score)}
                        </span>
                        {side.reason && <Clipped text={side.reason} tone="text-muted-foreground" />}
                    </span>
                );
            },
        },
    ];
}

function VersionPicker({
    versions,
    value,
    deployed,
    onChange,
}: {
    versions: VersionInfo[];
    value: number;
    deployed: number | null;
    onChange: (number: number) => void;
}) {
    return (
        <Select value={String(value)} onValueChange={(next) => onChange(Number(next ?? value))}>
            <SelectTrigger aria-label="Version" className="w-56">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {versions.map((version) => (
                    <SelectItem key={version.number} value={String(version.number)}>
                        {[
                            versionLabel(version),
                            percent(version.score),
                            version.number === deployed ? "deployed" : null,
                        ]
                            .filter(Boolean)
                            .join(" · ")}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function emptyText(mode: Mode, picked: number, against: number | null): string {
    if (mode === "changed") {
        return `v${picked} answers every held-out row the way deployed v${against} does.`;
    }
    return `v${picked} gets every held-out row right.`;
}

export function FailuresPanel({ row, versions }: { row: ModelRow; versions: VersionInfo[] }) {
    const scored = scoredVersions(versions).reverse();
    const deployed = isDeployed(row) ? liveOf(versions) : undefined;
    const [chosen, setChosen] = useState<number | null>(null);
    const [wanted, setWanted] = useState<Mode>("wrong");
    const [open, setOpen] = useState<FailureRow | null>(null);
    const picked = scored.find((version) => version.number === chosen) ?? scored[0];
    const comparable =
        picked !== undefined &&
        deployed !== undefined &&
        deployed.score !== null &&
        deployed.number !== picked.number;
    const mode: Mode = comparable ? wanted : "wrong";
    const against = mode === "changed" && deployed ? deployed.number : null;
    const answers = useAnswers(row.key, picked?.number ?? 0, against, picked !== undefined);
    const metric = answers.data?.metric;
    const all = answers.data?.examples ?? [];
    const rows = failuresOf(all, metric, mode);
    return (
        <PanelSection
            icon={SearchX}
            anchor="failures"
            title="Where it fails"
            tip={
                picked
                    ? `Held-out rows v${picked.number} does not get fully right${all.length > 0 ? `: ${count(rows.length)} of ${count(all.length)}` : ""}. Open a row for the whole conversation and the grader's reason.`
                    : "Held-out rows the latest scored version gets wrong."
            }
            actions={
                picked && (
                    <div className="flex flex-wrap items-center gap-2">
                        {comparable && (
                            <SegmentedTabs
                                tabs={[
                                    { key: "wrong", label: "Wrong" },
                                    { key: "changed", label: `Changed vs v${deployed.number}` },
                                ]}
                                active={mode}
                                onSelect={(next) =>
                                    setWanted(next === "changed" ? "changed" : "wrong")
                                }
                            />
                        )}
                        <VersionPicker
                            versions={scored}
                            value={picked.number}
                            deployed={deployed?.number ?? null}
                            onChange={setChosen}
                        />
                    </div>
                )
            }
            bare
        >
            <div className="flex flex-col gap-2">
                <DataGrid
                    columns={columnsFor(metric, mode, picked?.number ?? 0, against)}
                    rows={rows}
                    loading={answers.isLoading}
                    getRowId={(item) => item.id}
                    onOpen={setOpen}
                    rowLabel={(item) => `Held-out row ${inputOf(item.answer)}`}
                    maxHeight="28rem"
                    empty={
                        picked ? emptyText(mode, picked.number, against) : "No version scored yet."
                    }
                />
                <ErrorLine error={answers.error} onRetry={answers.refetch} />
            </div>
            <AnswerSheet
                row={open}
                metric={metric}
                picked={picked?.number ?? 0}
                against={against}
                onClose={() => setOpen(null)}
            />
        </PanelSection>
    );
}
