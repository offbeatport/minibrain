import { Button, CodeBlock, CopyButton, Label, Markdown, Textarea } from "obp-ui";
import {
    ChatActions,
    ChatBubble,
    ChatMeta,
    ChatNotice,
    ChatPending,
    ChatReasoning,
    ChatToolCall,
} from "obp-ui/chat";
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

function ToolResultForm({
    call,
    onResult,
    busy,
}: {
    call: ToolCall;
    onResult: (text: string) => void;
    busy: boolean;
}) {
    const [draft, setDraft] = useState("");
    const field = `tool-result-${call.id}`;
    return (
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
    );
}

function metaItems(turn: AssistantTurn) {
    const meta = turn.meta;
    if (!meta) {
        return [];
    }
    return [
        <span key="model" className="font-mono">
            {meta.model}
        </span>,
        milliseconds(meta.latencyMs),
        `${count(meta.promptTokens)} in · ${count(meta.completionTokens)} out`,
        meta.finishReason,
    ];
}

function Actions({
    turn,
    json,
    busy,
    target,
    input,
    onSaveExample,
}: {
    turn: AssistantTurn;
    json: boolean;
    busy: boolean;
    target: Target | undefined;
    input: string;
    onSaveExample: (() => void) | null;
}) {
    const copy = turn.content && !json && (
        <CopyButton text={turn.content} label="Copy the answer" variant="ghost" size="icon" />
    );
    if (target?.kind !== "custom" || !turn.meta) {
        return copy ? <ChatActions>{copy}</ChatActions> : null;
    }
    return (
        <AnswerFeedback
            slug={target.key}
            input={input}
            reply={{ id: turn.meta.responseId, model: target.name, output: turn.content }}
            labels={target.labels}
            actions={
                <>
                    {copy}
                    {onSaveExample && (
                        <Button variant="ghost" onClick={onSaveExample} disabled={busy}>
                            Save as test example
                        </Button>
                    )}
                </>
            }
        />
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
        <ChatBubble variant="plain" role="assistant" busy={turn.streaming}>
            {turn.reasoning && (
                <ChatReasoning text={turn.reasoning} streaming={turn.streaming && !turn.content} />
            )}
            {turn.refusal && (
                <ChatNotice tone="warning" label="Blocked">
                    {turn.refusal}
                </ChatNotice>
            )}
            {json ? (
                <CodeBlock code={json} language="json" copyLabel="Copy the answer" />
            ) : (
                turn.content && <Markdown content={turn.content} className="text-base" />
            )}
            {turn.streaming && !turn.content && !turn.reasoning && turn.calls.length === 0 && (
                <ChatPending />
            )}
            {turn.calls.map((call) => (
                <ChatToolCall
                    key={call.id || call.name}
                    name={call.name}
                    id={call.id}
                    args={call.arguments}
                    result={results[call.id]}
                >
                    <ToolResultForm
                        call={call}
                        onResult={(text) => onResult(call, text)}
                        busy={busy}
                    />
                </ChatToolCall>
            ))}
            {turn.error && <ChatNotice tone="destructive">{turn.error}</ChatNotice>}
            <ChatMeta items={metaItems(turn)} />
            {answered && (
                <Actions
                    turn={turn}
                    json={json !== null}
                    busy={busy}
                    target={target}
                    input={input}
                    onSaveExample={onSaveExample}
                />
            )}
        </ChatBubble>
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
    return turns.map((turn) => {
        if (turn.kind === "user") {
            input = turn.content;
            return <ChatBubble key={turn.id} variant="plain" role="user" text={turn.content} />;
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
    });
}
