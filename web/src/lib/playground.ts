import type { CodeLanguage } from "obp-ui";
import { apiFetch } from "~/api/client";
import type { components } from "~/api/schema";

export type Target = components["schemas"]["PlaygroundTarget"];
export type Guard = components["schemas"]["GuardInfo"];
export type SavedPreset = components["schemas"]["SavedPresetInfo"];
export type ChatSummary = components["schemas"]["ChatSummary"];
export type ChatState = components["schemas"]["ChatState"];
export type ExampleTurn = components["schemas"]["ExampleTurn"];

export type ResponseFormat = "text" | "json_object" | "json_schema";

export type FunctionSpec = {
    id: string;
    name: string;
    description: string;
    parameters: string;
};

export type Settings = {
    max_tokens: number | null;
    temperature: number | null;
    safety_model: string | null;
    safety_answers: boolean;
    reasoning: string | null;
    response_format: ResponseFormat;
    schema_name: string;
    schema: string;
    functions: FunctionSpec[];
    tool_choice: string;
    top_p: number | null;
    top_k: number | null;
    min_p: number | null;
    presence_penalty: number | null;
    frequency_penalty: number | null;
    repetition_penalty: number | null;
    stop: string[];
    seed: number | null;
};

export type ToolCall = { id: string; name: string; arguments: string };

export type Meta = {
    model: string;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    finishReason: string | null;
    responseId: string;
};

export type UserTurn = { kind: "user"; id: string; content: string };
export type ToolTurn = { kind: "tool"; id: string; callId: string; name: string; content: string };
export type AssistantTurn = {
    kind: "assistant";
    id: string;
    content: string;
    reasoning: string;
    calls: ToolCall[];
    refusal: string;
    blocked: string[];
    meta: Meta | null;
    error: string | null;
    streaming: boolean;
    json: boolean;
};
export type Turn = UserTurn | ToolTurn | AssistantTurn;

export const DEFAULT_SCHEMA = JSON.stringify(
    {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
    },
    null,
    2,
);

export const DEFAULT_PARAMETERS = JSON.stringify(
    { type: "object", properties: {}, required: [] },
    null,
    2,
);

export const DEFAULT_SETTINGS: Settings = {
    max_tokens: null,
    temperature: null,
    safety_model: null,
    safety_answers: false,
    reasoning: null,
    response_format: "text",
    schema_name: "answer",
    schema: DEFAULT_SCHEMA,
    functions: [],
    tool_choice: "auto",
    top_p: null,
    top_k: null,
    min_p: null,
    presence_penalty: null,
    frequency_penalty: null,
    repetition_penalty: null,
    stop: [],
    seed: null,
};

const SAMPLING = [
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "presence_penalty",
    "frequency_penalty",
    "repetition_penalty",
    "seed",
] as const;

export const SDK_EXTRAS = new Set(["top_k", "min_p", "repetition_penalty", "safety"]);

export function newId(): string {
    return Math.random().toString(36).slice(2, 10);
}

export function settingsOf(saved: Record<string, unknown> | undefined): Settings {
    const found = { ...DEFAULT_SETTINGS, ...(saved ?? {}) } as Settings;
    return {
        ...found,
        functions: (found.functions ?? []).map((item) => ({ ...item, id: item.id || newId() })),
    };
}

export function parsedJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

export function jsonProblem(text: string): string | null {
    try {
        const value = JSON.parse(text);
        return value && typeof value === "object" && !Array.isArray(value)
            ? null
            : "Needs a JSON object.";
    } catch (error) {
        return error instanceof Error ? error.message : "Not valid JSON.";
    }
}

function formatOf(settings: Settings): Record<string, unknown> | undefined {
    if (settings.response_format === "json_object") {
        return { type: "json_object" };
    }
    if (settings.response_format === "json_schema") {
        const schema = parsedJson(settings.schema);
        return {
            type: "json_schema",
            json_schema: {
                name: settings.schema_name || "answer",
                schema: schema ?? {},
                strict: true,
            },
        };
    }
    return undefined;
}

function toolsOf(settings: Settings): Record<string, unknown>[] {
    return settings.functions
        .filter((item) => item.name.trim())
        .map((item) => {
            const parameters = parsedJson(item.parameters);
            const described = item.description.trim()
                ? { description: item.description.trim() }
                : {};
            return {
                type: "function",
                function: {
                    name: item.name.trim(),
                    ...described,
                    ...(parameters ? { parameters } : {}),
                },
            };
        });
}

function choiceOf(settings: Settings): unknown {
    if (settings.tool_choice === "auto") {
        return undefined;
    }
    if (settings.tool_choice === "none" || settings.tool_choice === "required") {
        return settings.tool_choice;
    }
    return { type: "function", function: { name: settings.tool_choice } };
}

function safetyOf(
    settings: Settings,
    target: Target | undefined,
): Record<string, unknown> | undefined {
    if (target?.safety) {
        return settings.safety_answers && !target.safety_answers ? { answers: true } : undefined;
    }
    if (!settings.safety_model) {
        return undefined;
    }
    return { model: settings.safety_model, ...(settings.safety_answers ? { answers: true } : {}) };
}

