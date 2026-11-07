import { useRouter } from "@tanstack/react-router";
import { MessageSquareText } from "lucide-react";
import { Button, Card, CardContent, Input, Link } from "obp-ui";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ModelPageInfo, ModelRow, NextAction, VersionInfo } from "~/api/client";
import { usePlaygroundModels } from "~/api/playgroundQueries";
import { ErrorLine, PanelSection } from "~/components/Section";
import { useCan } from "~/lib/access";
import { feedbackForModel } from "~/lib/feedback";
import { count, milliseconds, percent } from "~/lib/format";
import { metricName } from "~/lib/metrics";
import { modelDataHref, modelPageHref, playgroundHref, trainingHref } from "~/lib/modelLinks";
import {
    type AssistantTurn,
    DEFAULT_SETTINGS,
    type Turn,
    newId,
    requestBody,
    streamChat,
} from "~/lib/playground";
import { bytes } from "~/lib/time";

export function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="grid gap-x-6 gap-y-1 px-panel py-3 sm:grid-cols-[8rem_1fr] sm:items-center">
            <div className="text-muted-foreground">{label}</div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">{children}</div>
        </div>
    );
}

export function SummaryCard({ children }: { children: ReactNode }) {
    return (
        <Card className="gap-0 py-0">
            <CardContent className="divide-y px-0">{children}</CardContent>
        </Card>
    );
}

function delta(score: number, other: number): string {
    const points = (score - other) * 100;
    const sign = points > 0 ? "+" : points < 0 ? "−" : "±";
    return `${sign}${Math.abs(points).toFixed(1)} pts`;
}

function Against({ label, score, against }: { label: string; score: number; against: number }) {
    return (
        <span className="tabular-nums text-muted-foreground">
            {`vs ${label} ${percent(against)} (${delta(score, against)})`}
        </span>
    );
}

export function QualityRow({
    versions,
    current,
    metric,
}: {
    versions: VersionInfo[];
    current: number | null | undefined;
    metric: string | null | undefined;
}) {
    const live = versions.find((version) => version.number === current);
    if (!live) {
        return <SummaryRow label="Quality">No version is live yet.</SummaryRow>;
    }
    if (live.score === null || live.score === undefined) {
        return (
            <SummaryRow label="Quality">{`v${live.number} is live and not scored yet.`}</SummaryRow>
        );
    }
    const base = versions.find((version) => version.number === 0 && version.number !== live.number);
    const previous = versions
        .filter((version) => version.number < live.number && version.number !== 0)
        .filter((version) => version.score !== null && version.score !== undefined)
        .sort((a, b) => b.number - a.number)[0];
    return (
        <SummaryRow label="Quality">
            <span className="tabular-nums">
                <span className="font-semibold">{percent(live.score)}</span>
                {` ${metricName(live.main_metric ?? metric).toLowerCase()} held out, v${live.number} live`}
            </span>
            {typeof base?.score === "number" && (
                <Against label="v0 (prompt only)" score={live.score} against={base.score} />
            )}
            {typeof previous?.score === "number" && (
                <Against
                    label={`v${previous.number}`}
                    score={live.score}
                    against={previous.score}
                />
            )}
        </SummaryRow>
    );
}

const DAY = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
});

function DayReadout({
    active,
    payload,
}: {
    active?: boolean;
    payload?: readonly { payload?: { day: string; requests: number } }[];
}) {
    const point = payload?.[0]?.payload;
    if (!active || !point) {
        return null;
    }
    return (
        <div className="rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-e2">
            <div className="text-muted-foreground">{DAY.format(new Date(point.day))}</div>
            <div className="font-semibold tabular-nums">{`${count(point.requests)} requests`}</div>
        </div>
    );
}

