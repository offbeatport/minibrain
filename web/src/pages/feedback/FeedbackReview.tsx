import { Check, ThumbsDown, ThumbsUp, X } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardContent,
    Field,
    Input,
    Kbd,
    KbdHint,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    useToast,
} from "obp-ui";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
    type FeedbackDetail,
    type FeedbackInfo,
    useAssign,
    useFeedbackItem,
    useReview,
} from "~/api/feedbackQueries";
import { ErrorLine } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import {
    feedbackHref,
    feedbackStatusLabel,
    feedbackStatusVariant,
    originLabel,
    ratingLabel,
    signalLabel,
} from "~/lib/feedback";
import { relativeTime } from "~/lib/time";

type Props = {
    id: number;
    ids: number[];
    hasMore: boolean;
    loadMore: () => void;
    onOpen: (id: number | null) => void;
};

const KNOWN = "known";

function typing(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    return (
        target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
        target.closest("[role=listbox],[role=menu],[role=dialog]") !== null
    );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-sm text-muted-foreground">{label}</h3>
            {children}
        </div>
    );
}

function Text({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
    return (
        <p
            className={
                muted
                    ? "text-base text-muted-foreground"
                    : "whitespace-pre-wrap break-words rounded-md border p-3 text-base"
            }
        >
            {children}
        </p>
    );
}

function sourceLine(item: FeedbackDetail): string {
    const key = item.request?.key_name ? ` with the key ${item.request.key_name}` : "";
    const from = item.held_out
        ? "a test example from the playground"
        : `from the ${originLabel(item.origin).toLowerCase()}`;
    return `${item.model_name} · ${from}${key} · ${relativeTime(item.created_at)}`;
}

function relatedText(item: FeedbackInfo): string {
    if (item.status === "accepted") {
        return item.label ?? "";
    }
    if (item.suggestion) {
        return item.suggestion;
    }
    return item.output ? `${item.output} marked wrong` : "Marked wrong, no right answer given";
}

function Related({ items }: { items: FeedbackInfo[] }) {
    if (items.length === 0) {
        return null;
    }
    return (
        <Block label={`Other feedback on the same input (${items.length})`}>
            <ul className="flex flex-col divide-y rounded-md border">
                {items.map((other) => (
                    <li key={other.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <Link
                            href={feedbackHref(other.id)}
                            className="min-w-0 flex-1 truncate text-foreground hover:underline"
                        >
                            {relatedText(other)}
                        </Link>
                        <Badge variant={feedbackStatusVariant(other.status)}>
                            {feedbackStatusLabel(other.status)}
                        </Badge>
                        <span className="text-sm text-muted-foreground tabular-nums">
                            {relativeTime(other.created_at)}
                        </span>
                    </li>
                ))}
            </ul>
        </Block>
    );
}

function Answer({ item }: { item: FeedbackDetail }) {
    const Icon = item.rating === "up" ? ThumbsUp : ThumbsDown;
    return (
        <Block label="The model answered">
            <div className="flex flex-wrap items-center gap-2">
                {item.output ? (
                    <span className="text-base font-semibold">{item.output}</span>
                ) : (
                    <span className="text-base text-muted-foreground">
                        Not sent with the feedback
                    </span>
                )}
                <Badge variant={item.rating === "up" ? "success" : "warning"}>
                    <Icon aria-hidden="true" />
                    {ratingLabel(item.rating)}
                </Badge>
            </div>
        </Block>
    );
}

function AnswerField({
    item,
    value,
    onChange,
    inputRef,
}: {
    item: FeedbackDetail;
    value: string;
    onChange: (value: string) => void;
    inputRef: React.RefObject<HTMLInputElement | null>;
}) {
    return (
        <div className="flex flex-wrap items-end gap-2">
            <Field id="right-answer" label="Right answer" className="min-w-48 flex-1">
                <Input
                    id="right-answer"
                    ref={inputRef}
                    value={value}
                    onChange={(event) => onChange(event.target.value)}
                    placeholder="Type the right answer"
                    autoComplete="off"
                />
            </Field>
            {item.labels.length > 0 && (
                <Select
                    value={item.labels.includes(value) ? value : KNOWN}
                    onValueChange={(next) => next && next !== KNOWN && onChange(String(next))}
                >
                    <SelectTrigger aria-label="Pick a known answer" className="w-48">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value={KNOWN} disabled>
                            Pick a known answer
                        </SelectItem>
                        {item.labels.map((label) => (
                            <SelectItem key={label} value={label}>
                                {label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}
        </div>
    );
}

function Review({ item, ids, hasMore, loadMore, onOpen }: Props & { item: FeedbackDetail }) {
    const toast = useToast();
    const review = useReview();
    const assign = useAssign();
    const field = useRef<HTMLInputElement>(null);
    const [answer, setAnswer] = useState(item.label ?? item.suggestion ?? "");
    const index = ids.indexOf(item.id);
    const previous = index > 0 ? ids[index - 1] : null;
    const next = index >= 0 && index + 1 < ids.length ? ids[index + 1] : null;
    const fixed = answer.trim();
    const changed = fixed !== "" && fixed !== (item.suggestion ?? "");
    const busy = review.isPending;
    useEffect(() => {
        if (index >= 0 && index + 1 >= ids.length - 1 && hasMore) {
            loadMore();
        }
    }, [index, ids.length, hasMore, loadMore]);
    const after = () => onOpen(next ?? previous);
    const decide = (decision: "accept" | "reject", label?: string) => {
        review.mutate(
            { id: item.id, decision, label },
            {
                onSuccess: (done) => {
                    const accepted = done.status === "accepted";
                    toast({
                        title: accepted ? (label ? "Fixed and accepted" : "Accepted") : "Rejected",
                        description: accepted
                            ? `"${done.label}" joins ${done.model_name}'s next training data.`
                            : "It stays out of the training data.",
                        tone: accepted ? "success" : "neutral",
                    });
                    after();
                },
            },
        );
    };
    const accept = () => {
        if (item.suggestion) {
            decide("accept");
        } else {
            field.current?.focus();
        }
    };
    const fix = () => {
        if (changed) {
            decide("accept", fixed);
            return;
        }
        field.current?.focus();
        field.current?.select();
    };
    const keys = useRef({ accept, fix, decide, previous, next, onOpen, busy });
    keys.current = { accept, fix, decide, previous, next, onOpen, busy };
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) {
                if (event.key === "Escape" && event.target === field.current) {
                    field.current?.blur();
                }
                return;
            }
            const current = keys.current;
            const actions: Record<string, () => void> = {
                a: current.accept,
                f: current.fix,
                r: () => current.decide("reject"),
                j: () => current.next !== null && current.onOpen(current.next),
                k: () => current.previous !== null && current.onOpen(current.previous),
                escape: () => current.onOpen(null),
            };
            const action = actions[event.key.toLowerCase()];
            if (action && !current.busy) {
                event.preventDefault();
                action();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        fix();
    };
    const signal = signalLabel(item.signal);
    return (
        <Card>
            <CardContent className="flex flex-col gap-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={feedbackStatusVariant(item.status)}>
                                {feedbackStatusLabel(item.status)}
                            </Badge>
                            {signal && (
                                <StatusText tone={item.signal === "conflict" ? "warning" : "info"}>
                                    {signal}
                                </StatusText>
                            )}
                            {item.status !== "pending" && item.reviewed_by && (
                                <span className="text-sm text-muted-foreground">
                                    {`by ${item.reviewed_by}${item.reviewed_at ? `, ${relativeTime(item.reviewed_at)}` : ""}`}
                                </span>
                            )}
                        </div>
                        <p className="text-sm text-muted-foreground">{sourceLine(item)}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {index >= 0 && (
                            <span className="text-sm text-muted-foreground tabular-nums">
                                {`${index + 1} of ${ids.length}${hasMore ? "+" : ""}`}
                            </span>
                        )}
                        <Button
                            variant="outline"
                            disabled={previous === null}
                            onClick={() => previous !== null && onOpen(previous)}
                        >
                            Previous <Kbd>K</Kbd>
                        </Button>
                        <Button
                            variant="outline"
                            disabled={next === null}
                            onClick={() => next !== null && onOpen(next)}
                        >
                            Next <Kbd>J</Kbd>
                        </Button>
                    </div>
                </div>
                <div className="grid gap-5 md:grid-cols-2">
                    <Block label="Input">
                        <Text>{item.input}</Text>
                    </Block>
                    <div className="flex min-w-0 flex-col gap-4">
                        <Answer item={item} />
                        <Block label="Suggested answer">
                            {item.suggestion ? (
                                <span className="text-base font-semibold">{item.suggestion}</span>
                            ) : (
                                <Text muted>None given. Type the right answer below.</Text>
                            )}
                        </Block>
                        {item.comment && (
                            <Block label="Comment">
                                <Text>{item.comment}</Text>
                            </Block>
                        )}
                    </div>
                </div>
                <Related items={item.related} />
                <form onSubmit={submit} className="flex flex-col gap-4 border-t pt-4">
                    <AnswerField item={item} value={answer} onChange={setAnswer} inputRef={field} />
                    <div className="flex flex-wrap items-center gap-2">
                        <Button type="button" onClick={accept} disabled={busy || !item.suggestion}>
                            <Check aria-hidden="true" />
                            Accept <Kbd>A</Kbd>
                        </Button>
                        <Button type="submit" variant="outline" disabled={busy}>
                            Fix and accept <Kbd>F</Kbd>
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => decide("reject")}
                            disabled={busy}
                        >
                            <X aria-hidden="true" />
                            Reject <Kbd>R</Kbd>
                        </Button>
                        <span className="flex-1" />
                        <Button
                            type="button"
                            variant="ghost"
                            disabled={assign.isPending}
                            onClick={() => assign.mutate({ id: item.id, mine: !item.assignee })}
                        >
                            {item.assignee ? "Unassign" : "Assign to me"}
                        </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span className="text-sm text-muted-foreground">
                            {item.assignee ? `Assigned to ${item.assignee}` : "Not assigned"}
                        </span>
                        <KbdHint keys={["Enter"]}>Fix and accept from the answer box</KbdHint>
                        <KbdHint keys={["Esc"]}>Back to the list</KbdHint>
                    </div>
                    <ErrorLine error={review.error ?? assign.error} />
                </form>
            </CardContent>
        </Card>
    );
}

export function FeedbackReview(props: Props) {
    const item = useFeedbackItem(props.id);
    if (item.error) {
        return <ErrorLine error={item.error} />;
    }
    if (!item.data) {
        return <p className="text-sm text-muted-foreground">Loading…</p>;
    }
    return <Review {...props} item={item.data} />;
}