export function messagesOf(turns: Turn[]): Record<string, unknown>[] {
    const found: Record<string, unknown>[] = [];
    for (const turn of turns) {
        if (turn.kind === "user") {
            found.push({ role: "user", content: turn.content });
        } else if (turn.kind === "tool") {
            found.push({ role: "tool", tool_call_id: turn.callId, content: turn.content });
        } else if (!turn.refusal && !turn.error && (turn.content || turn.calls.length > 0)) {
            const calls = turn.calls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
            }));
            found.push({
                role: "assistant",
                content: turn.content || null,
                ...(calls.length > 0 ? { tool_calls: calls } : {}),
            });
        }
    }
    return found;
}

export function exampleTurns(turns: Turn[], answerId: string): ExampleTurn[] | null {
    const found: ExampleTurn[] = [];
    for (const turn of turns) {
        if (turn.id === answerId) {
            return found.at(-1)?.role === "user" ? found : null;
        }
        if (turn.kind === "tool" || (turn.kind === "assistant" && turn.calls.length > 0)) {
            return null;
        }
        if (turn.kind === "user") {
            found.push({ role: "user", content: turn.content });
        } else if (turn.content && !turn.refusal && !turn.error) {
            found.push({ role: "assistant", content: turn.content });
        }
    }
    return null;
}

export function lastAnswer(turns: Turn[]): AssistantTurn | null {
    const found = turns.at(-1);
    return found?.kind === "assistant" && !found.streaming ? found : null;
}

export function chatState(turns: Turn[], settings: Settings, preset: number | null): ChatState {
    const stored = turns.map((turn) =>
        turn.kind === "assistant" && turn.streaming ? { ...turn, streaming: false } : turn,
    );
    return {
        turns: stored as unknown as ChatState["turns"],
        settings: settings as unknown as ChatState["settings"],
        preset,
    };
}

export function turnsOf(state: ChatState): Turn[] {
    return (state.turns ?? []) as unknown as Turn[];
}

export function requestBody(
    model: string,
    settings: Settings,
    messages: Record<string, unknown>[],
    target: Target | undefined,
): Record<string, unknown> {
    const body: Record<string, unknown> = { model, messages };
    if (settings.max_tokens !== null) {
        body.max_tokens = settings.max_tokens;
    }
    for (const name of SAMPLING) {
        if (settings[name] !== null) {
            body[name] = settings[name];
        }
    }
    if (settings.stop.length > 0) {
        body.stop = settings.stop;
    }
    if (settings.reasoning) {
        body.reasoning_effort = settings.reasoning;
    }
    const format = formatOf(settings);
    if (format && target?.contract === "text") {
        body.response_format = format;
    }
    const tools = toolsOf(settings);
    if (tools.length > 0 && target?.contract === "text") {
        body.tools = tools;
        const choice = choiceOf(settings);
        if (choice !== undefined) {
            body.tool_choice = choice;
        }
    }
    const safety = safetyOf(settings, target);
    if (safety) {
        body.safety = safety;
    }
    return body;
}

