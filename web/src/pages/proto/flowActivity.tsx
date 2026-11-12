import { History } from "lucide-react";
import {
    Link,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { PageHeader } from "~/components/PageHeader";
import { Page, PanelSection } from "~/components/Section";
import { useSearchParam } from "~/lib/listSearch";
import { TwoLines } from "./flowClipped";
import { pointersOf } from "./flowUsage";
import {
    FLOW,
    type FlowModel,
    type FlowState,
    type FlowVersion,
    type Job,
    baseModelSlug,
    beatsLive,
    jobHref,
    modelHref,
    pct,
    rolloutsOf,
    shortAgo,
    useFlowState,
    versionHref,
} from "./modelsFlowData";
import { Crumbs } from "./modelsFlowParts";

const DAY = 24;

export type Owner = { by: string; duplicated: string | null; switches: string | null };

const OWNERS: Record<string, Owner> = {
    "support-triage": { by: "Dana Ilie", duplicated: null, switches: null },
    "invoice-extractor": { by: "Sam Okafor", duplicated: null, switches: null },
    "sql-helper": { by: "Sam Okafor", duplicated: null, switches: null },
    guy1: { by: "Dana Ilie", duplicated: null, switches: null },
    "contract-reviewer": {
        by: "Sam Okafor",
        duplicated: "Support triage",
        switches: "1 · from Qwen3 0.6B",
    },
};

const KEY_NAMES: Record<string, string> = {
    k1: "helpdesk",
    k2: "billing-app",
    k3: "ap-inbox",
};

const ADMIN = "Sam";

export function ownerOf(slug: string): Owner {
    return OWNERS[slug] ?? { by: "You", duplicated: null, switches: null };
}

function firstName(slug: string): string {
    return ownerOf(slug).by.split(" ")[0];
}

export type ActivityTone = "neutral" | "success" | "failed";

type BurstKind = "trained" | "feedback";

export type ActivityEvent = {
    id: string;
    model: string;
    actor: string | null;
    text: string;
    link: string | null;
    hoursAgo: number;
    atMs?: number;
    href: string;
    tone: ActivityTone;
    burst?: BurstKind;
    version?: number;
    score?: number;
    note?: string;
};

function hoursOfItem(item: { hoursAgo: number; atMs?: number }): number {
    return item.atMs ? (Date.now() - item.atMs) / 3600000 : item.hoursAgo;
}

function hoursOf(event: ActivityEvent): number {
    return hoursOfItem(event);
}

export function sentence(event: ActivityEvent): string {
    return event.actor ? `${event.actor} ${event.text}` : event.text;
}

function trainedNote(model: FlowModel, version: FlowVersion): string {
    if (!version.passed) {
        return "below rule";
    }
    const newer = model.live === null || version.number > model.live;
    return newer && beatsLive(model, version) ? "beats deployed" : "passed";
}

function versionEvent(model: FlowModel, version: FlowVersion): ActivityEvent {
    const name = `v${version.number}`;
    const base = {
        id: `${model.slug}:v${version.number}`,
        model: model.slug,
        actor: null,
        hoursAgo: version.hoursAgo,
        atMs: version.atMs,
        link: name,
        href: versionHref(model.slug, version.number),
        tone: "neutral" as const,
    };
    if (version.status === "training") {
        return {
            ...base,
            actor: version.atMs ? "You" : firstName(model.slug),
            text: `started training ${name}`,
            href: jobHref(version.jobId),
        };
    }
    if (version.status === "failed") {
        const memory = /memory/i.test(version.error ?? "");
        return {
            ...base,
            text: `${name} failed${memory ? ": out of memory" : ""}`,
            tone: "failed",
        };
    }
    const score = pct(version.scores?.[0]);
    if (version.kind === "prompt") {
        return { ...base, text: `${name} Baseline scored ${score}` };
    }
    const note = trainedNote(model, version);
    return {
        ...base,
        text: `${name} trained · ${score} · ${note}`,
        burst: "trained",
        version: version.number,
        score: version.scores?.[0],
        note,
    };
}

function rolledOut(state: FlowState, model: FlowModel): Set<number> {
    return new Set(
        rolloutsOf(state, model.slug)
            .filter((job) => job.kind === "deploy" && job.status === "done")
            .map((job) => job.version ?? -1),
    );
}

function liveEvents(state: FlowState, model: FlowModel): ActivityEvent[] {
    const actor = firstName(model.slug);
    const covered = rolledOut(state, model);
    return pointersOf(model).flatMap((pointer, index) => {
        const shown = pointer.canary?.version ?? pointer.version;
        if (!pointer.canary && covered.has(shown)) {
            return [];
        }
        return {
            id: `${model.slug}:live:${index}`,
            model: model.slug,
            actor: pointer.canary ? "Autopilot" : actor,
            text: pointer.canary
                ? `started a v${shown} canary at ${pointer.canary.share}%`
                : index === 0
                  ? `deployed ${model.slug} with v${shown}`
                  : `deployed v${shown}`,
            link: `v${shown}`,
            hoursAgo: pointer.hoursAgo,
            href: versionHref(model.slug, shown),
            tone: "success" as const,
        };
    });
}

function rolloutText(job: Job, model: FlowModel): { actor: string | null; text: string } {
    const by = job.rollout?.by ?? "You";
    const target = job.rollout?.target ?? model.slug;
    const variant = model.variants.find((item) => target === `${model.slug}#${item.id}`);
    const what = job.version !== null ? `v${job.version}` : (variant?.apiName ?? model.slug);
    const tail = " · view rollout";
    if (job.kind === "undeploy") {
        return {
            actor: by,
            text: `${job.status === "running" ? "is undeploying" : "undeployed"} ${what}${tail}`,
        };
    }
    if (job.status === "failed") {
        const memory = /memory/i.test(job.error ?? "");
        return { actor: null, text: `Deploy failed${memory ? ": out of memory" : ""}${tail}` };
    }
    if (job.status === "running") {
        return { actor: by, text: `is deploying ${what}${tail}` };
    }
    if (job.status === "cancelled") {
        return { actor: by, text: `cancelled deploying ${what}${tail}` };
    }
    return { actor: by, text: `deployed ${what}${tail}` };
}

function rolloutEvents(state: FlowState, model: FlowModel): ActivityEvent[] {
    return rolloutsOf(state, model.slug).map((job) => {
        const { actor, text } = rolloutText(job, model);
        return {
            id: `${model.slug}:rollout:${job.id}`,
            model: model.slug,
            actor,
            text,
            link: "view rollout",
            hoursAgo: job.hoursAgo,
            atMs: job.atMs,
            href: jobHref(job.id),
            tone:
                job.status === "failed"
                    ? "failed"
                    : job.kind === "deploy" && job.status === "done"
                      ? "success"
                      : "neutral",
        };
    });
}

function keyEvents(state: FlowState, model: FlowModel): ActivityEvent[] {
    return (state.keys[model.slug] ?? []).map((key) => {
        const name = KEY_NAMES[key.id] ?? key.prefix;
        return {
            id: `${model.slug}:key:${key.id}`,
            model: model.slug,
            actor: key.atMs ? "You" : firstName(model.slug),
            text: `created API key ${name}`,
            link: name,
            hoursAgo: key.hoursAgo,
            atMs: key.atMs,
            href: modelHref(model.slug, "keys"),
            tone: "neutral",
        };
    });
}

function jobEvents(state: FlowState, model: FlowModel): ActivityEvent[] {
    return state.jobs
        .filter((job) => job.model === model.slug && job.kind === "export")
        .map((job) => {
            const format = job.format?.toUpperCase().replace("-", " ") ?? "files";
            return {
                id: `${model.slug}:job:${job.id}`,
                model: model.slug,
                actor: "You",
                text: `exported v${job.version} as ${format}`,
                link: format,
                hoursAgo: job.hoursAgo,
                atMs: job.atMs,
                href: jobHref(job.id),
                tone: "neutral",
            };
        });
}

function feedbackEvents(model: FlowModel): ActivityEvent[] {
    return Array.from({ length: model.accepted }, (_, index) => ({
        id: `${model.slug}:feedback:${index}`,
        model: model.slug,
        actor: firstName(model.slug),
        text: "accepted a feedback row",
        link: "a feedback row",
        hoursAgo: 2 * DAY - index * 0.05,
        href: `${FLOW}/feedback`,
        tone: "neutral",
        burst: "feedback",
    }));
}

function firstJobAt(state: FlowState, slug: string): number | undefined {
    const times = state.jobs
        .filter((job) => job.model === slug && job.atMs !== undefined)
        .map((job) => job.atMs ?? 0);
    return times.length > 0 ? Math.min(...times) - 1000 : undefined;
}

function customEvents(state: FlowState, model: FlowModel): ActivityEvent[] {
    const first = [...model.versions].sort((a, b) => hoursOfItem(b) - hoursOfItem(a))[0];
    const owner = ownerOf(model.slug);
    const firstTrained = model.versions.find((version) => version.kind === "trained");
    const events: ActivityEvent[] = [
        {
            id: `${model.slug}:created`,
            model: model.slug,
            actor: firstName(model.slug),
            text: owner.duplicated
                ? `duplicated ${owner.duplicated} as ${model.name}`
                : `created ${model.name}`,
            link: model.name,
            hoursAgo: first && !first.atMs ? first.hoursAgo + 0.5 : 0,
            atMs: first?.atMs ? first.atMs - 1000 : firstJobAt(state, model.slug),
            href: modelHref(model.slug),
            tone: "neutral",
        },
        ...model.versions.map((version) => versionEvent(model, version)),
        ...liveEvents(state, model),
        ...rolloutEvents(state, model),
        ...keyEvents(state, model),
        ...jobEvents(state, model),
        ...feedbackEvents(model),
    ];
    if (owner.switches && firstTrained && model.base) {
        events.push({
            id: `${model.slug}:switch`,
            model: model.slug,
            actor: firstName(model.slug),
            text: `switched the base to ${model.base}`,
            link: model.base,
            hoursAgo: firstTrained.hoursAgo + DAY,
            href: modelHref(baseModelSlug(model.base)),
            tone: "neutral",
        });
    }
    return events;
}

function baseEvents(state: FlowState, model: FlowModel): ActivityEvent[] {
    const fetched = state.jobs.find(
        (job) => job.model === model.slug && (job.kind === "download" || job.kind === "import"),
    );
    const start = fetched?.hoursAgo ?? 40 * DAY;
    const variantsHref = modelHref(model.slug, "variants");
    const first = model.variants[0];
    const events: ActivityEvent[] = [];
    if (fetched && first) {
        events.push({
            id: `${model.slug}:fetched`,
            model: model.slug,
            actor: ADMIN,
            text: `${fetched.kind === "import" ? "imported" : "downloaded"} ${first.format}, ${first.size}`,
            link: first.format,
            hoursAgo: start,
            href: jobHref(fetched.id),
            tone: "neutral",
        });
    }
    model.variants.forEach((variant, index) => {
        if (index > 0) {
            events.push({
                id: `${model.slug}:variant:${variant.id}`,
                model: model.slug,
                actor: ADMIN,
                text: `added ${variant.format}, ${variant.size}`,
                link: variant.format,
                hoursAgo: start - index * 3,
                href: variantsHref,
                tone: "neutral",
            });
        }
        if (variant.live && !rolledOutTarget(state, `${model.slug}#${variant.id}`)) {
            events.push({
                id: `${model.slug}:deploy:${variant.id}`,
                model: model.slug,
                actor: index === 0 ? ADMIN : "Dana",
                text: `deployed ${variant.apiName}`,
                link: variant.apiName,
                hoursAgo: index === 0 ? start - 1 : start / (index + 2),
                href: variantsHref,
                tone: "success",
            });
        }
        if (variant.update) {
            events.push({
                id: `${model.slug}:update:${variant.id}`,
                model: model.slug,
                actor: null,
                text: `Update available for ${variant.format}`,
                link: variant.format,
                hoursAgo: 30,
                href: variantsHref,
                tone: "neutral",
            });
        }
    });
    for (const child of state.models) {
        if (child.kind !== "custom" || !child.base || baseModelSlug(child.base) !== model.slug) {
            continue;
        }
        const oldest = Math.max(...child.versions.map((version) => version.hoursAgo), 0);
        events.push({
            id: `${model.slug}:child:${child.slug}`,
            model: model.slug,
            actor: firstName(child.slug),
            text: `built ${child.name} on it`,
            link: child.name,
            hoursAgo: oldest + 0.5,
            href: modelHref(child.slug),
            tone: "neutral",
        });
    }
    return [...events, ...rolloutEvents(state, model), ...keyEvents(state, model)];
}

function rolledOutTarget(state: FlowState, target: string): boolean {
    return state.jobs.some((job) => job.rollout?.target === target);
}

export function activityOf(state: FlowState, model: FlowModel): ActivityEvent[] {
    const events = model.kind === "base" ? baseEvents(state, model) : customEvents(state, model);
    return events.sort((a, b) => hoursOf(a) - hoursOf(b));
}

export function activityHref(slug?: string): string {
    return `${FLOW}/activity${slug ? `?model=${slug}` : ""}`;
}

function trainedBurst(run: ActivityEvent[]): Partial<ActivityEvent> {
    const numbers = run.map((event) => event.version ?? 0);
    const best = run.reduce((top, event) => ((event.score ?? 0) > (top.score ?? 0) ? event : top));
    const bestName = `v${best.version}`;
    return {
        text: `v${Math.min(...numbers)}–v${Math.max(...numbers)} trained · best ${bestName} ${pct(best.score)} · ${best.note}`,
        link: bestName,
        href: best.href,
    };
}

function feedbackBurst(run: ActivityEvent[]): Partial<ActivityEvent> {
    return {
        text: `accepted ${run.length} feedback rows`,
        link: `${run.length} feedback rows`,
    };
}

const BURSTS: Record<BurstKind, (run: ActivityEvent[]) => Partial<ActivityEvent>> = {
    trained: trainedBurst,
    feedback: feedbackBurst,
};

export function collapseBursts(events: ActivityEvent[]): ActivityEvent[] {
    const collapsed: ActivityEvent[] = [];
    let start = 0;
    while (start < events.length) {
        const head = events[start];
        let end = start + 1;
        while (
            head.burst &&
            end < events.length &&
            events[end].burst === head.burst &&
            events[end].actor === head.actor
        ) {
            end += 1;
        }
        const run = events.slice(start, end);
        if (head.burst && run.length >= 3) {
            collapsed.push({ ...head, id: `${head.id}:burst`, ...BURSTS[head.burst](run) });
        } else {
            collapsed.push(...run);
        }
        start = end;
    }
    return collapsed;
}

function dateOf(event: ActivityEvent): Date {
    return new Date(event.atMs ?? Date.now() - event.hoursAgo * 3600000);
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

const EXACT_FORMAT = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
});

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short" });

