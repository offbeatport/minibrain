import { useRouter } from "@tanstack/react-router";
import {
    Button,
    Card,
    EmptyState,
    Kbd,
    Link,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    Textarea,
} from "obp-ui";
import {
    type FormEvent,
    type KeyboardEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { usePlaygroundModels } from "~/api/playgroundQueries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page } from "~/components/Section";
import { useSearchParam } from "~/lib/listSearch";
import {
    type AssistantTurn,
    DEFAULT_SETTINGS,
    type Settings,
    type Target,
    type ToolCall,
    type Turn,
    messagesOf,
    newId,
    requestBody,
    streamChat,
} from "~/lib/playground";
import { Conversation } from "./playground/Conversation";
import { SettingsPanel } from "./playground/SettingsPanel";
import { ViewCode } from "./playground/ViewCode";

const STORAGE_KEY = "minibrain.playground.model";
const WIDE = "(min-width: 1024px)";

function remembered(): string | null {
    try {
        return window.localStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
}

function remember(name: string): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, name);
    } catch {
        return;
    }
}

function useWide(): boolean {
    const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
    useEffect(() => {
        const query = window.matchMedia(WIDE);
        const update = () => setWide(query.matches);
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, []);
    return wide;
}

function chosenTarget(targets: Target[], wanted: (string | null)[]): Target | undefined {
    for (const name of wanted) {
        if (!name) {
            continue;
        }
        const exact = targets.find((item) => item.name === name);
        if (exact) {
            return exact;
        }
        const versions = targets.filter((item) => item.kind === "custom" && item.key === name);
        const latest = versions.sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
        if (latest) {
            return latest;
        }
    }
    return targets[0];
}

function assistantTurn(json: boolean): AssistantTurn {
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
        json,
    };
}

function answered(turns: Turn[], call: ToolCall): boolean {
    const owner = [...turns]
        .reverse()
        .find(
            (turn) => turn.kind === "assistant" && turn.calls.some((item) => item.id === call.id),
        );
    if (!owner || owner.kind !== "assistant") {
        return false;
    }
    const results = new Set(turns.flatMap((turn) => (turn.kind === "tool" ? [turn.callId] : [])));
    return owner.calls.every((item) => results.has(item.id));
}

function Composer({
    busy,
    disabled,
    onSend,
    onStop,
}: {
    busy: boolean;
    disabled: boolean;
    onSend: (text: string) => void;
    onStop: () => void;
}) {
    const [text, setText] = useState("");
    const submit = (event?: FormEvent) => {
        event?.preventDefault();
        if (text.trim() && !busy) {
            onSend(text.trim());
            setText("");
        }
    };
    const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
        }
    };
    return (
        <form onSubmit={submit} className="flex flex-col gap-2 border-t p-4">
            <Textarea
                value={text}
                rows={3}
                disabled={disabled}
                placeholder="Type a message"
                aria-label="Message"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={keys}
            />
            <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">
                    <Kbd>Ctrl</Kbd> <Kbd>Enter</Kbd> sends
                </span>
                {busy ? (
                    <Button type="button" variant="outline" onClick={onStop}>
                        Stop
                    </Button>
                ) : (
                    <Button type="submit" disabled={disabled || !text.trim()}>
                        Send
                    </Button>
                )}
            </div>
        </form>
    );
}