function pythonValue(value: unknown, depth: number): string {
    const pad = "    ".repeat(depth + 1);
    const close = "    ".repeat(depth);
    if (value === null || value === undefined) {
        return "None";
    }
    if (typeof value === "boolean") {
        return value ? "True" : "False";
    }
    if (typeof value === "number" || typeof value === "string") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return "[]";
        }
        return `[\n${value.map((item) => `${pad}${pythonValue(item, depth + 1)},`).join("\n")}\n${close}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
        return "{}";
    }
    const lines = entries.map(
        ([key, item]) => `${pad}${JSON.stringify(key)}: ${pythonValue(item, depth + 1)},`,
    );
    return `{\n${lines.join("\n")}\n${close}}`;
}

function jsValue(value: unknown, depth: number): string {
    return JSON.stringify(value, null, 4).replaceAll("\n", `\n${"    ".repeat(depth)}`);
}

export type Sample = { id: string; label: string; language: CodeLanguage; code: string };

export function samples(baseUrl: string, body: Record<string, unknown>): Sample[] {
    const curl = [
        `curl ${baseUrl}/chat/completions \\`,
        '  -H "Authorization: Bearer YOUR_KEY" \\',
        '  -H "Content-Type: application/json" \\',
        `  -d '${JSON.stringify(body, null, 2).replaceAll("'", "'\\''").replaceAll("\n", "\n  ")}'`,
    ].join("\n");
    const standard = Object.entries(body).filter(([key]) => !SDK_EXTRAS.has(key));
    const extras = Object.fromEntries(Object.entries(body).filter(([key]) => SDK_EXTRAS.has(key)));
    const pythonArgs = standard.map(([key, value]) => `    ${key}=${pythonValue(value, 1)},`);
    if (Object.keys(extras).length > 0) {
        pythonArgs.push(`    extra_body=${pythonValue(extras, 1)},`);
    }
    const python = [
        "from openai import OpenAI",
        "",
        `client = OpenAI(base_url="${baseUrl}", api_key="YOUR_KEY")`,
        "reply = client.chat.completions.create(",
        ...pythonArgs,
        ")",
        "print(reply.choices[0].message.content)",
    ].join("\n");
    const javascript = [
        'import OpenAI from "openai";',
        "",
        `const client = new OpenAI({ baseURL: "${baseUrl}", apiKey: "YOUR_KEY" });`,
        `const reply = await client.chat.completions.create(${jsValue(body, 0)});`,
        "console.log(reply.choices[0].message.content);",
    ].join("\n");
    return [
        { id: "curl", label: "curl", language: "bash", code: curl },
        { id: "python", label: "Python", language: "python", code: python },
        { id: "javascript", label: "JavaScript", language: "javascript", code: javascript },
    ];
}

type Delta = {
    content?: string | null;
    reasoning_content?: string | null;
    refusal?: string | null;
    tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
};

type Chunk = {
    id?: string;
    choices?: { delta?: Delta; finish_reason?: string | null }[];
    usage?: { prompt_tokens: number; completion_tokens: number };
    error?: { message?: string };
    safety?: { categories?: string[] };
};

export type Progress = Pick<AssistantTurn, "content" | "reasoning" | "calls" | "refusal"> & {
    id: string;
    finishReason: string | null;
    promptTokens: number;
    completionTokens: number;
};

function failure(body: unknown, status: number): string {
    const found = body as { error?: { message?: string }; detail?: unknown } | null;
    if (typeof found?.error?.message === "string") {
        return found.error.message;
    }
    if (typeof found?.detail === "string") {
        return found.detail;
    }
    if (Array.isArray(found?.detail)) {
        return found.detail
            .map((item) => (item as { msg?: string })?.msg ?? String(item))
            .join("; ");
    }
    return `Request failed (${status})`;
}

function applied(progress: Progress, chunk: Chunk): Progress {
    const next = { ...progress, calls: [...progress.calls], id: chunk.id ?? progress.id };
    if (chunk.usage) {
        next.promptTokens = chunk.usage.prompt_tokens;
        next.completionTokens = chunk.usage.completion_tokens;
    }
    for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? {};
        next.content += delta.content ?? "";
        next.reasoning += delta.reasoning_content ?? "";
        next.refusal += delta.refusal ?? "";
        for (const call of delta.tool_calls ?? []) {
            const known = next.calls[call.index] ?? { id: "", name: "", arguments: "" };
            next.calls[call.index] = {
                id: call.id || known.id,
                name: call.function?.name || known.name,
                arguments: known.arguments + (call.function?.arguments ?? ""),
            };
        }
        next.finishReason = choice.finish_reason ?? next.finishReason;
    }
    return next;
}

export async function streamChat(
    body: Record<string, unknown>,
    signal: AbortSignal,
    onProgress: (progress: Progress) => void,
): Promise<Progress> {
    const response = await apiFetch("/api/playground/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, stream: true }),
        signal,
    });
    if (!response.ok || !response.body) {
        const parsed = await response.json().catch(() => null);
        throw new Error(failure(parsed, response.status));
    }
    let progress: Progress = {
        id: "",
        content: "",
        reasoning: "",
        calls: [],
        refusal: "",
        finishReason: null,
        promptTokens: 0,
        completionTokens: 0,
    };
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
        const { value, done } = await reader.read();
        if (done) {
            return progress;
        }
        buffer += value;
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
            const data = event.replace(/^data:\s*/, "").trim();
            if (!data || data === "[DONE]") {
                continue;
            }
            const chunk = JSON.parse(data) as Chunk;
            if (chunk.error) {
                throw new Error(chunk.error.message ?? "The answer failed part way.");
            }
            progress = applied(progress, chunk);
            onProgress(progress);
        }
    }
}

export function prettyJson(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        return null;
    }
    const value = parsedJson(trimmed);
    return value === undefined ? null : JSON.stringify(value, null, 2);
}

export const REASONING_LABELS: Record<string, string> = {
    none: "Off",
    low: "Low",
    medium: "Medium",
    high: "High",
};

export function reasoningOptions(target: Target | undefined): { value: string; label: string }[] {
    if (!target || target.contract !== "text") {
        return [];
    }
    if (target.reasoning === "toggle") {
        return [
            { value: "none", label: "Off" },
            { value: "medium", label: "On" },
        ];
    }
    return target.reasoning_choices.map((value) => ({
        value,
        label: REASONING_LABELS[value] ?? value,
    }));
}

export function chosenTarget(targets: Target[], wanted: (string | null)[]): Target | undefined {
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

export function carriedTurns(state: unknown): Turn[] {
    const carried = (state as { carried?: unknown } | null)?.carried;
    return Array.isArray(carried) ? (carried as Turn[]) : [];
}
