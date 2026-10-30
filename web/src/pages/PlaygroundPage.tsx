import { Button } from "@/components/motion/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/motion/select";
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { type CompleteResponse, api, unwrap } from "~/api/client";
import { useGolden, useMinibrain, useVersions } from "~/api/queries";
import { Bubble, ErrorLine, Field, Page, Section, Textarea } from "~/components/Section";
import { milliseconds } from "~/lib/format";
import { useSlug } from "./MinibrainLayout";

const NONE = "none";

type Exchange = { id: number; text: string; replies: CompleteResponse[] };

function VersionPicker({
    label,
    value,
    options,
    onChange,
    allowNone,
}: {
    label: string;
    value: string;
    options: number[];
    onChange: (value: string) => void;
    allowNone?: boolean;
}) {
    return (
        <Field label={label}>
            <div className="w-40">
                <Select value={value} onValueChange={onChange}>
                    <SelectTrigger>
                        <SelectValue placeholder="Pick a version" />
                    </SelectTrigger>
                    <SelectContent>
                        {allowNone ? <SelectItem value={NONE}>None</SelectItem> : null}
                        {options.map((number) => (
                            <SelectItem key={number} value={String(number)}>
                                v{number}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
        </Field>
    );
}

function Reply({ reply }: { reply: CompleteResponse }) {
    return (
        <div className="flex flex-col gap-1">
            <Bubble role="assistant">{reply.output || "(empty)"}</Bubble>
            <p className="text-sm text-muted-foreground">
                <span className="font-mono">{reply.model}</span> · {milliseconds(reply.latency_ms)}{" "}
                · {reply.label ? "valid label" : "not a known label"}
            </p>
        </div>
    );
}

export function PlaygroundPage() {
    const slug = useSlug();
    const { data: detail } = useMinibrain(slug);
    const { data: versions } = useVersions(slug);
    const golden = useGolden(slug, Boolean(detail?.snapshot));
    const ready = (versions ?? [])
        .filter((version) => version.status === "ready")
        .map((v) => v.number);
    const [primary, setPrimary] = useState("");
    const [compare, setCompare] = useState(NONE);
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
            <Page>
                <p className="text-sm text-muted-foreground">
                    No version is ready yet. Score or train one on the Versions tab.
                </p>
            </Page>
        );
    }
    const samples = (golden.data ?? []).slice(0, 4);
    return (
        <Page>
            <Section
                title="Try it"
                caption="Each message is classified on its own. Pick a second version to compare answers side by side."
            >
                <form onSubmit={submit} className="flex flex-col gap-4">
                    <div className="flex flex-wrap gap-4">
                        <VersionPicker
                            label="Version"
                            value={chosen}
                            options={ready}
                            onChange={setPrimary}
                        />
                        <VersionPicker
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
                                className="max-w-64"
                                onClick={() => setText(sample.input)}
                            >
                                <span className="truncate">{sample.input}</span>
                            </Button>
                        ))}
                    </div>
                    <ErrorLine error={run.error} />
                </form>
            </Section>
            {history.map((exchange) => (
                <div
                    key={exchange.id}
                    className="flex flex-col gap-3 rounded-2xl border border-border p-5"
                >
                    <Bubble role="user">{exchange.text}</Bubble>
                    <div className="grid gap-4 md:grid-cols-2">
                        {exchange.replies.map((reply) => (
                            <Reply key={reply.model} reply={reply} />
                        ))}
                    </div>
                </div>
            ))}
        </Page>
    );
}
