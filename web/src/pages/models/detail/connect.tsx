import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, CircleCheck, CircleX, KeyRound, Send, TriangleAlert } from "lucide-react";
import {
    Button,
    CodeBlock,
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Link,
    cn,
} from "obp-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type KeyCreated, type ModelRow, api, unwrap } from "~/api/client";
import { keys, useKeys, useModel } from "~/api/queries";
import { BlockedButton } from "~/components/BlockedButton";
import { CopyButton } from "~/components/CopyButton";
import { HarnessConfigs, SAMPLE } from "~/components/HarnessConfigs";
import { errorMessage } from "~/components/Section";
import { useCan } from "~/lib/access";
import { API_REFERENCE_PATH, modelPageHref } from "~/lib/modelLinks";
import { isDeployed } from "./header";

const KEY_PLACEHOLDER = "YOUR_KEY";

const POLL_MS = 3000;

function feedbackCurl(baseUrl: string, model: string, key: string, kept: boolean): string {
    const body = {
        model,
        response_id: "chatcmpl-abc123",
        rating: "down",
        correction: "billing",
        ...(kept ? {} : { input: "I was charged twice" }),
    };
    return [
        `curl ${baseUrl}/feedback \\`,
        `  -H "Authorization: Bearer ${key}" \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '${JSON.stringify(body, null, 4).replaceAll("\n", "\n  ")}'`,
    ].join("\n");
}

type TestResult = { ok: true; answer: string; ms: number } | { ok: false; message: string };

function keyName(model: string): string {
    const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    return `${model} · ${stamp}`;
}

function failureText(status: number, model: string, detail: string): string {
    if (status === 401) {
        return "The key was not accepted. It may be revoked or expired.";
    }
    if (status === 403) {
        return `This key does not cover ${model}.`;
    }
    return detail || `The call failed with status ${status}.`;
}

async function sendTest(baseUrl: string, model: string, secret: string): Promise<TestResult> {
    const started = performance.now();
    const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model,
            messages: [{ role: "user", content: SAMPLE }],
            max_tokens: 64,
        }),
    });
    const ms = Math.round(performance.now() - started);
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        const detail = data?.error?.message ?? data?.detail ?? "";
        return { ok: false, message: failureText(response.status, model, String(detail)) };
    }
    const answer = String(data?.choices?.[0]?.message?.content ?? "").trim();
    return { ok: true, answer, ms };
}

function useNewestRequest(model: string, open: boolean) {
    return useQuery({
        queryKey: ["requests", "newest", model],
        queryFn: () =>
            unwrap(api.GET("/api/requests", { params: { query: { model: [model], limit: 1 } } })),
        enabled: open,
        refetchInterval: open ? POLL_MS : false,
    });
}

type StepState = "done" | "current" | "next";

function StepMarker({ number, state }: { number: number; state: StepState }) {
    return (
        <span
            className={cn(
                "grid size-6 shrink-0 place-items-center rounded-md border text-sm font-medium tabular-nums",
                state === "done" && "border-success/40 text-success",
                state === "current" && "border-primary bg-primary text-primary-foreground",
                state === "next" && "border-input text-muted-foreground",
            )}
        >
            {state === "done" ? <Check aria-hidden="true" className="size-3.5" /> : number}
            <span className="sr-only">{state === "done" ? `Step ${number}, done` : ""}</span>
        </span>
    );
}

function Step({
    number,
    state,
    title,
    aside,
    last = false,
    children,
}: {
    number: number;
    state: StepState;
    title: string;
    aside?: ReactNode;
    last?: boolean;
    children: ReactNode;
}) {
    return (
        <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-4">
            <div className="flex flex-col items-center">
                <StepMarker number={number} state={state} />
                {!last && <span aria-hidden="true" className="mt-2 w-px flex-1 bg-border" />}
            </div>
            <section className={cn("flex min-w-0 flex-col gap-3", !last && "pb-5")}>
                <div className="flex min-h-6 items-center justify-between gap-3">
                    <h3 className="font-medium">{title}</h3>
                    {aside}
                </div>
                {children}
            </section>
        </li>
    );
}

