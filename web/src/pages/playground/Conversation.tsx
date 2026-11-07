import {
    Badge,
    Button,
    CodeBlock,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
    Label,
    Markdown,
    Textarea,
} from "obp-ui";
import { ChatBubble } from "obp-ui/chat";
import { useState } from "react";
import { AnswerFeedback } from "~/components/AnswerFeedback";
import { count, milliseconds } from "~/lib/format";
import {
    type AssistantTurn,
    type Target,
    type ToolCall,
    type Turn,
    exampleTurns,
    prettyJson,
} from "~/lib/playground";

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
    return (
        <Collapsible defaultOpen={streaming}>
            <CollapsibleTrigger className="text-muted-foreground">
                {streaming
                    ? "Reasoning…"
                    : `Reasoning · ${count(text.trim().split(/\s+/).length)} words`}
            </CollapsibleTrigger>
            <CollapsibleContent>
                <p className="mt-2 border-l pl-3 whitespace-pre-wrap text-muted-foreground">
                    {text.trim()}
                </p>
            </CollapsibleContent>
        </Collapsible>
    );
}

function ToolCard({
    call,
    result,
    onResult,
    busy,
}: {
    call: ToolCall;
    result: string | undefined;
    onResult: (text: string) => void;
    busy: boolean;
}) {
    const [draft, setDraft] = useState("");
    const args = prettyJson(call.arguments);
    const answer = result === undefined ? null : prettyJson(result);
    const field = `tool-result-${call.id}`;
    return (
        <div className="flex flex-col gap-2 rounded-md border bg-card p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                    Calls <span className="font-mono">{call.name}</span>
                </span>
                <span className="font-mono text-sm text-muted-foreground">{call.id}</span>
            </div>
            <CodeBlock
                code={args ?? call.arguments}
                language={args ? "json" : "text"}
                copyLabel="Copy the arguments"
            />
            {result !== undefined ? (
                <CodeBlock
                    code={answer ?? result}
                    language={answer ? "json" : "text"}
                    title="Result"
                    copyLabel="Copy the result"
                    wrap
                />
            ) : (
                <div className="flex flex-col gap-label">
                    <Label htmlFor={field}>Tool result</Label>
                    <Textarea
                        id={field}
                        rows={3}
                        value={draft}
                        placeholder='{"temperature": 18}'
                        className="font-mono"
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    <Button
                        size="sm"
                        className="w-fit"
                        disabled={busy || !draft.trim()}
                        onClick={() => onResult(draft.trim())}
                    >
                        Send result
                    </Button>
                </div>
            )}
        </div>
    );
}

function Meta({ turn }: { turn: AssistantTurn }) {
    const meta = turn.meta;
    if (!meta) {
        return null;
    }
    const parts = [
        milliseconds(meta.latencyMs),
        `${count(meta.promptTokens)} in · ${count(meta.completionTokens)} out`,
        meta.finishReason ?? "",
    ].filter(Boolean);
    return (
        <p className="text-sm text-muted-foreground tabular-nums">
            <span className="font-mono">{meta.model}</span> · {parts.join(" · ")}
        </p>
    );
}

function Answer({
    turn,
    results,
    onResult,
    busy,
    target,
    input,
    onSaveExample,
}: {
    turn: AssistantTurn;
    results: Record<string, string>;
    onResult: (call: ToolCall, text: string) => void;
    busy: boolean;
    target: Target | undefined;
    input: string;
    onSaveExample: (() => void) | null;
}) {
    const json = turn.json ? prettyJson(turn.content) : null;
    const answered = !turn.streaming && !turn.error && !turn.refusal && turn.meta;
    return (
        <div className="flex max-w-full flex-col gap-2">
            {turn.reasoning && (
                <Reasoning text={turn.reasoning} streaming={turn.streaming && !turn.content} />
            )}
            {turn.refusal && (
                <div className="flex flex-col gap-1">
                    <Badge variant="warning" className="w-fit">
                        Blocked
                    </Badge>
                    <p>{turn.refusal}</p>
                </div>
            )}
            {json ? (
                <CodeBlock code={json} language="json" copyLabel="Copy the answer" />
            ) : (
                turn.content && <Markdown content={turn.content} className="text-base" />
            )}
            {turn.streaming && !turn.content && !turn.reasoning && (
                <p className="text-muted-foreground">Generating…</p>
            )}
            {turn.calls.map((call) => (
                <ToolCard
                    key={call.id || call.name}
                    call={call}
                    result={results[call.id]}
                    onResult={(text) => onResult(call, text)}
                    busy={busy}
                />
            ))}
            {turn.error && <p className="text-destructive">{turn.error}</p>}
            <Meta turn={turn} />
            {answered && target?.kind === "custom" && turn.meta && (
                <AnswerFeedback
                    slug={target.key}
                    input={input}
                    reply={{ id: turn.meta.responseId, model: target.name, output: turn.content }}
                    labels={target.labels}
                    actions={
                        onSaveExample && (
                            <Button variant="ghost" onClick={onSaveExample} disabled={busy}>
                                Save as test example
                            </Button>
                        )
                    }
                />
            )}
        </div>
    );
}

export function Conversation({
    turns,
    target,
    busy,
    onToolResult,
    onSaveExample,
}: {
    turns: Turn[];
    target: Target | undefined;
    busy: boolean;
    onToolResult: (call: ToolCall, text: string) => void;
    onSaveExample: ((answerId: string) => void) | null;
}) {
    const results = Object.fromEntries(
        turns.flatMap((turn) => (turn.kind === "tool" ? [[turn.callId, turn.content]] : [])),
    );
    let input = "";
    return (
        <div className="flex flex-col gap-5">
            {turns.map((turn) => {
                if (turn.kind === "user") {
                    input = turn.content;
                    return <ChatBubble key={turn.id} role="user" text={turn.content} />;
                }
                if (turn.kind === "tool") {
                    return null;
                }
                return (
                    <Answer
                        key={turn.id}
                        turn={turn}
                        results={results}
                        onResult={onToolResult}
                        busy={busy}
                        target={target}
                        input={input}
                        onSaveExample={
                            onSaveExample && exampleTurns(turns, turn.id)
                                ? () => onSaveExample(turn.id)
                                : null
                        }
                    />
                );
            })}
        </div>
    );
}