function startOfDay(date: Date): Date {
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    return day;
}

function bucketOf(date: Date): string {
    const day = startOfDay(date);
    const ago = Math.round((startOfDay(new Date()).getTime() - day.getTime()) / 86400000);
    if (ago === 0) {
        return "Today";
    }
    if (ago === 1) {
        return "Yesterday";
    }
    day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
    return `week:${day.toDateString()}`;
}

function rangeLabel(newest: Date, oldest: Date): string {
    if (newest.toDateString() === oldest.toDateString()) {
        return DAY_FORMAT.format(newest);
    }
    if (newest.getMonth() === oldest.getMonth()) {
        return `${MONTH_FORMAT.format(oldest)} ${oldest.getDate()}–${newest.getDate()}`;
    }
    return `${DAY_FORMAT.format(oldest)} – ${DAY_FORMAT.format(newest)}`;
}

type TimelineRow =
    | { kind: "day"; key: string; label: string }
    | { kind: "event"; key: string; event: ActivityEvent };

function timelineRows(events: ActivityEvent[]): TimelineRow[] {
    const groups: { bucket: string; events: ActivityEvent[] }[] = [];
    for (const event of events) {
        const bucket = bucketOf(dateOf(event));
        const last = groups.at(-1);
        if (last?.bucket === bucket) {
            last.events.push(event);
        } else {
            groups.push({ bucket, events: [event] });
        }
    }
    return groups.flatMap((group): TimelineRow[] => {
        const rows = group.events.map(
            (event): TimelineRow => ({ kind: "event", key: event.id, event }),
        );
        if (groups.length < 2) {
            return rows;
        }
        const label = group.bucket.startsWith("week:")
            ? rangeLabel(dateOf(group.events[0]), dateOf(group.events[group.events.length - 1]))
            : group.bucket;
        return [{ kind: "day", key: group.bucket, label }, ...rows];
    });
}

