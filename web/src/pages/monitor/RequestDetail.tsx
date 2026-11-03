import { ThumbsDown, ThumbsUp } from "lucide-react";
import {
    Badge,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Link,
} from "obp-ui";
import type { ReactNode } from "react";
import {
    type RequestDetail,
    type RequestFeedback,
    type RequestRow,
    useRequestDetail,
} from "~/api/requestQueries";
import { CopyButton } from "~/components/CopyButton";
import { Facts } from "~/components/Facts";
import { ErrorLine } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { useCan } from "~/lib/access";
import {
    feedbackHref,
    feedbackStatusLabel,
    feedbackStatusVariant,
    originLabel,
    ratingLabel,
} from "~/lib/feedback";
import { count, milliseconds } from "~/lib/format";
import { SECURITY_PATH, STATUS_CLASSES, STATUS_TONES, modelLabel } from "~/lib/requests";
import { exactTime, relativeTime } from "~/lib/time";

function Block({ label, children }: { label: string; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{label}</h3>
            {children}
        </section>
    );
}

function Text({ children }: { children: string }) {
    return (
        <p className="max-h-60 overflow-y-auto rounded-md border p-3 text-base whitespace-pre-wrap break-words">
            {children}
        </p>
    );
}

function Note({ children }: { children: ReactNode }) {
    return <p className="text-sm text-muted-foreground">{children}</p>;
}

function NotKept({ bodies }: { bodies: boolean }) {
    const can = useCan();
    if (bodies) {
        return <Note>This request's input and answer were not kept.</Note>;
    }
    if (can.admin) {
        return (
            <Note>
                Inputs and answers are not kept. Turn on Request inputs and answers under{" "}
                <Link href={SECURITY_PATH} className="text-primary hover:underline">
                    Settings, Security
                </Link>{" "}
                to keep them with each request log.
            </Note>
        );
    }
    return (
        <Note>
            Inputs and answers are not kept. An admin can turn on Request inputs and answers under
            Settings, Security.
        </Note>
    );
}

function Bodies({ detail, bodies }: { detail: RequestDetail; bodies: boolean }) {
    if (detail.body === "hidden") {
        return (
            <Block label="Input and answer">
                <Note>Inputs and answers are kept, but seeing them needs the Builder role.</Note>
            </Block>
        );
    }
    if (detail.body === "not_kept") {
        return (
            <Block label="Input and answer">
                <NotKept bodies={bodies} />
            </Block>
        );
    }
    return (
        <>
            <Block label="Input, the last user message">
                {detail.input ? <Text>{detail.input}</Text> : <Note>Empty</Note>}
            </Block>
            <Block label="Answer">
                {detail.output ? <Text>{detail.output}</Text> : <Note>Empty</Note>}
            </Block>
        </>
    );
}

function FeedbackItem({ item, linked }: { item: RequestFeedback; linked: boolean }) {
    const Icon = item.rating === "up" ? ThumbsUp : ThumbsDown;
    const extra = [
        item.correction ? `Right answer: ${item.correction}` : null,
        item.comment ? `Comment: ${item.comment}` : null,
    ].filter(Boolean);
    return (
        <li className="flex flex-col gap-1 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
                <Badge variant={item.rating === "up" ? "success" : "warning"}>
                    <Icon aria-hidden="true" />
                    {ratingLabel(item.rating)}
                </Badge>
                <Badge variant={feedbackStatusVariant(item.status)}>
                    {feedbackStatusLabel(item.status)}
                </Badge>
                <span className="text-sm text-muted-foreground tabular-nums">
                    {`${originLabel(item.origin)}, ${relativeTime(item.created_at)}`}
                </span>
                {linked && (
                    <Link
                        href={feedbackHref(item.id)}
                        className="ml-auto text-sm text-primary hover:underline"
                    >
                        Open review
                    </Link>
                )}
            </div>
            {extra.length > 0 && (
                <p className="text-sm whitespace-pre-wrap break-words">{extra.join("\n")}</p>
            )}
        </li>
    );
}

function FeedbackList({ items }: { items: RequestFeedback[] }) {
    const can = useCan();
    return (
        <Block label={items.length > 0 ? `Feedback (${items.length})` : "Feedback"}>
            {items.length === 0 ? (
                <Note>
                    None yet. Apps send it with <span className="font-mono">POST /v1/feedback</span>{" "}
                    and this request's response ID.
                </Note>
            ) : (
                <ul className="flex flex-col divide-y rounded-md border">
                    {items.map((item) => (
                        <FeedbackItem key={item.id} item={item} linked={can.build} />
                    ))}
                </ul>
            )}
        </Block>
    );
}

function statusText(row: RequestRow): string {
    const label = STATUS_CLASSES.find((item) => item.value === row.status_class)?.label ?? "";
    return `${row.status} ${label}`;
}

function facts(row: RequestRow): [string, ReactNode][] {
    const requested: [string, ReactNode][] =
        row.model === row.model_key ? [] : [["Requested as", row.model]];
    return [
        [
            "Time",
            <span key="at" className="tabular-nums">
                {`${exactTime(row.at)} (${relativeTime(row.at)})`}
            </span>,
        ],
        ["Model", row.custom ? `${row.model_name} (${row.model_key})` : row.model_name],
        [
            "Version",
            <span key="version" className="tabular-nums">
                {row.version === null ? "–" : `v${row.version}`}
            </span>,
        ],
        ...requested,
        ["API key", row.key_name ?? "Deleted key"],
        [
            "Status",
            <StatusText key="status" tone={STATUS_TONES[row.status_class]}>
                <span className="tabular-nums">{statusText(row)}</span>
            </StatusText>,
        ],
        [
            "Latency",
            <span key="latency" className="tabular-nums">
                {milliseconds(row.latency_ms)}
            </span>,
        ],
        [
            "Tokens in / out",
            <span key="tokens" className="tabular-nums">
                {`${count(row.prompt_tokens)} / ${count(row.completion_tokens)}`}
            </span>,
        ],
        ["Finish reason", row.finish_reason ?? "–"],
        [
            "Response ID",
            row.response_id ? (
                <span key="response" className="flex min-w-0 items-center gap-1">
                    <span className="min-w-0 font-mono break-all">{row.response_id}</span>
                    <CopyButton value={row.response_id} label="Copy response ID" />
                </span>
            ) : (
                <span key="response" className="text-muted-foreground">
                    None, the request did not get an answer
                </span>
            ),
        ],
    ];
}

export function RequestDialog({
    id,
    loaded,
    bodies,
    onClose,
}: {
    id: number | null;
    loaded: RequestRow | undefined;
    bodies: boolean;
    onClose: () => void;
}) {
    const detail = useRequestDetail(id);
    const row = detail.data ?? loaded;
    return (
        <Dialog open={id !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{row ? modelLabel(row) : `Request ${id}`}</DialogTitle>
                    <DialogDescription>
                        {row
                            ? `Request ${row.id}, ${exactTime(row.at)}, key ${row.key_name ?? "deleted"}`
                            : "Loading…"}
                    </DialogDescription>
                </DialogHeader>
                <ErrorLine error={detail.error} />
                {row && (
                    <div className="flex min-w-0 flex-col gap-6">
                        <Facts items={facts(row)} />
                        {detail.data && <Bodies detail={detail.data} bodies={bodies} />}
                        {detail.data && <FeedbackList items={detail.data.feedback} />}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
