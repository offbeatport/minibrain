import { useQuery } from "@tanstack/react-query";
import {
    Button,
    KbdHint,
    Link,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "obp-ui";
import type { ReactNode } from "react";
import { api, unwrap } from "~/api/client";
import { useModelPage } from "~/api/queries";
import type { components } from "~/api/schema";
import { Sparkline } from "~/components/Sparkline";
import { Requests } from "~/components/models/ModelMetrics";
import { StatusText } from "~/components/models/StatusText";
import type { Abilities } from "~/lib/access";
import { costText } from "~/lib/cost";
import { playgroundHref, trainingHref } from "~/lib/modelLinks";
import { REQUESTS_PATH, STATUS_TONES } from "~/lib/requests";
import { bytes, relativeTime } from "~/lib/time";
import { LiveStatus, ModelAvatar, Muted, StatusLineText } from "./cells";
import {
    type ListModel,
    candidateOf,
    costOf,
    deployed,
    hrefOf,
    isDeployed,
    liveOf,
    pct,
    plural,
    replicasOf,
    scoredVersions,
    statusLine,
    usageOf,
    variantLine,
} from "./model";
import type { Handlers } from "./rows";

type NextAction = components["schemas"]["NextAction"];

function Block({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-sm text-muted-foreground">{title}</h3>
            {children}
        </section>
    );
}

function Figure({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex min-w-0 flex-col">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="truncate font-semibold tabular-nums">{value}</span>
        </div>
    );
}

function ScoreTrend({ model }: { model: ListModel }) {
    const scored = scoredVersions(model);
    const live = liveOf(model);
    if (scored.length === 0) {
        return <p className="text-muted-foreground">Nothing scored yet.</p>;
    }
    const first = scored[0];
    const last = scored[scored.length - 1];
    return (
        <div className="flex flex-col gap-1.5">
            <Sparkline
                points={scored.map((version) => ({
                    key: String(version.number),
                    label: `v${version.number}${version.live ? " live" : ""}`,
                    value: version.score ?? 0,
                    marked: version.live,
                }))}
                width={400}
                height={64}
                label={`${model.name} score over versions`}
                format={pct}
            />
            <div className="flex justify-between gap-2 text-sm text-muted-foreground tabular-nums">
                <span>{`v${first.number} · ${pct(first.score)}`}</span>
                {live && (
                    <span className="flex items-center gap-1.5 text-foreground">
                        <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
                        {`live v${live.number} · ${pct(live.score)}`}
                    </span>
                )}
                {last !== first && <span>{`v${last.number} · ${pct(last.score)}`}</span>}
            </div>
        </div>
    );
}

function Variants({ model }: { model: ListModel }) {
    return (
        <ul className="flex flex-col divide-y rounded-md border">
            {model.variants.map((row) => {
                const line = variantLine(row);
                return (
                    <li key={row.key} className="flex items-center justify-between gap-3 px-3 py-2">
                        <span className="flex min-w-0 flex-col">
                            <span className="font-medium">
                                {[
                                    row.variant_label ?? row.name,
                                    row.size_bytes ? bytes(row.size_bytes) : null,
                                ]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </span>
                            <span className="truncate font-mono text-sm text-muted-foreground">
                                {row.key}
                            </span>
                        </span>
                        {isDeployed(row) && line.kind === "on" ? (
                            <LiveStatus replicas={row.replicas ?? []} />
                        ) : (
                            <StatusLineText
                                line={line}
                                name={row.name}
                                replicas={row.replicas ?? []}
                            />
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

function useLatest(keys: string[]) {
    return useQuery({
        queryKey: ["requests", "latest", ...keys],
        queryFn: () =>
            unwrap(api.GET("/api/requests", { params: { query: { model: keys, limit: 3 } } })),
        refetchInterval: 15000,
    });
}

function Latest({ model }: { model: ListModel }) {
    const keys = model.kind === "base" ? model.variants.map((row) => row.key) : [model.key];
    const found = useLatest(keys);
    const rows = found.data?.items ?? [];
    if (found.isLoading) {
        return <Muted>Loading…</Muted>;
    }
    if (rows.length === 0) {
        return <p className="text-muted-foreground">No requests yet.</p>;
    }
    return (
        <ul className="flex flex-col divide-y rounded-md border">
            {rows.map((row) => (
                <li key={row.id}>
                    <Link
                        href={`${REQUESTS_PATH}?model=${encodeURIComponent(row.model_key)}&range=all&request=${row.id}`}
                        className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-secondary"
                    >
                        <span className="flex min-w-0 items-center gap-2">
                            <StatusText tone={STATUS_TONES[row.status_class]}>
                                <span className="tabular-nums">{row.status}</span>
                            </StatusText>
                            <span className="truncate font-mono text-sm text-muted-foreground">
                                {row.version === null
                                    ? row.model
                                    : `${row.model_key}@${row.version}`}
                            </span>
                        </span>
                        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                            {`${Math.round(row.latency_ms)} ms · ${relativeTime(row.at)}`}
                        </span>
                    </Link>
                </li>
            ))}
        </ul>
    );
}

function nextLabel(next: NextAction): string {
    if (next.kind === "promote" && next.version !== null && next.version !== undefined) {
        return `Make v${next.version} live`;
    }
    return next.label;
}

function NextStep({ model, on }: { model: ListModel; on: Handlers }) {
    const page = useModelPage(model.row.key);
    const next = page.data?.next;
    if (!next) {
        return null;
    }
    const row = model.row;
    const version = model.versions.find((item) => item.number === next.version);
    const run: Record<NextAction["kind"], () => void> = {
        promote: () => (version ? on.makeLive(model, version) : on.open(hrefOf(model))),
        deploy: () => on.deploy([row]),
        review_feedback: () =>
            on.open(`/feedback?model=${encodeURIComponent(row.key)}&status=pending`),
        add_data: () => on.open(trainingHref(row.key)),
        train: () => on.open(trainingHref(row.key)),
        switch_base: () => on.switchBase(row, next.base ?? null),
        create_custom: () => on.createFrom(row),
    };
    return (
        <Block title="Next step">
            <div className="rounded-md border px-3 py-2">
                <button
                    type="button"
                    onClick={run[next.kind]}
                    className="rounded-sm text-left font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                    {`${nextLabel(next)} →`}
                </button>
            </div>
        </Block>
    );
}

function description(model: ListModel): string {
    if (model.kind === "base") {
        return model.variants.length > 1
            ? `Base · ${plural(model.variants.length, "variant")}`
            : `Base · ${model.row.variant_label ?? model.row.key}`;
    }
    const live = liveOf(model);
    return `On ${model.baseName} · ${live ? `v${live.number} live` : "not deployed"}`;
}

function Body({ model, on, can }: { model: ListModel; on: Handlers; can: Abilities }) {
    const usage = usageOf(model);
    const live = deployed(model);
    const candidate = can.build ? candidateOf(model) : undefined;
    const errors = usage?.total ? (usage.errors ?? 0) / usage.total : null;
    const cost = costOf(model);
    return (
        <>
            <SheetHeader>
                <div className="flex items-center gap-3">
                    <ModelAvatar model={model} />
                    <div className="flex min-w-0 flex-col">
                        <SheetTitle className="truncate">{model.name}</SheetTitle>
                        <SheetDescription>{description(model)}</SheetDescription>
                    </div>
                </div>
                <div className="pt-1">
                    <StatusLineText
                        line={statusLine(model)}
                        name={model.name}
                        replicas={replicasOf(model)}
                    />
                </div>
            </SheetHeader>
            {model.kind === "custom" ? (
                <Block title="Score over versions">
                    <ScoreTrend model={model} />
                </Block>
            ) : (
                <Block title={model.variants.length > 1 ? "Variants" : "Variant"}>
                    <Variants model={model} />
                </Block>
            )}
            <Block title="Requests, 7 days">
                <Requests usage={usage} live={live} />
            </Block>
            <div className="grid grid-cols-3 gap-4">
                <Figure
                    label="p95"
                    value={usage?.p95_ms != null ? `${Math.round(usage.p95_ms)} ms` : "—"}
                />
                <Figure label="Errors" value={errors === null ? "—" : pct(errors)} />
                <Figure label="Cost / 1k req." value={cost ? costText(cost) : "—"} />
            </div>
            <Block title="Latest requests">
                <Latest model={model} />
            </Block>
            {can.build && <NextStep model={model} on={on} />}
            <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => on.open(hrefOf(model))}>Open model</Button>
                {candidate && (
                    <Button variant="secondary" onClick={() => on.makeLive(model, candidate)}>
                        {`Make v${candidate.number} live`}
                    </Button>
                )}
                <Button variant="outline" onClick={() => on.open(playgroundHref(model.row.key))}>
                    Playground
                </Button>
            </div>
            <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1">
                <KbdHint keys={["↑", "↓"]}>move</KbdHint>
                <KbdHint keys={["Enter"]}>open</KbdHint>
                <KbdHint keys={["Esc"]}>close</KbdHint>
            </div>
        </>
    );
}

export function QuickLook({
    model,
    on,
    can,
    onClose,
    returnFocus,
}: {
    model: ListModel | null;
    on: Handlers;
    can: Abilities;
    onClose: () => void;
    returnFocus: () => HTMLElement | null;
}) {
    return (
        <Sheet open={model !== null} onOpenChange={(open) => !open && onClose()} modal={false}>
            <SheetContent initialFocus={false} finalFocus={returnFocus} className="sm:max-w-md">
                {model && <Body model={model} on={on} can={can} />}
            </SheetContent>
        </Sheet>
    );
}