function Endpoint({ baseUrl, model }: { baseUrl: string; model: string }) {
    const cells = [
        { label: "Base URL", value: baseUrl },
        { label: "Model", value: model },
    ];
    return (
        <dl className="grid min-w-0 grid-cols-[3fr_2fr] divide-x rounded-md border">
            {cells.map((cell) => (
                <div key={cell.label} className="flex h-9 min-w-0 items-center gap-3 pr-0.5 pl-3">
                    <dt className="shrink-0 text-sm text-muted-foreground">{cell.label}</dt>
                    <dd className="min-w-0 flex-1 truncate font-mono text-sm">{cell.value}</dd>
                    <CopyButton value={cell.value} label={`Copy ${cell.label.toLowerCase()}`} />
                </div>
            ))}
        </dl>
    );
}

function covers(
    row: ModelRow,
    key: { all_models: boolean; models: { kind: string; key: string }[] },
) {
    return key.all_models || key.models.some((m) => m.kind === row.kind && m.key === row.key);
}

function ExistingKeys({
    row,
    href,
    onLeave,
}: { row: ModelRow; href: string; onLeave: () => void }) {
    const list = useKeys();
    const count = (list.data ?? []).filter(
        (key) => key.status === "active" && covers(row, key),
    ).length;
    return (
        <span className="text-muted-foreground">
            {"or use an existing key from "}
            <Link href={href} onClick={onLeave} className="text-primary hover:underline">
                API keys
            </Link>
            {count > 0 && (
                <span className="tabular-nums">{` · ${count} ${count === 1 ? "covers" : "cover"} this model`}</span>
            )}
        </span>
    );
}

function NewKey({ secret }: { secret: string }) {
    return (
        <div className="flex h-9 min-w-0 items-center gap-3 rounded-md border bg-muted pr-0.5 pl-3">
            <KeyRound aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{secret}</span>
            <CopyButton value={secret} label="Copy the API key" />
        </div>
    );
}

function KeyStep({
    row,
    secret,
    onCreated,
    keysHref,
    onLeave,
}: {
    row: ModelRow;
    secret: string | null;
    onCreated: (key: KeyCreated) => void;
    keysHref: string;
    onLeave: () => void;
}) {
    const can = useCan();
    const client = useQueryClient();
    const create = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/keys", {
                    body: {
                        name: keyName(row.key),
                        all_models: false,
                        models: [{ kind: row.kind, key: row.key }],
                    },
                }),
            ),
        onSuccess: async (created) => {
            onCreated(created);
            await client.invalidateQueries({ queryKey: keys.apiKeys });
        },
    });
    if (secret) {
        return <NewKey secret={secret} />;
    }
    if (!can.build) {
        return (
            <p className="text-muted-foreground">
                Ask a Builder for a key that covers this model, and use it in place of{" "}
                <span className="font-mono text-foreground">{KEY_PLACEHOLDER}</span>.
            </p>
        );
    }
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button type="button" disabled={create.isPending} onClick={() => create.mutate()}>
                    <KeyRound aria-hidden="true" />
                    {create.isPending ? "Creating…" : "Create a key"}
                </Button>
                <ExistingKeys row={row} href={keysHref} onLeave={onLeave} />
            </div>
            {create.error && (
                <span className="text-sm text-destructive">{errorMessage(create.error)}</span>
            )}
        </div>
    );
}

function FeedbackSample({
    row,
    baseUrl,
    keyValue,
}: {
    row: ModelRow;
    baseUrl: string;
    keyValue: string;
}) {
    const detail = useModel(row.kind === "custom" ? row.key : "");
    const kept = detail.data?.request_bodies.kept ?? false;
    return (
        <CodeBlock
            code={feedbackCurl(baseUrl, row.key, keyValue, kept)}
            language="bash"
            title="POST /v1/feedback"
            copyLabel="Copy the feedback call"
        />
    );
}

