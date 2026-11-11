import { History } from "lucide-react";
import { Link, Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import type { ModelRow } from "~/api/client";
import { type ModelActivityEvent, useModelActivity } from "~/api/modelPageQueries";
import { ErrorLine, PanelSection } from "~/components/Section";
import { useCan } from "~/lib/access";
import { auditHref, jobHref, modelPageHref, modelVersionHref } from "~/lib/modelLinks";
import { exactTime } from "~/lib/time";
import { TwoLines } from "./facts";

const SHOWN = 8;
const BURST = 3;
const DAY_MS = 86400000;

type Tone = ModelActivityEvent["tone"];

type Shown = ModelActivityEvent & { folded?: number };

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

function folded(events: ModelActivityEvent[]): Shown[] {
    const shown: Shown[] = [];
    let start = 0;
    while (start < events.length) {
        const head = events[start];
        let end = start + 1;
        while (
            end < events.length &&
            events[end].action === head.action &&
            events[end].actor === head.actor
        ) {
            end += 1;
        }
        const run = events.slice(start, end);
        if (run.length >= BURST) {
            shown.push({ ...head, folded: run.length - 1 });
        } else {
            shown.push(...run);
        }
        start = end;
    }
    return shown;
}

function startOfDay(date: Date): number {
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function dayLabel(at: string): string {
    const date = new Date(at);
    const ago = Math.round((startOfDay(new Date()) - startOfDay(date)) / DAY_MS);
    if (ago === 0) {
        return "Today";
    }
    if (ago === 1) {
        return "Yesterday";
    }
    return DAY_FORMAT.format(date);
}

function shortAgo(at: string): string {
    const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60000));
    if (minutes < 1) {
        return "just now";
    }
    if (minutes < 60) {
        return `${minutes} min ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `${hours} h ago`;
    }
    const days = Math.round(hours / 24);
    return days < 14 ? `${days} d ago` : `${Math.round(days / 7)} wk ago`;
}

type TimelineRow =
    | { kind: "day"; key: string; label: string }
    | { kind: "event"; key: string; event: Shown };

function timelineRows(events: Shown[]): TimelineRow[] {
    const rows: TimelineRow[] = [];
    let last = "";
    const days = new Set(events.map((event) => dayLabel(event.at)));
    for (const event of events) {
        const label = dayLabel(event.at);
        if (days.size > 1 && label !== last) {
            rows.push({ kind: "day", key: `day-${event.id}`, label });
            last = label;
        }
        rows.push({ kind: "event", key: String(event.id), event });
    }
    return rows;
}

const MARKER: Record<Tone, string> = {
    neutral: "bg-faint",
    success: "bg-success",
    failed: "bg-destructive",
};

function Rail({ first, last, dot }: { first: boolean; last: boolean; dot?: Tone }) {
    return (
        <span aria-hidden="true" className="flex w-2 shrink-0 flex-col items-center">
            <span className={`h-2.5 w-px shrink-0 ${first ? "" : "bg-border"}`} />
            {dot && <span className={`size-2 shrink-0 rounded-full ${MARKER[dot]}`} />}
            <span className={`w-px flex-1 ${last ? "" : "bg-border"}`} />
        </span>
    );
}

function EventText({ row, event }: { row: ModelRow; event: Shown }) {
    const href = hrefOf(row, event);
    const label = event.link?.label ?? "";
    const at = label && href ? event.text.lastIndexOf(label) : -1;
    const before = at >= 0 ? event.text.slice(0, at) : event.text;
    const after = at >= 0 ? event.text.slice(at + label.length) : "";
    const more = event.folded ? ` and ${event.folded} more like it` : "";
    return (
        <TwoLines full={`${event.actor} ${event.text}${more}`} className="flex-1">
            {event.tone === "failed" && <span className="sr-only">Failed: </span>}
            <span className="font-medium">{`${event.actor} `}</span>
            {before}
            {at >= 0 && href && (
                <Link href={href} className="whitespace-nowrap text-primary hover:underline">
                    {label}
                </Link>
            )}
            {after}
            {more && <span className="text-muted-foreground">{more}</span>}
        </TwoLines>
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
                    {shortAgo(at)}
                </time>
            </TooltipTrigger>
            <TooltipContent>{exactTime(at)}</TooltipContent>
        </Tooltip>
    );
}

function Timeline({ row, events }: { row: ModelRow; events: Shown[] }) {
    const rows = timelineRows(events);
    return (
        <ol className="flex flex-col">
            {rows.map((item, index) => {
                const first = index === 0;
                const last = index === rows.length - 1;
                if (item.kind === "day") {
                    return (
                        <li key={item.key} className="flex gap-3">
                            <Rail first={first} last={last} />
                            <span className="pt-1 pb-0.5 text-sm text-muted-foreground">
                                {item.label}
                            </span>
                        </li>
                    );
                }
                return (
                    <li key={item.key} className="flex gap-3">
                        <Rail first={first} last={last} dot={item.event.tone} />
                        <div className="flex min-w-0 flex-1 items-start gap-3 py-1">
                            <EventText row={row} event={item.event} />
                            <When at={item.event.at} />
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}

export function ActivityPanel({ row }: { row: ModelRow }) {
    const can = useCan();
    const activity = useModelActivity(row.key);
    const events = folded(activity.data?.events ?? []).slice(0, SHOWN);
    return (
        <PanelSection icon={History} title="Activity" description="Recent changes to this model.">
            <div className="flex min-w-0 flex-col gap-3">
                <ErrorLine error={activity.error} />
                {activity.isLoading ? (
                    <p className="text-muted-foreground">Loading…</p>
                ) : events.length === 0 ? (
                    <p className="text-muted-foreground">
                        Nothing yet. Training, deploys and keys show here.
                    </p>
                ) : (
                    <Timeline row={row} events={events} />
                )}
                {can.admin && (
                    <Link
                        href={auditHref(row.key)}
                        className="self-start text-primary hover:underline"
                    >
                        All activity →
                    </Link>
                )}
            </div>
        </PanelSection>
    );
}
