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
import { Requests } from "~/components/models/ModelMetrics";
import { Sparkline } from "./flowSparkline";
import {
    type FlowModel,
    beatsLive,
    liveVersion,
    modelHref,
    newestFirst,
    nextStep,
    pct,
    useFlowState,
} from "./modelsFlowData";
import { ModelAvatar } from "./modelsFlowParts";
import {
    AutopilotBadge,
    DeployButton,
    type Handlers,
    LiveStatus,
    autopilotText,
    gpuSeconds,
    plural,
    scoredVersions,
    usageOf,
} from "./modelsFlowRows";

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
        <div className="flex flex-col">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="font-semibold tabular-nums">{value}</span>
        </div>
    );
}

function ScoreTrend({ model }: { model: FlowModel }) {
    const scored = scoredVersions(model);
    const live = liveVersion(model);
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
                    label: `v${version.number}${version.number === live?.number ? " live" : ""}`,
                    value: version.scores?.[0] ?? 0,
                    marked: version.number === live?.number,
                }))}
                width={400}
                height={64}
                label={`${model.name} score over versions`}
                format={pct}
            />
            <div className="flex justify-between text-sm text-muted-foreground tabular-nums">
                <span>{`v${first.number} · ${pct(first.scores?.[0])}`}</span>
                {live && (
                    <span className="flex items-center gap-1.5 text-foreground">
                        <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
                        {`live v${live.number} · ${pct(live.scores?.[0])}`}
                    </span>
                )}
                <span>{`v${last.number} · ${pct(last.scores?.[0])}`}</span>
            </div>
        </div>
    );
}

function Variants({ model }: { model: FlowModel }) {
    return (
        <ul className="flex flex-col divide-y rounded-md border">
            {model.variants.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="flex flex-col">
                        <span className="font-medium">{`${item.format} · ${item.size}`}</span>
                        <span className="font-mono text-sm text-muted-foreground">
                            {item.apiName}
                        </span>
                    </span>
                    {item.live ? (
                        <LiveStatus machines={item.replicas} />
                    ) : (
                        <span className="text-muted-foreground">Not deployed</span>
                    )}
                </li>
            ))}
        </ul>
    );
}

function Body({ model, on }: { model: FlowModel; on: Handlers }) {
    const state = useFlowState();
    const live = liveVersion(model);
    const step = nextStep(state, model);
    const candidate = newestFirst(model).find((version) => beatsLive(model, version));
    const status = autopilotText(model);
    return (
        <>
            <SheetHeader>
                <div className="flex items-center gap-3">
                    <ModelAvatar model={model} />
                    <div className="flex min-w-0 flex-col">
                        <SheetTitle className="truncate">{model.name}</SheetTitle>
                        <SheetDescription>
                            {model.kind === "custom"
                                ? `On ${model.base} · ${live ? `v${live.number} live` : "not deployed"}`
                                : `Base · ${plural(model.variants.length, "variant")}`}
                        </SheetDescription>
                    </div>
                </div>
                {(model.autopilot || status) && (
                    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        {model.autopilot && <AutopilotBadge />}
                        {status && <span>{status}</span>}
                    </div>
                )}
            </SheetHeader>
            {model.kind === "custom" ? (
                <Block title="Score over versions">
                    <ScoreTrend model={model} />
                </Block>
            ) : (
                <Block title="Variants">
                    <Variants model={model} />
                </Block>
            )}
            <Block title="Requests, 7 days">
                <Requests
                    usage={usageOf(model.traffic, model.previous, model.deployed)}
                    live={model.deployed}
                />
            </Block>
            <div className="grid grid-cols-3 gap-4">
                <Figure label="p95" value={model.deployed ? `${model.p95} ms` : "—"} />
                <Figure
                    label="Errors"
                    value={model.deployed ? `${(model.errors * 100).toFixed(1)}%` : "—"}
                />
                <Figure label="Cost / 1k req." value={gpuSeconds(model.gpuSeconds)} />
            </div>
            <Block title="Last answers">
                {model.recent.length === 0 ? (
                    <p className="text-muted-foreground">No requests yet.</p>
                ) : (
                    <ul className="flex flex-col divide-y rounded-md border">
                        {model.recent.slice(0, 3).map((item) => (
                            <li key={item.question} className="flex flex-col gap-0.5 px-3 py-2">
                                <span className="flex items-baseline justify-between gap-3">
                                    <span className="truncate">{item.question}</span>
                                    <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                                        {item.minutesAgo < 60
                                            ? `${item.minutesAgo} min ago`
                                            : `${Math.round(item.minutesAgo / 60)} h ago`}
                                    </span>
                                </span>
                                <span className="truncate font-mono text-sm text-muted-foreground">
                                    {item.answer}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </Block>
            {step && (
                <Block title="Next step">
                    <div className="flex flex-col gap-0.5 rounded-md border px-3 py-2">
                        <Link href={step.href} className="font-medium text-primary hover:underline">
                            {`${step.label} →`}
                        </Link>
                        <span className="text-sm text-muted-foreground">{step.detail}</span>
                    </div>
                </Block>
            )}
            <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => on.open(modelHref(model.slug))}>Open model</Button>
                {candidate && (
                    <DeployButton model={model} version={candidate} on={on} size="default" full />
                )}
                {model.deployed && (
                    <Button variant="outline" onClick={() => on.open(modelHref(model.slug, "api"))}>
                        Use API
                    </Button>
                )}
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
    onClose,
    returnFocus,
}: {
    model: FlowModel | null;
    on: Handlers;
    onClose: () => void;
    returnFocus: () => HTMLElement | null;
}) {
    return (
        <Sheet open={model !== null} onOpenChange={(open) => !open && onClose()} modal={false}>
            <SheetContent initialFocus={false} finalFocus={returnFocus} className="sm:max-w-md">
                {model && <Body model={model} on={on} />}
            </SheetContent>
        </Sheet>
    );
}