export function PlaygroundPage() {
    const router = useRouter();
    const requested = useSearchParam("model");
    const models = usePlaygroundModels();
    const targets = models.data?.targets ?? [];
    const guards = models.data?.guards ?? [];
    const [picked, setPicked] = useState<string | null>(null);
    const target = chosenTarget(targets, [picked, requested, remembered()]);
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
    const [turns, setTurns] = useState<Turn[]>([]);
    const [busy, setBusy] = useState(false);
    const [panel, setPanel] = useState(true);
    const [drawer, setDrawer] = useState(false);
    const wide = useWide();
    const aborter = useRef<AbortController | null>(null);
    const end = useRef<HTMLDivElement | null>(null);
    const pick = (name: string) => {
        setPicked(name);
        remember(name);
        router.history.replace(`/playground?model=${encodeURIComponent(name)}`);
    };
    const loadSettings = useCallback((next: Settings) => setSettings(next), []);
    const update = (id: string, change: Partial<AssistantTurn>) =>
        setTurns((all) =>
            all.map((turn) =>
                turn.id === id && turn.kind === "assistant" ? { ...turn, ...change } : turn,
            ),
        );
    const ask = async (conversation: Turn[]) => {
        if (!target) {
            return;
        }
        const json = settings.response_format !== "text" || target.contract === "json";
        const reply = assistantTurn(json);
        setTurns([...conversation, reply]);
        setBusy(true);
        const controller = new AbortController();
        aborter.current = controller;
        const started = performance.now();
        const body = { ...requestBody(target.name, settings, messagesOf(conversation), target) };
        try {
            const done = await streamChat(body, controller.signal, (progress) =>
                update(reply.id, {
                    content: progress.content,
                    reasoning: progress.reasoning,
                    calls: progress.calls,
                    refusal: progress.refusal,
                }),
            );
            update(reply.id, {
                content: done.content,
                reasoning: done.reasoning,
                calls: done.calls,
                refusal: done.refusal,
                streaming: false,
                meta: {
                    model: target.name,
                    latencyMs: performance.now() - started,
                    promptTokens: done.promptTokens,
                    completionTokens: done.completionTokens,
                    finishReason: done.finishReason,
                    responseId: done.id,
                },
            });
        } catch (error) {
            const stopped = controller.signal.aborted;
            update(reply.id, {
                streaming: false,
                error: stopped
                    ? "Stopped."
                    : error instanceof Error
                      ? error.message
                      : String(error),
            });
        } finally {
            aborter.current = null;
            setBusy(false);
        }
    };
    const send = (text: string) => ask([...turns, { kind: "user", id: newId(), content: text }]);
    const toolResult = (call: ToolCall, text: string) => {
        const next: Turn[] = [
            ...turns,
            { kind: "tool", id: newId(), callId: call.id, name: call.name, content: text },
        ];
        if (answered(next, call)) {
            ask(next);
        } else {
            setTurns(next);
        }
    };
    useEffect(() => {
        if (turns.length > 0) {
            end.current?.scrollIntoView({ block: "end" });
        }
    }, [turns]);
    const preview = useMemo(
        () =>
            requestBody(
                target?.name ?? "",
                settings,
                messagesOf(turns).concat({ role: "user", content: "Your message" }),
                target,
            ),
        [target, settings, turns],
    );
    const panelBody = target && (
        <SettingsPanel
            targets={targets}
            guards={guards}
            target={target}
            model={target.name}
            onModel={pick}
            settings={settings}
            onSettings={loadSettings}
        />
    );
    const showSettings = () => (wide ? setPanel((open) => !open) : setDrawer(true));
    return (
        <Page wide>
            <PageHeader
                title="Playground"
                caption="Chat with any of your models or installed bases, with the settings the API takes."
                actions={
                    target && (
                        <div className="flex flex-wrap gap-2">
                            <Button
                                variant="outline"
                                disabled={busy || turns.length === 0}
                                onClick={() => setTurns([])}
                            >
                                New chat
                            </Button>
                            <ViewCode body={preview} disabled={!target} />
                            <Button
                                variant="outline"
                                aria-expanded={wide ? panel : drawer}
                                onClick={showSettings}
                            >
                                {wide && panel ? "Hide settings" : "Settings"}
                            </Button>
                        </div>
                    )
                }
            />
            <ErrorLine error={models.error} />
            {models.data && targets.length === 0 && (
                <EmptyState
                    variant="panel"
                    title="Nothing to chat with yet"
                    action={
                        <Button asChild>
                            <Link href="/models/new">Add a model</Link>
                        </Button>
                    }
                >
                    Add a model, or download a base from Discover, then try it here.
                </EmptyState>
            )}
            {target && (
                <div
                    className={
                        wide && panel
                            ? "grid grid-cols-[minmax(0,1fr)_22rem] items-start gap-4"
                            : "flex flex-col"
                    }
                >
                    <Card className="flex min-h-[32rem] flex-col p-0">
                        <div className="flex-1 overflow-y-auto p-panel">
                            {turns.length === 0 ? (
                                <p className="text-sm text-muted-foreground">
                                    Send a message to {target.model_name}. Answers stream in as the
                                    model writes them, with any reasoning and tool calls shown
                                    apart.
                                </p>
                            ) : (
                                <Conversation
                                    turns={turns}
                                    target={target}
                                    busy={busy}
                                    onToolResult={toolResult}
                                />
                            )}
                            <div ref={end} />
                        </div>
                        <Composer
                            busy={busy}
                            disabled={!target}
                            onSend={send}
                            onStop={() => aborter.current?.abort()}
                        />
                    </Card>
                    {wide && panel && (
                        <Card className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto p-0">
                            {panelBody}
                        </Card>
                    )}
                </div>
            )}
            {!wide && (
                <Sheet open={drawer} onOpenChange={setDrawer}>
                    <SheetContent side="right" className="p-0">
                        <SheetHeader className="px-4 pt-4">
                            <SheetTitle>Settings</SheetTitle>
                            <SheetDescription>
                                Model, presets and what the next request sends.
                            </SheetDescription>
                        </SheetHeader>
                        {panelBody}
                    </SheetContent>
                </Sheet>
            )}
        </Page>
    );
}
