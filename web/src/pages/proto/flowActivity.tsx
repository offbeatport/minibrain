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
import { useRef, useState } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { useSearchParam } from "~/lib/listSearch";
import { pointersOf } from "./flowUsage";
import {
    FLOW,
    type FlowModel,
    type FlowState,
    type FlowVersion,
    baseModelSlug,
    beatsLive,
    jobHref,
    modelHref,
    pct,
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

export type ActivityEvent = {
    id: string;
    model: string;
    actor: string | null;
    text: string;
    hoursAgo: number;
    atMs?: number;
    href: string;
    failed?: boolean;
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

function trainedText(model: FlowModel, version: FlowVersion): string {
    const score = pct(version.scores?.[0]);
    if (version.kind === "prompt") {
        return `v0 Baseline scored ${score}`;
    }
    if (!version.passed) {
        return `v${version.number} trained · ${score}, below rule`;
    }
    const newer = model.live === null || version.number > model.live;
    return newer && beatsLive(model, version)
        ? `v${version.number} trained · ${score}, beats live`
        : `v${version.number} trained · ${score}, passed`;
}

function versionEvents(model: FlowModel): ActivityEvent[] {
    const actor = firstName(model.slug);
    return model.versions.map((version) => {
        const base = {
            id: `${model.slug}:v${version.number}`,
            model: model.slug,
            hoursAgo: version.hoursAgo,
            atMs: version.atMs,
        };
        if (version.status === "training") {
            return {
                ...base,
                actor: version.atMs ? "You" : actor,
                text: `started training v${version.number}`,
                href: jobHref(version.jobId),
            };
        }
        if (version.status === "failed") {
            const memory = /memory/i.test(version.error ?? "");
            return {
                ...base,
                actor: null,
                text: `v${version.number} failed${memory ? ": out of memory" : ""}`,
                href: versionHref(model.slug, version.number),
                failed: true,
            };
        }
        return {
            ...base,
            actor: null,
            text: trainedText(model, version),
            href: versionHref(model.slug, version.number),
        };
    });
}

function liveEvents(model: FlowModel): ActivityEvent[] {
    const actor = firstName(model.slug);
    return pointersOf(model).map((pointer, index) => ({
        id: `${model.slug}:live:${index}`,
        model: model.slug,
        actor: pointer.canary ? null : actor,
        text: pointer.canary
            ? `Autopilot started a v${pointer.canary.version} canary at ${pointer.canary.share}%`
            : index === 0
              ? `deployed ${model.slug} with v${pointer.version}`
              : `made v${pointer.version} live`,
        hoursAgo: pointer.hoursAgo,
        href: versionHref(model.slug, pointer.canary?.version ?? pointer.version),
    }));
}

function keyEvents(state: FlowState, model: FlowModel): ActivityEvent[] {
    return (state.keys[model.slug] ?? []).map((key) => ({
        id: `${model.slug}:key:${key.id}`,
        model: model.slug,
        actor: key.atMs ? "You" : firstName(model.slug),
        text: `created API key ${KEY_NAMES[key.id] ?? key.prefix}`,
        hoursAgo: key.hoursAgo,
        atMs: key.atMs,
        href: modelHref(model.slug, "keys"),
    }));
}

function jobEvents(state: FlowState, model: FlowModel): ActivityEvent[] {
    return state.jobs
        .filter((job) => job.model === model.slug && job.kind === "export")
        .map((job) => ({
            id: `${model.slug}:job:${job.id}`,
            model: model.slug,
            actor: "You",
            text: `exported v${job.version} as ${job.format?.toUpperCase().replace("-", " ") ?? "files"}`,
            hoursAgo: job.hoursAgo,
            atMs: job.atMs,
            href: jobHref(job.id),
        }));
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
            hoursAgo: first && !first.atMs ? first.hoursAgo + 0.5 : 0,
            atMs: first?.atMs ? first.atMs - 1000 : undefined,
            href: modelHref(model.slug),
        },
        ...versionEvents(model),
        ...liveEvents(model),
        ...keyEvents(state, model),
        ...jobEvents(state, model),
    ];
    if (owner.switches && firstTrained && model.base) {
        events.push({
            id: `${model.slug}:switch`,
            model: model.slug,
            actor: firstName(model.slug),
            text: `switched the base to ${model.base}`,
            hoursAgo: firstTrained.hoursAgo + DAY,
            href: modelHref(baseModelSlug(model.base)),
        });
    }
    if (model.accepted > 0) {
        events.push({
            id: `${model.slug}:feedback`,
            model: model.slug,
            actor: firstName(model.slug),
            text: `accepted ${model.accepted} feedback rows`,
            hoursAgo: 2 * DAY,
            href: `${FLOW}/feedback`,
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
            text:
                fetched.kind === "import"
                    ? `imported ${first.format}, ${first.size}`
                    : `downloaded ${first.format}, ${first.size}`,
            hoursAgo: start,
            href: jobHref(fetched.id),
        });
    }
    model.variants.forEach((variant, index) => {
        if (index > 0) {
            events.push({
                id: `${model.slug}:variant:${variant.id}`,
                model: model.slug,
                actor: ADMIN,
                text: `added ${variant.format}, ${variant.size}`,
                hoursAgo: start - index * 3,
                href: variantsHref,
            });
        }
        if (variant.live) {
            events.push({
                id: `${model.slug}:deploy:${variant.id}`,
                model: model.slug,
                actor: index === 0 ? ADMIN : "Dana",
                text: `deployed ${variant.apiName}`,
                hoursAgo: index === 0 ? start - 1 : start / (index + 2),
                href: variantsHref,
            });
        }
        if (variant.update) {
            events.push({
                id: `${model.slug}:update:${variant.id}`,
                model: model.slug,
                actor: null,
                text: `Update available for ${variant.format}`,
                hoursAgo: 30,
                href: variantsHref,
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
            hoursAgo: oldest + 0.5,
            href: modelHref(child.slug),
        });
    }
    return [...events, ...keyEvents(state, model)];
}

export function activityOf(state: FlowState, model: FlowModel): ActivityEvent[] {
    const events = model.kind === "base" ? baseEvents(state, model) : customEvents(state, model);
    return events.sort((a, b) => hoursOf(a) - hoursOf(b));
}

export function activityHref(slug?: string): string {
    return `${FLOW}/activity${slug ? `?model=${slug}` : ""}`;
}

function overflowing(element: HTMLElement | null): boolean {
    return element !== null && element.scrollWidth > element.clientWidth;
}

export function Clipped({ text, className }: { text: string; className?: string }) {
    const ref = useRef<HTMLSpanElement>(null);
    const [open, setOpen] = useState(false);
    return (
        <Tooltip open={open} onOpenChange={(next) => setOpen(next && overflowing(ref.current))}>
            <TooltipTrigger asChild>
                <span ref={ref} className={`min-w-0 truncate ${className ?? ""}`}>
                    {text}
                </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{text}</TooltipContent>
        </Tooltip>
    );
}

function Dot({ failed }: { failed?: boolean }) {
    if (!failed) {
        return null;
    }
    return (
        <>
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-destructive" />
            <span className="sr-only">Failed:</span>
        </>
    );
}

export function ActivityPanel({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const events = activityOf(state, model).slice(0, 8);
    return (
        <section
            aria-labelledby="activity-title"
            className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-panel"
        >
            <h2 id="activity-title" className="text-base leading-tight font-semibold">
                Activity
            </h2>
            {events.length === 0 ? (
                <p className="text-muted-foreground">Nothing yet.</p>
            ) : (
                <ol className="-mx-2 flex flex-col">
                    {events.map((event) => (
                        <li key={event.id}>
                            <Link
                                href={event.href}
                                className="flex h-8 items-center gap-2 rounded-md px-2 hover:bg-secondary"
                            >
                                <Dot failed={event.failed} />
                                <Clipped text={sentence(event)} className="flex-1" />
                                <time
                                    dateTime={new Date(
                                        event.atMs ?? Date.now() - event.hoursAgo * 3600000,
                                    ).toISOString()}
                                    className="shrink-0 text-sm text-muted-foreground tabular-nums"
                                >
                                    {shortAgo(event)}
                                </time>
                            </Link>
                        </li>
                    ))}
                </ol>
            )}
            <Link
                href={activityHref(model.slug)}
                className="self-start text-primary hover:underline"
            >
                All activity →
            </Link>
        </section>
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
                                        <Dot failed={event.failed} />
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
