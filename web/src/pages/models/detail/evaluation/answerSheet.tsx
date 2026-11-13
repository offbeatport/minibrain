import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, cn } from "obp-ui";
import type { ReactNode } from "react";
import type { ExampleAnswer } from "~/api/client";
import { percent } from "~/lib/format";
import { metricName } from "~/lib/metrics";

export type Change = "newly right" | "better" | "newly wrong" | "worse";

export type FailureRow = { id: string; answer: ExampleAnswer; change: Change | null };

type Side = ExampleAnswer["version"];

export function rightOf(
    scores: Record<string, number>,
    metric: string | null | undefined,
): boolean | null {
    return metric && metric in scores ? scores[metric] >= 0.999 : null;
}

function Block({ label, children }: { label: string; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-label">
            <h3 className="text-sm text-muted-foreground">{label}</h3>
            {children}
        </section>
    );
}

function Text({ text, tone }: { text: string; tone?: string }) {
    return (
        <p className={cn("rounded-md bg-muted px-3 py-2 break-words whitespace-pre-wrap", tone)}>
            {text || "–"}
        </p>
    );
}

function SideBlock({
    label,
    side,
    metric,
}: {
    label: string;
    side: Side;
    metric: string | null | undefined;
}) {
    const right = rightOf(side.scores, metric);
    return (
        <Block label={label}>
            <Text text={side.answer} tone={right === false ? "text-destructive" : undefined} />
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground tabular-nums">
                {Object.entries(side.scores).map(([name, value]) => (
                    <span key={name}>
                        {`${metricName(name)} `}
                        <span className="text-foreground">{percent(value)}</span>
                    </span>
                ))}
            </p>
            {side.reason && <p className="text-muted-foreground">{side.reason}</p>}
        </Block>
    );
}

export function AnswerSheet({
    row,
    metric,
    picked,
    against,
    onClose,
}: {
    row: FailureRow | null;
    metric: string | null | undefined;
    picked: number;
    against: number | null;
    onClose: () => void;
}) {
    const answer = row?.answer;
    return (
        <Sheet open={row !== null} onOpenChange={(open) => !open && onClose()}>
            <SheetContent side="right" className="sm:max-w-2xl">
                <SheetHeader>
                    <SheetTitle>Held-out row</SheetTitle>
                    <SheetDescription>
                        {row?.change
                            ? `${row.change.charAt(0).toUpperCase()}${row.change.slice(1)} on v${picked} than on deployed v${against}`
                            : `How v${picked} answered it`}
                    </SheetDescription>
                </SheetHeader>
                {answer && (
                    <div className="flex flex-col gap-field overflow-y-auto pb-panel">
                        <Block label="Conversation">
                            <ul className="flex flex-col gap-2">
                                {answer.messages.map((turn, index) => (
                                    <li
                                        key={`${index}-${turn.role}`}
                                        className="flex flex-col gap-1"
                                    >
                                        <span className="text-sm text-muted-foreground capitalize">
                                            {turn.role}
                                        </span>
                                        <Text text={turn.content} />
                                    </li>
                                ))}
                            </ul>
                        </Block>
                        <Block label="Expected">
                            <Text text={answer.expected} />
                        </Block>
                        <SideBlock label={`v${picked}`} side={answer.version} metric={metric} />
                        {answer.live && against !== null && (
                            <SideBlock
                                label={`Deployed v${against}`}
                                side={answer.live}
                                metric={metric}
                            />
                        )}
                    </div>
                )}
            </SheetContent>
        </Sheet>
    );
}