const MARKER: Record<ActivityTone, string> = {
    neutral: "bg-faint",
    success: "bg-success",
    failed: "bg-destructive",
};

function Rail({ first, last, dot }: { first: boolean; last: boolean; dot?: ActivityTone }) {
    return (
        <span aria-hidden="true" className="flex w-2 shrink-0 flex-col items-center">
            <span className={`h-2.5 w-px shrink-0 ${first ? "" : "bg-border"}`} />
            {dot && <span className={`size-2 shrink-0 rounded-full ${MARKER[dot]}`} />}
            <span className={`w-px flex-1 ${last ? "" : "bg-border"}`} />
        </span>
    );
}

function EventText({ event }: { event: ActivityEvent }) {
    const at = event.link ? event.text.lastIndexOf(event.link) : -1;
    const before = at >= 0 ? event.text.slice(0, at) : event.text;
    const after = at >= 0 && event.link ? event.text.slice(at + event.link.length) : "";
    return (
        <TwoLines full={sentence(event)} className="flex-1">
            {event.tone === "failed" && <span className="sr-only">Failed: </span>}
            {event.actor && <span className="font-medium">{`${event.actor} `}</span>}
            {before}
            {at >= 0 && (
                <Link href={event.href} className="whitespace-nowrap text-primary hover:underline">
                    {event.link}
                </Link>
            )}
            {after}
        </TwoLines>
    );
}

