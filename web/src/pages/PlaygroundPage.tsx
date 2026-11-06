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
import { useOpenChat, usePlaygroundModels, usePresets, useSaveChat } from "~/api/playgroundQueries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page } from "~/components/Section";
import { useCan } from "~/lib/access";
import { useSearchParam } from "~/lib/listSearch";
import {
    type AssistantTurn,
    DEFAULT_SETTINGS,
    type Settings,
    type ToolCall,
    type Turn,
    carriedTurns,
    chatState,
    chosenTarget,
    exampleTurns,
    lastAnswer,
    messagesOf,
    newId,
    requestBody,
    settingsOf,
    streamChat,
    turnsOf,
} from "~/lib/playground";
import { Conversation } from "./playground/Conversation";
import { Recent } from "./playground/Recent";
import { SaveExample } from "./playground/SaveExample";
import { SettingsPanel } from "./playground/SettingsPanel";
import { ViewCode } from "./playground/ViewCode";

const STORAGE_KEY = "minibrain.playground.model";
const WIDE = "(min-width: 1024px)";
const WIDEST = "(min-width: 1280px)";
const SAVE_DELAY_MS = 600;

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

function useMedia(media: string): boolean {
    const [matches, setMatches] = useState(() => window.matchMedia(media).matches);
    useEffect(() => {
        const query = window.matchMedia(media);
        const update = () => setMatches(query.matches);
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, [media]);
    return matches;
}

function playgroundUrl(model: string | null, chat: number | null): string {
    const params = new URLSearchParams();
    if (model) {
        params.set("model", model);
    }
    if (chat !== null) {
        params.set("chat", String(chat));
    }
    const query = params.toString();
    return query ? `/playground?${query}` : "/playground";
}

function gridColumns(recent: boolean, settings: boolean): string {
    if (recent && settings) {
        return "grid grid-cols-[16rem_minmax(0,1fr)_22rem] items-start gap-4";
    }
    if (recent) {
        return "grid grid-cols-[16rem_minmax(0,1fr)] items-start gap-4";
    }
    return settings ? "grid grid-cols-[minmax(0,1fr)_22rem] items-start gap-4" : "flex flex-col";
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
    const can = useCan();
    const requested = useSearchParam("model");
    const requestedChat = useSearchParam("chat");
    const models = usePlaygroundModels();
    const presets = usePresets();
    const saveChat = useSaveChat();
    const openChat = useOpenChat();
    const targets = models.data?.targets ?? [];
    const guards = models.data?.guards ?? [];
    const [picked, setPicked] = useState<string | null>(null);
    const target = chosenTarget(targets, [picked, requested, remembered()]);
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
    const [preset, setPreset] = useState<number | null>(null);
    const [turns, setTurns] = useState<Turn[]>(() => carriedTurns(router.state.location.state));
    const [chatId, setChatId] = useState<number | null>(null);
    const [openedModel, setOpenedModel] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [panel, setPanel] = useState(true);
    const [drawer, setDrawer] = useState(false);
    const [recentPanel, setRecentPanel] = useState(true);
    const [recentDrawer, setRecentDrawer] = useState(false);
    const [exampleFor, setExampleFor] = useState<string | null>(null);
    const wide = useMedia(WIDE);
    const widest = useMedia(WIDEST);
    const aborter = useRef<AbortController | null>(null);
    const end = useRef<HTMLDivElement | null>(null);
    const lastSaved = useRef<string | null>(null);
    const justOpened = useRef(false);
    const defaulted = useRef(false);
    const startChat = useRef(requestedChat);
    const pick = (name: string) => {
        setPicked(name);
        setOpenedModel(null);
        remember(name);
        router.history.replace(playgroundUrl(name, chatId));
    };
    const loadSettings = useCallback((next: Settings) => setSettings(next), []);
    useEffect(() => {
        if (defaulted.current || !presets.data) {
            return;
        }
        defaulted.current = true;
        const preferred = presets.data.find((item) => item.is_default);
        if (preferred && !startChat.current) {
            setPreset(preferred.id);
            setSettings(settingsOf(preferred.settings));
        }
    }, [presets.data]);
    const open = useCallback(
        (id: number) => {
            aborter.current?.abort();
            defaulted.current = true;
            openChat.mutate(id, {
                onSuccess: (chat) => {
                    justOpened.current = true;
                    setTurns(turnsOf(chat.state));
                    setSettings(settingsOf(chat.state.settings));
                    setPreset(chat.state.preset ?? null);
                    setChatId(chat.id);
                    setOpenedModel(chat.model);
                    setPicked(chat.model);
                    setRecentDrawer(false);
                    router.history.replace(playgroundUrl(chat.model, chat.id));
                },
            });
        },
        [openChat.mutate, router.history],
    );
    useEffect(() => {
        const wanted = Number(startChat.current);
        if (Number.isInteger(wanted) && wanted > 0) {
            open(wanted);
        }
    }, [open]);
    const newChat = () => {
        aborter.current?.abort();
        setTurns([]);
        setChatId(null);
        setOpenedModel(null);
        lastSaved.current = null;
        setRecentDrawer(false);
        router.history.replace(playgroundUrl(target?.name ?? null, null));
    };
    const state = useMemo(() => chatState(turns, settings, preset), [turns, settings, preset]);
    const creating = saveChat.isPending && chatId === null;
    const saveMutate = saveChat.mutate;
    useEffect(() => {
        if (!target || busy || creating || turns.length === 0) {
            return;
        }
        const key = JSON.stringify({ chatId, model: target.name, state });
        if (justOpened.current) {
            justOpened.current = false;
            lastSaved.current = key;
            return;
        }
        if (!target.chats_saved || key === lastSaved.current) {
            return;
        }
        const timer = window.setTimeout(() => {
            lastSaved.current = key;
            saveMutate(
                { id: chatId, model: target.name, version: target.version ?? null, state },
                {
                    onSuccess: (saved) => {
                        if (chatId === null) {
                            lastSaved.current = JSON.stringify({
                                chatId: saved.id,
                                model: target.name,
                                state,
                            });
                            setChatId(saved.id);
                            router.history.replace(playgroundUrl(target.name, saved.id));
                        }
                    },
                    onError: () => {
                        lastSaved.current = null;
                    },
                },
            );
        }, SAVE_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [target, busy, creating, turns.length, chatId, state, saveMutate, router.history]);
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
    const examples = target?.kind === "custom" && can.build;
    const last = lastAnswer(turns);
    const wholeChat = examples && last && exampleTurns(turns, last.id) ? last : null;
    const missing =
        openedModel && models.data && !targets.some((item) => item.name === openedModel)
            ? `${openedModel} is not available any more, so answers now come from ${target?.model_name ?? "another model"}.`
            : null;
    const panelBody = target && (
        <SettingsPanel
            targets={targets}
            guards={guards}
            target={target}
            model={target.name}
            onModel={pick}
            settings={settings}
            onSettings={loadSettings}
            preset={preset}
            onPreset={setPreset}
        />
    );
    const recentBody = (titled: boolean) => (
        <Recent
            titled={titled}
            current={chatId}
            note={target && !target.chats_saved ? (target.chats_note ?? null) : null}
            onOpen={open}
            onNew={newChat}
            onDeleted={(id) => id === chatId && newChat()}
            busy={busy}
        />
    );
    const showSettings = () => (wide ? setPanel((shown) => !shown) : setDrawer(true));
    const showRecent = () => (widest ? setRecentPanel((shown) => !shown) : setRecentDrawer(true));
    const recentColumn = widest && recentPanel;
    const settingsColumn = wide && panel;
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
                                aria-expanded={widest ? recentPanel : recentDrawer}
                                onClick={showRecent}
                            >
                                {recentColumn ? "Hide recent" : "Recent"}
                            </Button>
                            <Button
                                variant="outline"
                                disabled={busy || turns.length === 0}
                                onClick={newChat}
                            >
                                New chat
                            </Button>
                            {examples && (
                                <Button
                                    variant="outline"
                                    disabled={busy || !wholeChat}
                                    onClick={() => wholeChat && setExampleFor(wholeChat.id)}
                                >
                                    Save as test example
                                </Button>
                            )}
                            <ViewCode body={preview} disabled={!target} />
                            <Button
                                variant="outline"
                                aria-expanded={wide ? panel : drawer}
                                onClick={showSettings}
                            >
                                {settingsColumn ? "Hide settings" : "Settings"}
                            </Button>
                        </div>
                    )
                }
            />
            <ErrorLine error={models.error ?? openChat.error ?? saveChat.error} />
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
                <div className={gridColumns(recentColumn, settingsColumn)}>
                    {recentColumn && (
                        <Card className="sticky top-4 flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden p-0">
                            {recentBody(true)}
                        </Card>
                    )}
                    <Card className="flex min-h-[32rem] flex-col p-0">
                        <div className="flex-1 overflow-y-auto p-panel">
                            {missing && (
                                <p className="mb-4 text-sm text-muted-foreground">{missing}</p>
                            )}
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
                                    onSaveExample={examples ? setExampleFor : null}
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
                    {settingsColumn && (
                        <Card className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto p-0">
                            {panelBody}
                        </Card>
                    )}
                </div>
            )}
            {target && (
                <SaveExample
                    key={exampleFor ?? "closed"}
                    target={target}
                    turns={turns}
                    answerId={exampleFor}
                    onClose={() => setExampleFor(null)}
                />
            )}
            {!widest && (
                <Sheet open={recentDrawer} onOpenChange={setRecentDrawer}>
                    <SheetContent side="left" className="flex flex-col p-0">
                        <SheetHeader className="px-4 pt-4">
                            <SheetTitle>Recent</SheetTitle>
                            <SheetDescription>Your saved chats, for you alone.</SheetDescription>
                        </SheetHeader>
                        {recentBody(false)}
                    </SheetContent>
                </Sheet>
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
