import { useParams } from "@tanstack/react-router";
import { Badge, Button, Link, TabNav, useToast } from "obp-ui";
import type { ReactNode } from "react";
import { Facts } from "~/components/Facts";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { Page, Section } from "~/components/Section";
import { ProgressBar, StatusText } from "~/components/models/StatusText";
import { FactSheet } from "./flowFactSheet";
import { ModelHeader } from "./flowHeader";
import { KeysTab, TrainingTab, VariantsTab, VersionsTab } from "./flowModelTabs";
import { ModelMonitoring } from "./flowMonitoring";
import { useCan } from "./flowOverlays";
import { UsagePanel } from "./flowUsagePanel";
import {
    type CatalogEntry,
    FLOW,
    type FlowModel,
    type ModelTab,
    baseModelSlug,
    bestCandidate,
    catalogEntry,
    compareHref,
    flowHref,
    installBase,
    jobHref,
    lastFailure,
    liveSplit,
    liveVersion,
    modelHref,
    pct,
    playgroundHref,
    points,
    scoreDelta,
    shortAgo,
    timeLeft,
    trainingVersion,
    useFlowModel,
    useFlowState,
    versionHref,
} from "./modelsFlowData";
import { Crumbs, ModelAvatar } from "./modelsFlowParts";

const TAB_LABELS: Record<ModelTab, string> = {
    overview: "Overview",
    versions: "Versions",
    training: "Training",
    monitoring: "Monitoring",
    keys: "API keys",
    variants: "Variants",
};

const ALIASES: Record<string, ModelTab> = { data: "training", api: "keys" };

function StripRow({ children, actions }: { children: ReactNode; actions: ReactNode }) {
    return (
        <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-panel py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </li>
    );
}

function Attention({ model }: { model: FlowModel }) {
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
    const delta = candidate ? scoreDelta(model, candidate) : null;
    const memory = /memory/i.test(newestFailure?.error ?? "");
    const quiet = !training && !candidate && !newestFailure;
    return (
        <Section
            title="Versions that need attention"
            caption={
                quiet
                    ? "None right now. Every version is in the Versions tab."
                    : "Training, a better candidate and the last failure. Every version is in the Versions tab."
            }
            actions={
                <Link
                    href={modelHref(model.slug, "versions")}
                    className="text-primary hover:underline"
                >
                    {model.versions.length === 1
                        ? "1 version →"
                        : `All ${model.versions.length} versions →`}
                </Link>
            }
            flush
        >
            {!quiet && (
                <ul className="divide-y">
                    {training && (
                        <StripRow
                            actions={
                                <Button variant="outline" asChild>
                                    <Link href={jobHref(training.jobId)}>Watch</Link>
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
                                            href={compareHref(
                                                model.slug,
                                                model.live,
                                                candidate.number,
                                            )}
                                        >
                                            Compare
                                        </Link>
                                    </Button>
                                </>
                            }
                        >
                            <Link
                                href={versionHref(model.slug, candidate.number)}
                                className="font-medium hover:underline"
                            >
                                {`v${candidate.number} is the best candidate: ${points(delta)} over live`}
                            </Link>
                            <span className="text-sm text-muted-foreground tabular-nums">
                                {`${pct(candidate.scores?.[0])} against ${pct(liveVersion(model)?.scores?.[0])} for v${model.live}; passed the promotion rule · ${shortAgo(candidate)}`}
                            </span>
                        </StripRow>
                    )}
                    {newestFailure && (
                        <StripRow
                            actions={
                                <Button variant="outline" asChild>
                                    <Link href={versionHref(model.slug, newestFailure.number)}>
                                        Open
                                    </Link>
                                </Button>
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
            )}
        </Section>
    );
}

function Overview({ model }: { model: FlowModel }) {
    return (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
            <div className="flex min-w-0 flex-col gap-4">
                <UsagePanel model={model} />
                <Attention model={model} />
            </div>
            <FactSheet model={model} />
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
                                    {`${model.variants.map((item) => item.format).join(", ")} · ${live} deployed`}
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
                                            {liveSplit(child) ?? "Not deployed"}
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

function tabsOf(model: FlowModel, builder: boolean): ModelTab[] {
    if (model.kind === "base") {
        return ["overview", "variants", "monitoring", "keys"];
    }
    return builder
        ? ["overview", "versions", "training", "monitoring", "keys"]
        : ["overview", "versions", "monitoring", "keys"];
}

function tabOf(value: string | undefined, tabs: ModelTab[]): ModelTab {
    const wanted = value ? (ALIASES[value] ?? value) : "overview";
    return tabs.find((tab) => tab === wanted) ?? "overview";
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
                                    description: `Downloaded ${entry.size}; its BF16 variant is ready to deploy.`,
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
    const builder = useCan("builder");
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
    const tabs = tabsOf(model, builder);
    const tab = tabOf(params.tab, tabs);
    return (
        <Page wide>
            <Crumbs items={[{ label: "Models", href: flowHref() }, { label: model.name }]} />
            <div className="flex flex-col gap-3">
                <ModelHeader model={model} />
                <TabNav
                    label={`${model.name} pages`}
                    tabs={tabs.map((item) => ({
                        href: modelHref(model.slug, item),
                        label: TAB_LABELS[item],
                    }))}
                />
            </div>
            <div>
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
