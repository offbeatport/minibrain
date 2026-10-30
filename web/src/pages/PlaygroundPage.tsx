import { useMutation } from "@tanstack/react-query";
import {
    Button,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
} from "obp-ui";
import { ChatBubble } from "obp-ui/chat";
import { type FormEvent, useState } from "react";
import { type CompleteResponse, api, unwrap } from "~/api/client";
import { useGolden, useMinibrain, useVersions } from "~/api/queries";
import { ScopedPage } from "~/components/PageHeader";
import { ErrorLine, Section } from "~/components/Section";
import { asCode, milliseconds } from "~/lib/format";

const NONE = "none";

type Exchange = { id: number; text: string; replies: CompleteResponse[] };

function VersionPicker({
    id,
    label,
    value,
    options,
    onChange,
    allowNone,
}: {
    id: string;
    label: string;
    value: string;
    options: number[];
    onChange: (value: string) => void;
    allowNone?: boolean;
}) {
    return (
        <div className="flex flex-col gap-1">
            <Label htmlFor={id}>{label}</Label>
            <Select value={value} onValueChange={(next) => onChange(String(next ?? ""))}>
                <SelectTrigger id={id} className="w-40">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {allowNone && <SelectItem value={NONE}>None</SelectItem>}
                    {options.map((number) => (
                        <SelectItem key={number} value={String(number)}>
                            v{number}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}

function Reply({ reply }: { reply: CompleteResponse }) {
    return (
        <div className="flex flex-col gap-1">
            <ChatBubble role="assistant" text={asCode(reply.output) || "(empty)"} />
            <p className="text-sm text-muted-foreground">
                <span className="font-mono">{reply.model}</span> · {milliseconds(reply.latency_ms)}{" "}
                · {reply.label ? "valid label" : "not a known label"}
            </p>
        </div>
    );
}

function Playground({ slug }: { slug: string }) {
    const { data: detail } = useMinibrain(slug);
    const { data: versions } = useVersions(slug);
    const golden = useGolden(slug, Boolean(detail?.snapshot));
    const ready = (versions ?? [])
        .filter((version) => version.status === "ready")
        .map((v) => v.number);
    const [primary, setPrimary] = useState<string>("");
    const [compare, setCompare] = useState<string>(NONE);
    const [text, setText] = useState("");
    const [history, setHistory] = useState<Exchange[]>([]);
    const chosen = primary || String(detail?.current_version ?? ready[0] ?? "");
    const run = useMutation({
        mutationFn: async (input: string) => {
            const targets = [chosen, compare].filter((value) => value && value !== NONE);
            const replies = await Promise.all(
                targets.map((version) =>
                    unwrap(
                        api.POST("/api/minibrains/{slug}/complete", {
                            params: { path: { slug } },
                            body: { text: input, version: Number(version) },
                        }),
                    ),
                ),
            );
            return { id: Date.now(), text: input, replies };
        },
        onSuccess: (exchange) => {
            setHistory((previous) => [exchange, ...previous]);
            setText("");
        },
    });
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (text.trim()) {
            run.mutate(text.trim());
        }
    };
    if (ready.length === 0) {
        return (
            <>
                <p className="text-sm text-muted-foreground">
                    No version is ready yet. Score or train one on the Training page.
                </p>
            </>
        );
    }
    const samples = (golden.data ?? []).slice(0, 4);
    return (
        <>
            <Section
                title="Try it"
                caption="Each message is classified on its own. Pick a second version to compare answers side by side."
            >
                <form onSubmit={submit} className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-3">
                        <VersionPicker
                            id="primary"
                            label="Version"
                            value={chosen}
                            options={ready}
                            onChange={setPrimary}
                        />
                        <VersionPicker
                            id="compare"
                            label="Compare with"
                            value={compare}
                            options={ready}
                            onChange={setCompare}
                            allowNone
                        />
                    </div>
                    <Textarea
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        rows={3}
                        placeholder="Type an input to classify"
                        aria-label="Input"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                        <Button type="submit" disabled={!text.trim() || run.isPending}>
                            {run.isPending ? "Running…" : "Run"}
                        </Button>
                        {samples.map((sample) => (
                            <Button
                                key={sample.input}
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="max-w-64 truncate"
                                onClick={() => setText(sample.input)}
                            >
                                {sample.input}
                            </Button>
                        ))}
                    </div>
                    <ErrorLine error={run.error} />
                </form>
            </Section>
            {history.map((exchange) => (
                <div
                    key={exchange.id}
                    className="flex flex-col gap-2 rounded-lg border bg-card p-4"
                >
                    <ChatBubble role="user" text={exchange.text} />
                    <div className="grid gap-3 md:grid-cols-2">
                        {exchange.replies.map((reply) => (
                            <Reply key={reply.model} reply={reply} />
                        ))}
                    </div>
                </div>
            ))}
        </>
    );
}

export function PlaygroundPage() {
    return (
        <ScopedPage
            title="Playground"
            caption="Try a version on your own inputs, or compare two side by side."
        >
            {(slug) => <Playground key={slug} slug={slug} />}
        </ScopedPage>
    );
}