function TrafficLine({ traffic }: { traffic: ModelPageInfo["traffic"] }) {
    const rows = traffic.days.map((day) => ({ day: day.day, requests: day.requests }));
    return (
        <div
            className="h-9 w-40"
            role="img"
            aria-label={`Requests per day: ${rows.map((row) => row.requests).join(", ")}`}
        >
            <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                    <XAxis dataKey="day" hide />
                    <YAxis hide domain={[0, "dataMax"]} />
                    <Tooltip
                        content={<DayReadout />}
                        cursor={{ stroke: "var(--border)" }}
                        isAnimationActive={false}
                    />
                    <Line
                        type="monotone"
                        dataKey="requests"
                        stroke="var(--primary)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, stroke: "var(--card)", strokeWidth: 2 }}
                        isAnimationActive={false}
                    />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}

export function TrafficRow({ page }: { page: ModelPageInfo | undefined }) {
    const traffic = page?.traffic;
    if (!traffic) {
        return <SummaryRow label="Traffic">–</SummaryRow>;
    }
    if (traffic.requests === 0) {
        return <SummaryRow label="Traffic">No requests in the last 7 days.</SummaryRow>;
    }
    return (
        <SummaryRow label="Traffic">
            <TrafficLine traffic={traffic} />
            <span className="tabular-nums">
                {`${count(traffic.requests)} requests · p95 ${milliseconds(traffic.p95_ms)} · ${percent(traffic.error_rate)} errors`}
            </span>
            <span className="text-muted-foreground">Last 7 days</span>
        </SummaryRow>
    );
}

function nextHref(row: ModelRow, next: NextAction): string | null {
    if (next.kind === "review_feedback") {
        return `${feedbackForModel(row.key)}&status=pending`;
    }
    if (next.kind === "add_data") {
        return modelDataHref(row.key);
    }
    if (next.kind === "train") {
        return trainingHref(row.key);
    }
    if (next.kind === "create_custom") {
        return `/models/new?base=${encodeURIComponent(row.key)}`;
    }
    return null;
}

export function NextRow({
    row,
    page,
    onAct,
}: {
    row: ModelRow;
    page: ModelPageInfo | undefined;
    onAct: (next: NextAction) => void;
}) {
    const can = useCan();
    const next = page?.next;
    if (!next) {
        const blocked = row.health || row.teardown;
        return (
            <SummaryRow label="Next step">
                {blocked
                    ? "Sort out the problem above first."
                    : "Nothing until the running job ends."}
            </SummaryRow>
        );
    }
    if (!can.build) {
        return <SummaryRow label="Next step">{next.label}</SummaryRow>;
    }
    const href = nextHref(row, next);
    return (
        <SummaryRow label="Next step">
            {href ? (
                <Button asChild>
                    <Link href={href}>{next.label}</Link>
                </Button>
            ) : (
                <Button onClick={() => onAct(next)}>{next.label}</Button>
            )}
        </SummaryRow>
    );
}

export function WeightsRow({ summary, name }: { summary: ReactNode; name: string }) {
    return (
        <span className="flex flex-wrap items-center gap-x-2">
            <span className="tabular-nums">{summary}</span>
            <Link href={modelPageHref(name, "files")} className="text-primary hover:underline">
                View files
            </Link>
        </span>
    );
}

function answerTurn(): AssistantTurn {
    return {
        kind: "assistant",
        id: newId(),
        content: "",
        reasoning: "",
        calls: [],
        refusal: "",
        blocked: [],
        meta: null,
        error: null,
        streaming: true,
        json: false,
    };
}

export function TryIt({ row }: { row: ModelRow }) {
    const router = useRouter();
    const models = usePlaygroundModels();
    const target = (models.data?.targets ?? [])
        .filter((item) => item.key === row.key && item.kind === row.kind)
        .sort((a, b) => Number(b.name === row.key) - Number(a.name === row.key))[0];
    const [text, setText] = useState("");
    const [turns, setTurns] = useState<Turn[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>(null);
    const aborter = useRef<AbortController | null>(null);
    if (!target) {
        return null;
    }
    const answer = turns.find((turn): turn is AssistantTurn => turn.kind === "assistant");
    const loads = row.deployment.state === "not_deployed";
    const size = row.needed_bytes ?? row.size_bytes;
    const ask = async (event: FormEvent) => {
        event.preventDefault();
        const question = text.trim();
        if (!question || busy) {
            return;
        }
        const asked: Turn = { kind: "user", id: newId(), content: question };
        const reply = answerTurn();
        setTurns([asked, reply]);
        setError(null);
        setBusy(true);
        const controller = new AbortController();
        aborter.current = controller;
        const messages = [{ role: "user", content: question }];
        const body = requestBody(target.name, DEFAULT_SETTINGS, messages, target);
        const show = (content: string, done: boolean, refusal = "") =>
            setTurns([asked, { ...reply, content, refusal, streaming: !done }]);
        try {
            const done = await streamChat(body, controller.signal, (progress) =>
                show(progress.content, false, progress.refusal),
            );
            show(done.content, true, done.refusal);
        } catch (failure) {
            setTurns([asked, { ...reply, streaming: false }]);
            setError(failure);
        } finally {
            aborter.current = null;
            setBusy(false);
        }
    };
    const carry = () =>
        router.history.push(playgroundHref(target.name), {
            carried: turns.filter((turn) => turn.kind !== "assistant" || !turn.streaming),
        });
    return (
        <PanelSection
            icon={MessageSquareText}
            title="Try it"
            description="Through the Playground, so the same safety, policy and logging apply."
        >
            <div className="flex flex-col gap-3">
                <form onSubmit={ask} className="flex flex-wrap items-center gap-2">
                    <Input
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        placeholder={`Ask ${row.name}…`}
                        aria-label={`Ask ${row.name}`}
                        className="min-w-0 flex-1"
                    />
                    {busy ? (
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => aborter.current?.abort()}
                        >
                            Stop
                        </Button>
                    ) : (
                        <Button type="submit" variant="outline" disabled={!text.trim()}>
                            Ask
                        </Button>
                    )}
                </form>
                {loads && (
                    <p className="text-sm text-muted-foreground">
                        {`Loads ${row.name}${size ? ` (${bytes(size)})` : ""} to answer.`}
                    </p>
                )}
                {answer && (
                    <div className="flex flex-col gap-2 rounded-md border p-3">
                        {(answer.refusal || answer.content || !error) && (
                            <p className="whitespace-pre-wrap">
                                {answer.refusal || answer.content || (busy ? "…" : "No answer.")}
                            </p>
                        )}
                        <ErrorLine error={error} />
                        {!busy && (
                            <Button variant="outline" className="w-fit" onClick={carry}>
                                Continue in Playground
                            </Button>
                        )}
                    </div>
                )}
            </div>
        </PanelSection>
    );
}