function Feedback({
    row,
    baseUrl,
    keyValue,
}: {
    row: ModelRow;
    baseUrl: string;
    keyValue: string;
}) {
    const [open, setOpen] = useState(false);
    return (
        <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-3">
            <CollapsibleTrigger className="self-start font-normal text-muted-foreground hover:text-foreground">
                Rate answers from your app; corrections become training data
            </CollapsibleTrigger>
            <CollapsibleContent>
                {open && <FeedbackSample row={row} baseUrl={baseUrl} keyValue={keyValue} />}
            </CollapsibleContent>
        </Collapsible>
    );
}

function useLiveCheck(row: ModelRow, baseUrl: string, secret: string | null, open: boolean) {
    const newest = useNewestRequest(row.key, open);
    const baseline = useRef<number | null | undefined>(undefined);
    const [test, setTest] = useState<TestResult | null>(null);
    const send = useMutation({
        mutationFn: () => sendTest(baseUrl, row.key, secret ?? ""),
        onSuccess: (result) => {
            setTest(result);
            void newest.refetch();
        },
        onError: (error) =>
            setTest({ ok: false, message: errorMessage(error) ?? "The call failed." }),
    });
    useEffect(() => {
        if (!open) {
            baseline.current = undefined;
            setTest(null);
        }
    }, [open]);
    const latest = newest.data?.items[0];
    if (baseline.current === undefined && newest.data) {
        baseline.current = latest?.id ?? null;
    }
    const arrived =
        latest && baseline.current !== undefined && latest.id !== baseline.current ? latest : null;
    return { arrived, test, send };
}

type LiveCheckState = ReturnType<typeof useLiveCheck>;

function StatusLine({
    tone,
    icon,
    text,
    detail,
}: {
    tone: string;
    icon: ReactNode;
    text: string;
    detail?: string | null;
}) {
    return (
        <div className="flex min-w-0 items-start gap-2.5">
            <span className={cn("flex h-5 shrink-0 items-center", tone)}>{icon}</span>
            <div className="flex min-w-0 flex-col gap-0.5">
                <span className={cn("truncate", tone)}>{text}</span>
                {detail && (
                    <span className="truncate text-sm text-muted-foreground tabular-nums">
                        {detail}
                    </span>
                )}
            </div>
        </div>
    );
}

function LiveStatus({
    row,
    check,
    canTest,
}: {
    row: ModelRow;
    check: LiveCheckState;
    canTest: boolean;
}) {
    const { arrived, test } = check;
    if (test && !test.ok) {
        return (
            <StatusLine
                tone="text-destructive"
                icon={<CircleX aria-hidden="true" className="size-4" />}
                text={test.message}
            />
        );
    }
    if (arrived || test?.ok) {
        const latency = arrived ? `${Math.round(arrived.latency_ms)} ms` : null;
        const detail = test?.ok
            ? [test.answer ? `Answered “${test.answer}”` : "Answered", latency ?? `${test.ms} ms`]
            : [latency, arrived?.key_name ? `key ${arrived.key_name}` : null];
        return (
            <StatusLine
                tone="text-success"
                icon={<CircleCheck aria-hidden="true" className="size-4" />}
                text={arrived ? "Connected: a request arrived" : "Connected"}
                detail={detail.filter(Boolean).join(" · ")}
            />
        );
    }
    const deployed = isDeployed(row);
    return (
        <StatusLine
            tone="text-muted-foreground"
            icon={
                <span
                    aria-hidden="true"
                    className="size-2 animate-pulse rounded-full bg-muted-foreground motion-reduce:animate-none"
                />
            }
            text={deployed ? "Waiting for the first request…" : "Not deployed yet"}
            detail={
                deployed
                    ? canTest
                        ? "Run the code above, or send a test request from here."
                        : "Run the code above; this turns green when the call arrives."
                    : "Calls are refused until you deploy it."
            }
        />
    );
}

function blockedReason(row: ModelRow, secret: string | null, build: boolean): string | null {
    if (!isDeployed(row)) {
        return "Deploy it first; calls are refused until then.";
    }
    if (secret) {
        return null;
    }
    return build
        ? "Create a key first; the test uses it."
        : "The test needs a key created here; run the code with yours instead.";
}

