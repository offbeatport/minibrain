import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
    Button,
    Card,
    CardContent,
    EmptyState,
    Field,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
} from "obp-ui";
import { ChatBubble } from "obp-ui/chat";
import { type FormEvent, useState } from "react";
import { type CompleteResponse, type ModelSummary, api, unwrap } from "~/api/client";
import { useGolden, useModel, useModels, useVersions } from "~/api/queries";
import { AnswerFeedback } from "~/components/AnswerFeedback";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, Section } from "~/components/Section";
import { useCan } from "~/lib/access";
import { asCode, milliseconds } from "~/lib/format";
import { useSearchParam } from "~/lib/listSearch";
import { playgroundHref, trainingHref } from "~/lib/modelLinks";

const NONE = "none";
const STORAGE_KEY = "minibrain.playground.model";

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
        <Field id={id} label={label}>
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
        </Field>
    );
}

function Reply({
    slug,
    input,
    reply,
    labels,
}: {
    slug: string;
    input: string;
    reply: CompleteResponse;
    labels: string[];
}) {
    return (
        <div className="flex flex-col gap-1">
            <ChatBubble role="assistant" text={asCode(reply.output) || "(empty)"} />
            <p className="text-sm text-muted-foreground">
                <span className="font-mono">{reply.model}</span> · {milliseconds(reply.latency_ms)}{" "}
                · {reply.valid ? "meets the contract" : "breaks the contract"}
            </p>
            <AnswerFeedback slug={slug} input={input} reply={reply} labels={labels} />
        </div>
    );
}

function Playground({ slug }: { slug: string }) {
    const { data: detail } = useModel(slug);
    const { data: versions } = useVersions(slug);
    const can = useCan();
    const golden = useGolden(slug, can.build && Boolean(detail?.snapshot));
    const ready = (versions ?? [])
        .filter((version) => version.status === "ready")
        .map((v) => v.number);
    const [primary, setPrimary] = useState<string>("");
    const [compare, setCompare] = useState<string>(NONE);
    const [text, setText] = useState("");
    const [history, setHistory] = useState<Exchange[]>([]);
    const chosen = primary || String(detail?.current_version ?? ready[0] ?? "");
    const labels = detail?.contract.labels ?? [];
    const run = useMutation({
        mutationFn: async (input: string) => {
            const targets = [chosen, compare].filter((value) => value && value !== NONE);
            const replies = await Promise.all(
                targets.map((version) =>
                    unwrap(
                        api.POST("/api/models/{slug}/complete", {
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
                    No version is ready yet. Score or train one on{" "}
                    <Link href={trainingHref(slug)} className="text-primary hover:underline">
                        Training
                    </Link>
                    .
                </p>
            </>
        );
    }
    const samples = (golden.data ?? []).slice(0, 4);
    return (
        <>
            <Section
                title="Try it"
                caption="Each message is answered on its own, held to the version's contract. Pick a second version to compare answers side by side."
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
                        placeholder={
                            labels.length > 0 ? "Type an input to classify" : "Type a message"
                        }
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
                                <span className="truncate">
                                    {sample.input.replace(/\s+/g, " ")}
                                </span>
                            </Button>
                        ))}
                    </div>
                    <ErrorLine error={run.error} />
                </form>
            </Section>
            {history.map((exchange) => (
                <Card key={exchange.id}>
                    <CardContent className="flex flex-col gap-2">
                        <ChatBubble role="user" text={exchange.text} />
                        <div className="grid gap-3 md:grid-cols-2">
                            {exchange.replies.map((reply) => (
                                <Reply
                                    key={reply.model}
                                    slug={slug}
                                    input={exchange.text}
                                    reply={reply}
                                    labels={labels}
                                />
                            ))}
                        </div>
                    </CardContent>
                </Card>
            ))}
        </>
    );
}

function rememberedModel(): string | null {
    try {
        return window.localStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
}

function rememberModel(slug: string): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, slug);
    } catch {
        return;
    }
}

function chooseModel(requested: string | null, models: ModelSummary[]): string | null {
    const known = new Set(models.map((item) => item.slug));
    const candidates = [requested, rememberedModel(), models[0]?.slug];
    return candidates.find((slug): slug is string => Boolean(slug && known.has(slug))) ?? null;
}

function ModelPicker({
    slug,
    models,
    onSelect,
}: {
    slug: string;
    models: ModelSummary[];
    onSelect: (slug: string) => void;
}) {
    return (
        <Select value={slug} onValueChange={(next) => onSelect(String(next ?? slug))}>
            <SelectTrigger className="w-56" aria-label="Model">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {models.map((item) => (
                    <SelectItem key={item.slug} value={item.slug}>
                        {item.name}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

export function PlaygroundPage() {
    const router = useRouter();
    const requested = useSearchParam("model");
    const { data, isLoading } = useModels();
    const models = data ?? [];
    const slug = data ? chooseModel(requested, models) : null;
    const select = (next: string) => {
        rememberModel(next);
        router.history.replace(playgroundHref(next));
    };
    return (
        <Page>
            <PageHeader
                title="Playground"
                caption="Try a version on your own inputs, or compare two side by side."
                actions={slug && <ModelPicker slug={slug} models={models} onSelect={select} />}
            />
            {!isLoading && !slug && (
                <EmptyState
                    variant="panel"
                    title="No custom models yet"
                    action={
                        <Button asChild>
                            <Link href="/models/new">Create one</Link>
                        </Button>
                    }
                >
                    Create a custom model first, then try it here.
                </EmptyState>
            )}
            {slug && <Playground key={slug} slug={slug} />}
        </Page>
    );
}
