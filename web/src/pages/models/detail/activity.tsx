import { History } from "lucide-react";
import { Link, Tooltip, TooltipContent, TooltipTrigger, cn } from "obp-ui";
import { useState } from "react";
import type { ModelRow } from "~/api/client";
import { type ModelActivityEvent, useModelActivity } from "~/api/modelPageQueries";
import { ErrorLine, PanelSection } from "~/components/Section";
import { useCan } from "~/lib/access";
import { percent } from "~/lib/format";
import { auditHref, jobHref, modelPageHref, modelVersionHref } from "~/lib/modelLinks";
import { exactTime } from "~/lib/time";

const PAGE = 10;
const BURST = 3;
const DAY_MS = 86400000;

type Tone = ModelActivityEvent["tone"];

type Entry = { key: string; head: ModelActivityEvent; run: ModelActivityEvent[] };

type TimelineRow = { kind: "day"; key: string; label: string } | { kind: "entry"; entry: Entry };

const MARKER: Record<Tone, string> = {
    neutral: "bg-faint",
    success: "bg-success",
    failed: "bg-destructive",
};

function hrefOf(row: ModelRow, event: ModelActivityEvent): string | null {
    const link = event.link;
    if (!link) {
        return null;
    }
    switch (link.kind) {
        case "version":
            return link.version === null || link.version === undefined
                ? null
                : modelVersionHref(row.key, link.version);
        case "job":
            return link.job_id ? jobHref({ id: link.job_id, kind: link.job_kind ?? "" }) : null;
        case "key":
            return modelPageHref(row.key, "api");
        case "base":
            return row.base_model ? modelPageHref(row.base_model) : null;
        case "monitoring":
            return modelPageHref(row.key, "monitoring");
        default:
            return modelPageHref(row.key);
    }
}

function similar(a: ModelActivityEvent, b: ModelActivityEvent): boolean {
    return a.action === b.action && a.actor === b.actor && dayLabel(a.at) === dayLabel(b.at);
}

function entries(events: ModelActivityEvent[]): Entry[] {
    const found: Entry[] = [];
    let start = 0;
    while (start < events.length) {
        const head = events[start];
        let end = start + 1;
        while (end < events.length && similar(events[end], head)) {
            end += 1;
        }
        const run = events.slice(start, end);
        if (run.length >= BURST) {
            found.push({ key: `run-${head.id}`, head, run });
        } else {
            found.push(
                ...run.map((event) => ({ key: String(event.id), head: event, run: [event] })),
            );
        }
        start = end;
    }
    return found;
}

function startOfDay(date: Date): number {
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const CLOCK_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function daysAgo(at: string): number {
    return Math.round((startOfDay(new Date()) - startOfDay(new Date(at))) / DAY_MS);
}

function dayLabel(at: string): string {
    const ago = daysAgo(at);
    if (ago === 0) {
        return "Today";
    }
    if (ago === 1) {
        return "Yesterday";
    }
    return DAY_FORMAT.format(new Date(at));
}

function shortTime(at: string): string {
    if (daysAgo(at) > 0) {
        return CLOCK_FORMAT.format(new Date(at));
    }
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60000));
    if (minutes < 1) {
        return "now";
    }
    return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

function timelineRows(shown: Entry[]): TimelineRow[] {
    const rows: TimelineRow[] = [];
    let last = "";
    for (const entry of shown) {
        const label = dayLabel(entry.head.at);
        if (label !== last) {
            rows.push({ kind: "day", key: `day-${entry.key}`, label });
            last = label;
        }
        rows.push({ kind: "entry", entry });
    }
    return rows;
}

function Actor({ event }: { event: ModelActivityEvent }) {
    if (!event.actor_name) {
        return null;
    }
    if (event.actor_name === event.actor) {
        return <span className="font-medium">{event.actor_name} </span>;
    }
    return (
        <>
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="font-medium">{event.actor_name}</span>
                </TooltipTrigger>
                <TooltipContent>{event.actor}</TooltipContent>
            </Tooltip>{" "}
        </>
    );
}

function Sentence({ row, event }: { row: ModelRow; event: ModelActivityEvent }) {
    const href = hrefOf(row, event);
    const label = event.link?.label ?? "";
    const at = label && href ? event.text.lastIndexOf(label) : -1;
    const before = at >= 0 ? event.text.slice(0, at) : event.text;
    const after = at >= 0 ? event.text.slice(at + label.length) : "";
    return (
        <span className="min-w-0 break-words">
            <Actor event={event} />
            {before}
            {at >= 0 && href && (
                <Link
                    href={href}
                    className="font-medium whitespace-nowrap text-primary hover:underline"
                >
                    {label}
                </Link>
            )}
            {after}
            {event.score !== null && event.score !== undefined && (
                <span className="text-muted-foreground tabular-nums">
                    {` · ${percent(event.score)}`}
                </span>
            )}
        </span>
    );
}

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

function best(run: ModelActivityEvent[]): ModelActivityEvent | null {
    return run.reduce<ModelActivityEvent | null>(
        (top, event) =>
            event.score !== null &&
            event.score !== undefined &&
            (top === null || (top.score ?? 0) < event.score)
                ? event
                : top,
        null,
    );
}

