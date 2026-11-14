import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, CircleCheck, CircleX, KeyRound, Send, ThumbsUp } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Link,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { useEffect, useRef, useState } from "react";
import { type KeyCreated, type ModelRow, api, unwrap } from "~/api/client";
import { keys, useModel } from "~/api/queries";
import { CopyButton } from "~/components/CopyButton";
import { HarnessConfigs, SAMPLE } from "~/components/HarnessConfigs";
import { errorMessage } from "~/components/Section";
import { useCan } from "~/lib/access";
import { API_REFERENCE_PATH, modelPageHref } from "~/lib/modelLinks";
import { isDeployed } from "./header";

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

function Copyable({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex min-w-0 flex-col gap-label">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="flex h-8 min-w-0 items-center gap-1 rounded-md border bg-muted pr-0.5 pl-3">
                <span className="flex-1 truncate font-mono text-sm">{value}</span>
                <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
            </span>
        </div>
    );
}

type TestResult = { ok: true; answer: string; ms: number } | { ok: false; message: string };

const POLL_MS = 3000;

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
        return (
            <div className="flex flex-col gap-1.5">
                <Copyable label="API key, shown once" value={secret} />
                <span className="text-sm text-muted-foreground">
                    Filled into every example below. Copy it now; it is not shown again.
                </span>
            </div>
        );
    }
    if (!can.build) {
        return (
            <p className="text-muted-foreground">
                Ask a Builder for a key that covers this model, and use it in place of{" "}
                <span className="font-mono">YOUR_KEY</span>.
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button
                    type="button"
                    variant="outline"
                    disabled={create.isPending}
                    onClick={() => create.mutate()}
                >
                    <KeyRound aria-hidden="true" />
                    {create.isPending ? "Creating…" : "Create key"}
                </Button>
                <span className="text-muted-foreground">
                    {"or use an existing key from "}
                    <Link
                        href={keysHref}
                        onClick={onLeave}
                        className="text-primary hover:underline"
                    >
                        API keys
                    </Link>
                    {" in place of "}
                    <span className="font-mono">YOUR_KEY</span>
                </span>
            </div>
            {create.error && (
                <span className="text-sm text-destructive">{errorMessage(create.error)}</span>
            )}
        </div>
    );
}

function LiveCheck({
    row,
    baseUrl,
    secret,
    open,
}: {
    row: ModelRow;
    baseUrl: string;
    secret: string | null;
    open: boolean;
}) {
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
    const deployed = isDeployed(row);
    const blocked = !deployed
        ? "Deploy it first; calls are refused until then."
        : !secret
          ? "Create a key first; the test uses it."
          : null;
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2.5">
            <div aria-live="polite" className="flex min-w-0 flex-1 flex-col gap-0.5">
                {test && !test.ok ? (
                    <span className="flex items-center gap-2 text-destructive">
                        <CircleX aria-hidden="true" className="size-4 shrink-0" />
                        {test.message}
                    </span>
                ) : arrived ? (
                    <span className="flex items-center gap-2 text-success">
                        <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
                        <span className="tabular-nums">
                            {`Connected: request received · ${Math.round(arrived.latency_ms)} ms${arrived.key_name ? ` · key ${arrived.key_name}` : ""}`}
                        </span>
                    </span>
                ) : (
                    <span className="flex items-center gap-2 text-muted-foreground">
                        <span
                            aria-hidden="true"
                            className="size-2 shrink-0 animate-pulse rounded-full bg-muted-foreground motion-reduce:animate-none"
                        />
                        {deployed
                            ? "Waiting for the first request…"
                            : "Not deployed yet: calls are refused until you deploy it."}
                    </span>
                )}
                {test?.ok && test.answer && (
                    <span className="truncate pl-6 text-sm text-muted-foreground">
                        {`Answered “${test.answer}”`}
                    </span>
                )}
            </div>
            <Tooltip>
                <TooltipTrigger asChild>
                    <span>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={Boolean(blocked) || send.isPending}
                            onClick={() => send.mutate()}
                        >
                            <Send aria-hidden="true" />
                            {send.isPending ? "Sending…" : "Send test request"}
                        </Button>
                    </span>
                </TooltipTrigger>
                {blocked && <TooltipContent>{blocked}</TooltipContent>}
            </Tooltip>
        </div>
    );
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
    const custom = row.kind === "custom";
    const detail = useModel(custom && open ? row.key : "");
    const kept = detail.data?.request_bodies.kept ?? false;
    const [created, setCreated] = useState<KeyCreated | null>(null);
    const secret = keyValue ?? created?.secret ?? null;
    const key = secret ?? "YOUR_KEY";
    const keysHref = modelPageHref(row.key, "api");
    const close = () => {
        setCreated(null);
        onOpenChange(false);
    };
    return (
        <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{`Connect to ${row.name}`}</DialogTitle>
                    <DialogDescription>
                        OpenAI-compatible, so any OpenAI client works.
                    </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 sm:grid-cols-[3fr_2fr]">
                    <Copyable label="Base URL" value={baseUrl} />
                    <Copyable label="Model" value={row.key} />
                </div>
                <KeyStep
                    row={row}
                    secret={secret}
                    onCreated={setCreated}
                    keysHref={keysHref}
                    onLeave={close}
                />
                <HarnessConfigs
                    baseUrl={baseUrl}
                    model={row.key}
                    keyValue={secret}
                    hint={false}
                    extra={[
                        {
                            id: "feedback",
                            label: "Feedback",
                            icon: <ThumbsUp />,
                            language: "bash",
                            title: "Rate an answer by its id; corrections become training data",
                            code: feedbackCurl(baseUrl, row.key, key, kept),
                        },
                    ]}
                />
                <LiveCheck row={row} baseUrl={baseUrl} secret={secret} open={open} />
                <DialogFooter className="sm:justify-between">
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