function LiveCheck({
    row,
    check,
    secret,
}: {
    row: ModelRow;
    check: LiveCheckState;
    secret: string | null;
}) {
    const can = useCan();
    const blocked = blockedReason(row, secret, can.build);
    const { send } = check;
    const label = send.isPending ? "Sending…" : "Send test request";
    return (
        <div className="flex min-w-0 items-center justify-between gap-4 rounded-md border py-2.5 pr-2.5 pl-3">
            <div aria-live="polite" className="min-w-0 flex-1">
                <LiveStatus row={row} check={check} canTest={!blocked} />
            </div>
            {blocked ? (
                <BlockedButton reason={blocked} variant="outline">
                    <Send aria-hidden="true" />
                    {label}
                </BlockedButton>
            ) : (
                <Button
                    type="button"
                    variant="outline"
                    disabled={send.isPending}
                    onClick={() => send.mutate()}
                >
                    <Send aria-hidden="true" />
                    {label}
                </Button>
            )}
        </div>
    );
}

function stepStates(secret: string | null, connected: boolean): [StepState, StepState, StepState] {
    if (connected) {
        return ["done", "done", "done"];
    }
    return secret ? ["done", "current", "next"] : ["current", "next", "next"];
}

export function ConnectDialog({
    row,
    open,
    onOpenChange,
    keyValue = null,
}: {
    row: ModelRow;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    keyValue?: string | null;
}) {
    const baseUrl = `${window.location.origin}/v1`;
    const [created, setCreated] = useState<KeyCreated | null>(null);
    const secret = keyValue ?? created?.secret ?? null;
    const key = secret ?? KEY_PLACEHOLDER;
    const keysHref = modelPageHref(row.key, "api");
    const check = useLiveCheck(row, baseUrl, secret, open);
    const connected = Boolean(check.arrived) || Boolean(check.test?.ok);
    const [keyState, codeState, checkState] = stepStates(secret, connected);
    const close = () => {
        setCreated(null);
        onOpenChange(false);
    };
    return (
        <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
            <DialogContent className="flex flex-col gap-0 p-0 sm:max-w-3xl">
                <DialogHeader className="gap-3 border-b p-7 pb-6">
                    <DialogTitle>{`Connect to ${row.name}`}</DialogTitle>
                    <DialogDescription>
                        An OpenAI-compatible endpoint: any OpenAI client or tool works with these
                        two values and a key.
                    </DialogDescription>
                    <div className="pt-2">
                        <Endpoint baseUrl={baseUrl} model={row.key} />
                    </div>
                </DialogHeader>
                <ol className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
                    <Step
                        number={1}
                        state={keyState}
                        title={secret ? "Your API key" : "Get an API key"}
                        aside={
                            secret && (
                                <span className="flex items-center gap-1.5 text-sm text-warning">
                                    <TriangleAlert aria-hidden="true" className="size-3.5" />
                                    Shown once: copy it now
                                </span>
                            )
                        }
                    >
                        <KeyStep
                            row={row}
                            secret={secret}
                            onCreated={setCreated}
                            keysHref={keysHref}
                            onLeave={close}
                        />
                    </Step>
                    <Step
                        number={2}
                        state={codeState}
                        title="Add it to your code"
                        aside={
                            <span className="text-sm text-muted-foreground">
                                {secret ? (
                                    "Your key is filled in"
                                ) : (
                                    <>
                                        {"Replace "}
                                        <span className="font-mono text-foreground">
                                            {KEY_PLACEHOLDER}
                                        </span>
                                        {" with your key"}
                                    </>
                                )}
                            </span>
                        }
                    >
                        <HarnessConfigs
                            baseUrl={baseUrl}
                            model={row.key}
                            keyValue={secret}
                            hint={false}
                        />
                        <Feedback row={row} baseUrl={baseUrl} keyValue={key} />
                    </Step>
                    <Step number={3} state={checkState} title="Check the connection" last>
                        <LiveCheck row={row} check={check} secret={secret} />
                    </Step>
                </ol>
                <DialogFooter className="border-t px-7 py-4 sm:justify-between">
                    <Button variant="ghost" asChild>
                        <Link href={API_REFERENCE_PATH} onClick={close}>
                            <BookOpen aria-hidden="true" />
                            API reference
                        </Link>
                    </Button>
                    <Button onClick={close}>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