function When({ event }: { event: ActivityEvent }) {
    const date = dateOf(event);
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <time
                    dateTime={date.toISOString()}
                    className="shrink-0 pt-px text-sm whitespace-nowrap text-muted-foreground tabular-nums"
                >
                    {shortAgo(event)}
                </time>
            </TooltipTrigger>
            <TooltipContent>{EXACT_FORMAT.format(date)}</TooltipContent>
        </Tooltip>
    );
}

function Timeline({ events }: { events: ActivityEvent[] }) {
    const rows = timelineRows(events);
    return (
        <ol className="flex flex-col">
            {rows.map((row, index) => {
                const first = index === 0;
                const last = index === rows.length - 1;
                if (row.kind === "day") {
                    return (
                        <li key={row.key} className="flex gap-3">
                            <Rail first={first} last={last} />
                            <span className="pt-1 pb-0.5 text-sm text-muted-foreground">
                                {row.label}
                            </span>
                        </li>
                    );
                }
                return (
                    <li key={row.key} className="flex gap-3">
                        <Rail first={first} last={last} dot={row.event.tone} />
                        <div className="flex min-w-0 flex-1 items-start gap-3 py-1">
                            <EventText event={row.event} />
                            <When event={row.event} />
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}

export function ActivityPanel({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const events = collapseBursts(activityOf(state, model)).slice(0, 7);
    return (
        <PanelSection icon={History} title="Activity" description="Recent changes to this model.">
            <div className="flex min-w-0 flex-col gap-3">
                {events.length === 0 ? (
                    <p className="text-muted-foreground">
                        Nothing yet. Training, deploys and keys show here.
                    </p>
                ) : (
                    <Timeline events={events} />
                )}
                <Link
                    href={activityHref(model.slug)}
                    className="self-start text-primary hover:underline"
                >
                    All activity →
                </Link>
            </div>
        </PanelSection>
    );
}

function Dot({ tone }: { tone: ActivityTone }) {
    if (tone !== "failed") {
        return null;
    }
    return (
        <>
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-destructive" />
            <span className="sr-only">Failed:</span>
        </>
    );
}

export function FlowActivityPage() {
    const state = useFlowState();
    const slug = useSearchParam("model");
    const model = state.models.find((item) => item.slug === slug);
    const models = model ? [model] : state.models;
    const events = models
        .flatMap((item) => activityOf(state, item))
        .sort((a, b) => hoursOf(a) - hoursOf(b));
    const names = new Map(state.models.map((item) => [item.slug, item.name]));
    return (
        <Page>
            <Crumbs
                items={[
                    ...(model ? [{ label: model.name, href: modelHref(model.slug) }] : []),
                    { label: "Activity" },
                ]}
            />
            <PageHeader
                title="Activity"
                caption={
                    model ? (
                        <>
                            {`Stub of the audit log, filtered to ${model.name}. `}
                            <Link href={activityHref()} className="text-primary hover:underline">
                                Every model
                            </Link>
                        </>
                    ) : (
                        "Stub of the audit log for every model."
                    )
                }
            />
            <div className="overflow-x-auto rounded-lg border bg-card">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="pl-panel">When</TableHead>
                            <TableHead>Who</TableHead>
                            <TableHead>What</TableHead>
                            {!model && <TableHead>Model</TableHead>}
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {events.map((event) => (
                            <TableRow key={event.id}>
                                <TableCell className="pl-panel text-muted-foreground tabular-nums">
                                    {shortAgo(event)}
                                </TableCell>
                                <TableCell>
                                    {event.actor ?? (
                                        <span className="text-muted-foreground">System</span>
                                    )}
                                </TableCell>
                                <TableCell>
                                    <span className="flex items-center gap-2">
                                        <Dot tone={event.tone} />
                                        <Link href={event.href} className="hover:underline">
                                            {event.text}
                                        </Link>
                                    </span>
                                </TableCell>
                                {!model && (
                                    <TableCell>
                                        <Link
                                            href={modelHref(event.model)}
                                            className="text-primary hover:underline"
                                        >
                                            {names.get(event.model) ?? event.model}
                                        </Link>
                                    </TableCell>
                                )}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </Page>
    );
}
