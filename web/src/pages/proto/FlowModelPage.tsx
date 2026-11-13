import { useParams } from "@tanstack/react-router";
import { Badge, Button, Link, TabNav, useToast } from "obp-ui";
import type { ReactNode } from "react";
import { Facts } from "~/components/Facts";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { Page, PanelSections, Section } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { ActivityPanel } from "./flowActivity";
import { About, BaseAbout, BaseDetails, Details } from "./flowDetails";
import { ModelHeader } from "./flowHeader";
import { KeysTab, TrainingTab, VariantsTab, VersionsTab } from "./flowModelTabs";
import { ModelMonitoring } from "./flowMonitoring";
import { useCan } from "./flowOverlays";
import { SettingsTab } from "./flowSettings";
import { UsagePanel } from "./flowUsagePanel";
import {
    type CatalogEntry,
    FLOW,
    type FlowModel,
    type ModelTab,
    catalogEntry,
    flowHref,
    installBase,
    modelHref,
    useFlowModel,
} from "./modelsFlowData";
import { Crumbs } from "./modelsFlowParts";

const TAB_LABELS: Record<ModelTab, string> = {
    overview: "Overview",
    versions: "Versions",
    training: "Training",
    monitoring: "Monitoring",
    keys: "API keys",
    variants: "Variants",
    settings: "Settings",
};

const ALIASES: Record<string, ModelTab> = { data: "training", api: "keys" };

function OverviewLayout({ main, side }: { main: ReactNode; side: ReactNode }) {
    return (
        <div className="@container">
            <div className="grid items-start gap-6 @5xl:grid-cols-[minmax(0,1fr)_20rem]">
                <div className="min-w-0">
                    <PanelSections>{main}</PanelSections>
                </div>
                <div className="min-w-0">
                    <PanelSections>{side}</PanelSections>
                </div>
            </div>
        </div>
    );
}

function Overview({ model }: { model: FlowModel }) {
    return (
        <OverviewLayout
            main={
                <>
                    <UsagePanel model={model} />
                    {model.kind === "base" ? (
                        <>
                            <BaseAbout model={model} />
                            <BaseDetails model={model} />
                        </>
                    ) : (
                        <>
                            <About model={model} />
                            <Details model={model} />
                        </>
                    )}
                </>
            }
            side={<ActivityPanel model={model} />}
        />
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

function tabsOf(model: FlowModel, builder: boolean): ModelTab[] {
    if (model.kind === "base") {
        return builder
            ? ["overview", "variants", "monitoring", "keys", "settings"]
            : ["overview", "variants", "monitoring", "keys"];
    }
    return builder
        ? ["overview", "versions", "training", "monitoring", "keys", "settings"]
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
                                    title: `Downloading ${entry.name}`,
                                    description: `${entry.size} to storage. Nothing loads on a GPU until it is deployed or tried.`,
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
                {tab === "overview" && <Overview model={model} />}
                {tab === "versions" && <VersionsTab model={model} />}
                {tab === "training" && <TrainingTab model={model} />}
                {tab === "monitoring" && <ModelMonitoring model={model} />}
                {tab === "keys" && <KeysTab model={model} />}
                {tab === "variants" && <VariantsTab model={model} />}
                {tab === "settings" && <SettingsTab key={model.slug} model={model} />}
            </div>
        </Page>
    );
}
