import { useParams, useRouter } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { Badge, Button, Link, TabNav, useToast } from "obp-ui";
import type { ReactNode } from "react";
import type { ModelUsage } from "~/api/client";
import { Facts } from "~/components/Facts";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { Page, Section, Stat } from "~/components/Section";
import { Requests } from "~/components/models/ModelMetrics";
import { ProgressBar, StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import {
    KeysTab,
    TrainingTab,
    VariantsTab,
    VersionsTab,
    trainBlock,
    useStartTraining,
} from "./flowModelTabs";
import { ModelMonitoring } from "./flowMonitoring";
import {
    type CatalogEntry,
    FLOW,
    type FlowModel,
    type ModelTab,
    baseModelSlug,
    bestCandidate,
    catalogEntry,
    compareHref,
    datasetHref,
    findVersion,
    flowHref,
    installBase,
    lastFailure,
    liveSplit,
    liveVersion,
    modelHref,
    nextStep,
    openIntent,
    pct,
    playgroundHref,
    points,
    retryWithQLoRA,
    scoreDelta,
    shortAgo,
    timeLeft,
    trainingVersion,
    useFlowModel,
    useFlowState,
    versionHref,
} from "./modelsFlowData";
import { Crumbs, Delta, ModelAvatar, OnApiSwitch, Tip, openConnect } from "./modelsFlowParts";

const TAB_LABELS: Record<ModelTab, string> = {
    overview: "Overview",
    versions: "Versions",
    training: "Training",
    monitoring: "Monitoring",
    keys: "API keys",
    variants: "Variants",
};

const ALIASES: Record<string, ModelTab> = { data: "training", api: "keys" };

function usageOf(model: FlowModel): ModelUsage | null {
    const total = model.traffic.reduce((sum, value) => sum + value, 0);
    if (total === 0 && !model.deployed) {
        return null;
    }
    return {
        days: [],
        daily: model.traffic,
        total,
        previous: model.previous,
        failed: Math.round(total * model.errors),
        last_at: new Date().toISOString(),
        p50_ms: null,
    };
}

function Panel({
    title,
    children,
    footer,
}: { title: string; children: ReactNode; footer?: ReactNode }) {
    return (
        <section className="flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-panel">
            <h2 className="text-base leading-tight font-semibold">{title}</h2>
            <div className="flex flex-1 flex-col gap-3">{children}</div>
            {footer && <div className="flex flex-wrap items-center gap-2">{footer}</div>}
        </section>
    );
}

function LivePanel({ model }: { model: FlowModel }) {
    const live = liveVersion(model);
    const zero = findVersion(model, 0);
    const canary = model.canary ? findVersion(model, model.canary.version) : undefined;
    if (!live) {
        return (
            <Panel title="Live">
                <p className="text-2xl">Nothing is live yet</p>
                <p className="text-muted-foreground">
                    {`Make a version live and ${model.slug} answers with it. Until then each version is still callable as ${model.slug}@N.`}
                </p>
            </Panel>
        );
    }
    return (
        <Panel
            title="Live"
            footer={
                <Link
                    href={modelHref(model.slug, "versions")}
                    className="text-primary hover:underline"
                >
                    {`All ${model.versions.length} versions →`}
                </Link>
            }
        >
            {canary && model.canary ? (
                <div className="flex flex-col gap-1">
                    <span className="text-2xl tabular-nums">
                        {`v${live.number} ${100 - model.canary.share}% · v${canary.number} ${model.canary.share}%`}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                        {`v${live.number} ${pct(live.scores?.[0])} · v${canary.number} ${pct(canary.scores?.[0])} canary${model.autopilot?.run ? `, ${model.autopilot.run.minutesLeft} min left` : ""}`}
                    </span>
                </div>
            ) : (
                <div className="flex items-baseline gap-3">
                    <Link
                        href={versionHref(model.slug, live.number)}
                        className="text-3xl tabular-nums hover:underline"
                    >
                        {`v${live.number} · ${pct(live.scores?.[0])}`}
                    </Link>
                    <span className="text-muted-foreground">{model.metrics[0].toLowerCase()}</span>
                </div>
            )}
            {zero?.scores && live.scores && zero.number !== live.number && (
                <p className="text-sm">
                    <Delta value={live.scores[0] - zero.scores[0]} suffix="vs v0 Baseline" />
                </p>
            )}
            <p className="text-sm text-muted-foreground">
                {`Scored on ${count(model.heldOut)} held-out rows. ${model.deployed ? `${model.slug} is on the API.` : `${model.slug} is off the API.`}`}
            </p>
        </Panel>
    );
}

function TrafficPanel({ model }: { model: FlowModel }) {
    const high = model.errors > model.usualErrors * 3;
    return (
        <Panel
            title="Traffic"
            footer={
                <Link
                    href={modelHref(model.slug, "monitoring")}
                    className="text-primary hover:underline"
                >
                    Monitoring →
                </Link>
            }
        >
            <Requests usage={usageOf(model)} live={model.deployed} />
            <div className="flex flex-wrap gap-x-8 gap-y-2">
                <Stat label="Latency p95" value={model.p95 ? `${model.p95} ms` : "–"} />
                <Stat
                    label="Errors"
                    value={
                        <span className={high ? "text-destructive" : undefined}>
                            {model.deployed ? `${(model.errors * 100).toFixed(1)}%` : "–"}
                        </span>
                    }
                />
            </div>
        </Panel>
    );
}

function StripRow({ children, actions }: { children: ReactNode; actions: ReactNode }) {
    return (
        <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-panel py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </li>
    );
}

function OtherVersions({ model }: { model: FlowModel }) {
    const router = useRouter();
    const toast = useToast();
    const training = trainingVersion(model);
    const candidate = model.live !== null ? bestCandidate(model) : undefined;
    const failure = lastFailure(model);
    const newestFailure =
        failure &&
        !model.versions.some(
            (version) => version.number > failure.number && version.status === "ready",
        )
            ? failure
            : undefined;
    if (!training && !candidate && !newestFailure) {
        return null;
    }
    const delta = candidate ? scoreDelta(model, candidate) : null;
    const memory = /memory/i.test(newestFailure?.error ?? "");
    return (
        <Section
            title="Other versions"
            caption="Only what is worth acting on. Every version is in the Versions tab."
            flush
        >
            <ul className="divide-y">
                {training && (
                    <StripRow
                        actions={
                            <Button variant="outline" asChild>
                                <Link href={versionHref(model.slug, training.number, "training")}>
                                    Watch
                                </Link>
                            </Button>
                        }
                    >
                        <span className="flex flex-wrap items-baseline gap-x-2">
                            <Link
                                href={versionHref(model.slug, training.number)}
                                className="font-medium hover:underline"
                            >
                                {`v${training.number} is training`}
                            </Link>
                            <span className="text-sm text-muted-foreground tabular-nums">
                                {`${Math.round((training.progress ?? 0) * 100)}% · ${timeLeft(training)} left`}
                            </span>
                        </span>
                        <ProgressBar
                            value={training.progress ?? 0}
                            label={`v${training.number} progress`}
                            className="w-full max-w-96"
                        />
                    </StripRow>
                )}
                {candidate && delta !== null && model.live !== null && (
                    <StripRow
                        actions={
                            <>
                                <Button variant="outline" asChild>
                                    <Link href={playgroundHref(model.slug, candidate.number)}>
                                        Try in Playground
                                    </Link>
                                </Button>
                                <Button variant="outline" asChild>
                                    <Link
                                        href={compareHref(model.slug, model.live, candidate.number)}
                                    >
                                        Compare
                                    </Link>
                                </Button>
                                <Button
                                    onClick={() =>
                                        openIntent({
                                            kind: "make-live",
                                            slug: model.slug,
                                            number: candidate.number,
                                        })
                                    }
                                >
                                    Make live
                                </Button>
                            </>
                        }
                    >
                        <Link
                            href={versionHref(model.slug, candidate.number)}
                            className="font-medium hover:underline"
                        >
                            {`v${candidate.number} beats live by ${points(delta)}`}
                        </Link>
                        <span className="text-sm text-muted-foreground tabular-nums">
                            {`${pct(candidate.scores?.[0])} against ${pct(liveVersion(model)?.scores?.[0])} for v${model.live}; passed the promotion rule · ${shortAgo(candidate)}`}
                        </span>
                    </StripRow>
                )}
                {newestFailure && (
                    <StripRow
                        actions={
                            <>
                                <Button variant="outline" asChild>
                                    <Link
                                        href={versionHref(
                                            model.slug,
                                            newestFailure.number,
                                            "training",
                                        )}
                                    >
                                        Open
                                    </Link>
                                </Button>
                                {memory && (
                                    <Tip tip={trainBlock(model)}>
                                        <Button
                                            variant="outline"
                                            disabled={Boolean(trainBlock(model))}
                                            onClick={() => {
                                                const number = retryWithQLoRA(
                                                    model.slug,
                                                    newestFailure.number,
                                                );
                                                toast({
                                                    title: `v${number} is training with QLoRA`,
                                                    tone: "success",
                                                });
                                                router.history.push(
                                                    versionHref(model.slug, number, "training"),
                                                );
                                            }}
                                        >
                                            Retry with QLoRA
                                        </Button>
                                    </Tip>
                                )}
                            </>
                        }
                    >
                        <span className="font-medium">
                            {`v${newestFailure.number} failed${memory ? ": out of memory" : ""}`}
                        </span>
                        <span className="truncate text-sm text-muted-foreground">
                            {`${shortAgo(newestFailure)} · ${newestFailure.error ?? ""}`}
                        </span>
                    </StripRow>
                )}
            </ul>
        </Section>
    );
}

function NextPanel({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const step = nextStep(state, model);
    return (
        <Panel title="Next step">
            {step ? (
                <>
                    <p className="font-medium">{step.label}</p>
                    <p className="text-muted-foreground">{step.detail}</p>
                </>
            ) : (
                <p className="text-muted-foreground">
                    Nothing waits. Feedback from the API arrives on the Feedback page.
                </p>
            )}
        </Panel>
    );
}

function Details({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const data = state.datasets.find((item) => item.slug === model.dataset);
    const items: [string, ReactNode][] = [
        [
            "Base",
            <Link
                key="base"
                href={modelHref(model.base ? baseModelSlug(model.base) : model.slug)}
                className="text-primary hover:underline"
            >
                {model.base}
            </Link>,
        ],
        [
            "Data",
            data ? (
                <Link
                    key="data"
                    href={datasetHref(data.slug)}
                    className="text-primary hover:underline"
                >{`${data.name} v${data.version}`}</Link>
            ) : (
                "None yet"
            ),
        ],
        [
            "API name",
            <span key="api" className="font-mono text-sm">
                {`${model.slug}, ${model.slug}@N`}
            </span>,
        ],
        ["Licence", model.licence],
        ["Task", model.task],
    ];
    return (
        <Section title="Details">
            <Facts items={items} />
        </Section>
    );
}

function Overview({ model }: { model: FlowModel }) {
    return (
        <div className="flex flex-col gap-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <LivePanel model={model} />
                <TrafficPanel model={model} />
            </div>
            <OtherVersions model={model} />
            <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <NextPanel model={model} />
                <Details model={model} />
            </div>
        </div>
    );
}

function builtOn(models: FlowModel[], base: string): FlowModel[] {
    return models.filter(
        (model) => model.kind === "custom" && model.base && baseModelSlug(model.base) === base,
    );
}

function CatalogFacts({ entry, model }: { entry: CatalogEntry | undefined; model?: FlowModel }) {
    return (
        <Section title="About">
            <Facts
                items={[
                    ["Publisher", entry?.publisher ?? model?.publisher ?? "–"],
                    ["Parameters", entry?.params ?? "–"],
                    ["Context", entry?.context ?? "–"],
                    ["Licence", entry?.licence ?? model?.licence ?? "–"],
                    ["Memory to serve", entry?.memory ?? "–"],
                    [
                        "Training",
                        entry?.serveOnly || model?.serveOnly
                            ? "Serve-only: cannot be trained"
                            : "LoRA and QLoRA",
                    ],
                ]}
            />
        </Section>
    );
}

function BaseOverview({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const entry = catalogEntry(model.slug);
    const children = builtOn(state.models, model.slug);
    const live = model.variants.filter((item) => item.live).length;
    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <CatalogFacts entry={entry} model={model} />
            <div className="flex flex-col gap-4">
                <Section
                    title="Installed"
                    actions={
                        <Button variant="outline" asChild>
                            <Link href={modelHref(model.slug, "variants")}>Variants</Link>
                        </Button>
                    }
                >
                    <Facts
                        items={[
                            [
                                "Formats",
                                <span key="f" className="tabular-nums">
                                    {`${model.variants.map((item) => item.format).join(", ")} · ${live} on the API`}
                                </span>,
                            ],
                            [
                                "gpu-a10-1 (24 GB)",
                                <StatusText key="g" tone="success">
                                    Serves and trains
                                </StatusText>,
                            ],
                            [
                                "cpu-pool",
                                <span key="c" className="text-muted-foreground">
                                    Serves GGUF slowly; cannot train
                                </span>,
                            ],
                        ]}
                    />
                </Section>
                <Section title="Built on it" flush>
                    {children.length === 0 ? (
                        <p className="px-panel pb-panel text-muted-foreground">
                            No custom models yet.
                        </p>
                    ) : (
                        <ul className="divide-y">
                            {children.map((child) => (
                                <li key={child.slug}>
                                    <Link
                                        href={modelHref(child.slug)}
                                        className="flex items-center gap-3 px-panel py-2.5 hover:bg-secondary"
                                    >
                                        <ModelAvatar model={child} />
                                        <span className="flex-1 font-medium">{child.name}</span>
                                        <span className="text-sm text-muted-foreground">
                                            {liveSplit(child) ?? "Nothing live"}
                                        </span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                </Section>
            </div>
        </div>
    );
}

function PrimaryAction({ model }: { model: FlowModel }) {
    const state = useFlowState();
    const router = useRouter();
    const train = useStartTraining(model);
    if (model.kind === "base") {
        return (
            <Button asChild>
                <Link href={`${FLOW}/models/new?base=${model.slug}`}>Add a model on it</Link>
            </Button>
        );
    }
    const step = nextStep(state, model);
    if (!step) {
        return null;
    }
    if (step.action === "train") {
        const blocked = trainBlock(model);
        return (
            <Tip tip={blocked}>
                <Button disabled={Boolean(blocked)} onClick={() => train()}>
                    {step.label}
                </Button>
            </Tip>
        );
    }
    if (step.action === "retry" && step.version !== undefined) {
        const failed = step.version;
        return (
            <Button
                onClick={() => {
                    const number = retryWithQLoRA(model.slug, failed);
                    router.history.push(versionHref(model.slug, number, "training"));
                }}
            >
                {step.label}
            </Button>
        );
    }
    if (step.action === "make-live" && step.version !== undefined) {
        const number = step.version;
        return (
            <Button onClick={() => openIntent({ kind: "make-live", slug: model.slug, number })}>
                {step.label}
            </Button>
        );
    }
    return (
        <Button variant={step.label.startsWith("Training") ? "outline" : "default"} asChild>
            <Link href={step.href}>{step.label}</Link>
        </Button>
    );
}

function Header({ model }: { model: FlowModel }) {
    const canPlay =
        model.kind === "base" || model.versions.some((version) => version.status === "ready");
    const caption =
        model.kind === "base"
            ? `Base · ${model.size} · ${model.licence}`
            : `On ${model.base} · ${liveSplit(model) ?? "nothing live yet"}`;
    return (
        <PageHeader
            title={model.name}
            icon={<ModelAvatar model={model} size="lg" />}
            badge={<Badge variant="outline">{model.kind === "base" ? "Base" : "Custom"}</Badge>}
            caption={caption}
            actions={
                <>
                    <OnApiSwitch model={model} />
                    {canPlay && (
                        <Button variant="outline" asChild>
                            <Link href={playgroundHref(model.slug)}>
                                <Play aria-hidden="true" />
                                Open in Playground
                            </Link>
                        </Button>
                    )}
                    <Button variant="outline" onClick={() => openConnect(model.slug)}>
                        Connect
                    </Button>
                    <PrimaryAction model={model} />
                </>
            }
        />
    );
}

function tabsOf(model: FlowModel): ModelTab[] {
    return model.kind === "base"
        ? ["overview", "variants", "monitoring", "keys"]
        : ["overview", "versions", "training", "monitoring", "keys"];
}

function tabOf(value: string | undefined, model: FlowModel): ModelTab {
    const wanted = value ? (ALIASES[value] ?? value) : "overview";
    return tabsOf(model).find((tab) => tab === wanted) ?? "overview";
}

function CatalogOnly({ entry }: { entry: CatalogEntry }) {
    const toast = useToast();
    return (
        <Page>
            <Crumbs
                items={[{ label: "Discover", href: `${FLOW}/discover` }, { label: entry.name }]}
            />
            <PageHeader
                title={entry.name}
                icon={<PublisherLogo publisher={entry.publisher} name={entry.name} size="lg" />}
                badge={<Badge variant="outline">Base</Badge>}
                caption={`Not installed · ${entry.summary}`}
                actions={
                    <>
                        <Button
                            variant="outline"
                            onClick={() => {
                                installBase(entry.id);
                                toast({
                                    title: `${entry.name} is installed`,
                                    description: `Downloaded ${entry.size}; its BF16 variant is ready to put on the API.`,
                                    tone: "success",
                                });
                            }}
                        >
                            {`Download ${entry.size}`}
                        </Button>
                        <Button asChild>
                            <Link href={`${FLOW}/models/new?base=${entry.id}`}>
                                Add a model on it
                            </Link>
                        </Button>
                    </>
                }
            />
            <div className="grid gap-4 lg:grid-cols-2">
                <CatalogFacts entry={entry} />
                <Section title="Runs here">
                    <Facts
                        items={[
                            ["Download", entry.size],
                            [
                                "gpu-a10-1 (24 GB)",
                                <StatusText key="g" tone="success">
                                    Serves and trains
                                </StatusText>,
                            ],
                            [
                                "cpu-pool",
                                <span key="c" className="text-muted-foreground">
                                    Serves slowly; cannot train
                                </span>,
                            ],
                        ]}
                    />
                </Section>
            </div>
        </Page>
    );
}

export function FlowModelPage() {
    const params = useParams({ strict: false }) as {
        model?: string;
        tab?: string;
    };
    const model = useFlowModel(params.model);
    const entry = catalogEntry(params.model);
    if (!model && entry) {
        return <CatalogOnly entry={entry} />;
    }
    if (!model) {
        return (
            <Page>
                <Crumbs
                    items={[{ label: "Models", href: flowHref() }, { label: params.model ?? "" }]}
                />
                <p className="text-muted-foreground">{`No model called ${params.model}.`}</p>
            </Page>
        );
    }
    const tab = tabOf(params.tab, model);
    return (
        <Page>
            <Crumbs items={[{ label: "Models", href: flowHref() }, { label: model.name }]} />
            <Header model={model} />
            <TabNav
                label={`${model.name} pages`}
                tabs={tabsOf(model).map((item) => ({
                    href: modelHref(model.slug, item),
                    label: TAB_LABELS[item],
                }))}
            />
            <div className="pt-2">
                {tab === "overview" &&
                    (model.kind === "base" ? (
                        <BaseOverview model={model} />
                    ) : (
                        <Overview model={model} />
                    ))}
                {tab === "versions" && <VersionsTab model={model} />}
                {tab === "training" && <TrainingTab model={model} />}
                {tab === "monitoring" && <ModelMonitoring model={model} />}
                {tab === "keys" && <KeysTab model={model} />}
                {tab === "variants" && <VariantsTab model={model} />}
            </div>
        </Page>
    );
}