function runText(head: ModelActivityEvent, count: number): string {
    const action = head.action;
    if (action.startsWith("feedback.")) {
        const verb = head.text.split(" ")[0];
        return action === "feedback.example"
            ? `added ${plural(count, "feedback row", "feedback rows")} to the examples`
            : `${verb} ${plural(count, "feedback row", "feedback rows")}`;
    }
    if (action === "version.trained") {
        return head.actor_name ? `trained ${count} versions` : `${count} versions trained`;
    }
    if (action === "version.failed") {
        return `${count} versions failed`;
    }
    if (action === "version.create") {
        return `started training ${count} versions`;
    }
    if (action === "version.promote") {
        return `made a version live ${count} times`;
    }
    if (action === "key.create") {
        return `created ${count} API keys`;
    }
    return `${head.text} and ${count - 1} more`;
}

function RunSentence({ row, run }: { row: ModelRow; run: ModelActivityEvent[] }) {
    const head = run[0];
    const top = best(run);
    const topHref = top ? hrefOf(row, top) : null;
    return (
        <span className="min-w-0 break-words">
            <Actor event={head} />
            {runText(head, run.length)}
            {top && topHref && (
                <span className="text-muted-foreground">
                    {" · "}
                    <Link href={topHref} className="font-medium text-primary hover:underline">
                        {top.link?.label}
                    </Link>
                    <span className="tabular-nums">{` best ${percent(top.score)}`}</span>
                </span>
            )}
        </span>
    );
}

function When({ at }: { at: string }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <time
                    dateTime={at}
                    className="shrink-0 pt-px text-sm whitespace-nowrap text-muted-foreground tabular-nums"
                >
                    {shortTime(at)}
                </time>
            </TooltipTrigger>
            <TooltipContent>{exactTime(at)}</TooltipContent>
        </Tooltip>
    );
}

function Marker({ tone }: { tone: Tone }) {
    return (
        <span
            aria-hidden="true"
            className={cn(
                "relative z-10 mt-2.5 size-2 shrink-0 rounded-full ring-4 ring-card",
                MARKER[tone],
            )}
        />
    );
}

function toneOf(run: ModelActivityEvent[]): Tone {
    if (run.some((event) => event.tone === "failed")) {
        return "failed";
    }
    return run.some((event) => event.tone === "success") ? "success" : "neutral";
}

function EntryRow({ row, entry }: { row: ModelRow; entry: Entry }) {
    const [open, setOpen] = useState(false);
    const folded = entry.run.length > 1;
    return (
        <li className="flex gap-3">
            <Marker tone={toneOf(entry.run)} />
            <div className="flex min-w-0 flex-1 flex-col gap-1 py-1">
                <div className="flex items-start gap-3">
                    <span className="min-w-0 flex-1">
                        {entry.head.tone === "failed" && <span className="sr-only">Failed: </span>}
                        {folded ? (
                            <RunSentence row={row} run={entry.run} />
                        ) : (
                            <Sentence row={row} event={entry.head} />
                        )}
                    </span>
                    <When at={entry.head.at} />
                </div>
                {folded && (
                    <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setOpen(!open)}
                        className="self-start text-sm text-muted-foreground hover:text-foreground"
                    >
                        {open ? "Hide" : `Show all ${entry.run.length}`}
                    </button>
                )}
                {folded && open && (
                    <ul className="flex flex-col gap-1 border-l border-border pl-3">
                        {entry.run.map((event) => (
                            <li key={event.id} className="flex items-start gap-3 text-sm">
                                <span className="min-w-0 flex-1 text-muted-foreground">
                                    <Sentence row={row} event={{ ...event, actor_name: null }} />
                                </span>
                                <When at={event.at} />
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </li>
    );
}

function Timeline({ row, shown }: { row: ModelRow; shown: Entry[] }) {
    return (
        <ol className="relative flex flex-col before:absolute before:top-3 before:bottom-3 before:left-[0.21875rem] before:w-px before:bg-border">
            {timelineRows(shown).map((item) =>
                item.kind === "day" ? (
                    <li
                        key={item.key}
                        className="pt-3 pb-0.5 pl-5 text-sm text-muted-foreground first:pt-0"
                    >
                        {item.label}
                    </li>
                ) : (
                    <EntryRow key={item.entry.key} row={row} entry={item.entry} />
                ),
            )}
        </ol>
    );
}

export function ActivityPanel({ row }: { row: ModelRow }) {
    const can = useCan();
    const activity = useModelActivity(row.key);
    const [limit, setLimit] = useState(PAGE);
    const all = entries(activity.data?.events ?? []);
    const shown = all.slice(0, limit);
    const more = all.length > shown.length;
    return (
        <PanelSection icon={History} title="Activity" description="Who changed what, newest first.">
            <div className="flex min-w-0 flex-col gap-3">
                <ErrorLine error={activity.error} onRetry={activity.refetch} />
                {activity.isLoading ? (
                    <p className="text-muted-foreground">Loading…</p>
                ) : shown.length === 0 ? (
                    <p className="text-muted-foreground">
                        Nothing yet. Training, deploys and keys show here.
                    </p>
                ) : (
                    <Timeline row={row} shown={shown} />
                )}
                {shown.length > 0 && (more || can.admin) && (
                    <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                        {more ? (
                            <button
                                type="button"
                                onClick={() => setLimit(limit + PAGE)}
                                className="text-muted-foreground hover:text-foreground"
                            >
                                Show more
                            </button>
                        ) : (
                            <span />
                        )}
                        {can.admin && (
                            <Link
                                href={auditHref(row.key)}
                                className="text-primary hover:underline"
                            >
                                All activity →
                            </Link>
                        )}
                    </div>
                )}
            </div>
        </PanelSection>
    );
}
