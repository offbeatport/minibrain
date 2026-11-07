import { useRouter, useRouterState } from "@tanstack/react-router";
import { Database, Info, ListChecks, ThumbsUp } from "lucide-react";
import { Button, Link } from "obp-ui";
import { type ReactNode, useState } from "react";
import { type ModelDetail, type ModelRow, type NextAction, api, unwrap } from "~/api/client";
import {
    isActiveJob,
    useBaseModel,
    useJobs,
    useModel,
    useModelPage,
    usePresets,
    useVersions,
} from "~/api/queries";
import { BlockedButton } from "~/components/BlockedButton";
import { Facts } from "~/components/Facts";
import { FeedbackSince } from "~/components/FeedbackSince";
import { JobPanel } from "~/components/JobPanel";
import { PanelSection, PanelSections } from "~/components/Section";
import { TestExamples } from "~/components/TestExamples";
import type { HealthAction } from "~/components/models/HealthStatus";
import { useCan } from "~/lib/access";
import { count, percent } from "~/lib/format";
import { metricName } from "~/lib/metrics";
import {
    type ModelTab,
    deploymentPageHref,
    evaluationsHref,
    modelCardHref,
    modelDataHref,
    modelPageHref,
    trainingHref,
} from "~/lib/modelLinks";
import { beingDeleted, busyTearingDown } from "~/lib/teardown";
import { relativeTime } from "~/lib/time";
import { ModelDataNotice } from "../../data/versionData";
import { DuplicateModelDialog } from "../DuplicateModelDialog";
import { InstructionsSection } from "../InstructionsSection";
import { JudgedSection } from "../JudgedSection";
import { LabelProposalNotice } from "../LabelProposal";
import { SwitchBaseDialog } from "../SwitchBaseDialog";
import { ConfirmAction, type Confirmation, EditModelDialog, useModelsRefresh } from "../dialogs";
import { CustomFiles, FilesSheet, adapterText, liveVersion } from "./files";
import { NextRow, QualityRow, SummaryCard, TrafficRow, TryIt, WeightsRow } from "./overview";
import {
    ApiTab,
    HealthNotice,
    ModelHeader,
    ModelTabs,
    TeardownNotice,
    activityFacts,
    baseFacts,
    deployConfirmation,
    updatedFacts,
} from "./parts";
import { VersionTimeline } from "./timeline";

function promoteConfirmation(
    row: ModelRow,
    number: number,
    after: () => Promise<unknown>,
): Confirmation {
    return {
        title: `Deploy v${number} of ${row.name}?`,
        description: <p>{`Requests to ${row.key} are answered by v${number} from now on.`}</p>,
        confirmLabel: `Deploy v${number}`,
        run: () =>
            unwrap(
                api.POST("/api/models/{slug}/versions/{number}/promote", {
                    params: { path: { slug: row.key, number } },
                }),
            ).then(after),
    };
}

function TrainingData({ detail }: { detail: ModelDetail }) {
    const can = useCan();
    const version = detail.dataset_version;
    const facts: [string, ReactNode][] = [
        ["Dataset", detail.dataset_name ?? detail.source?.file ?? "None yet"],
        [
            "Latest version",
            version ? (
                <span key="version" className="tabular-nums">
                    {`${version.number === null || version.number === undefined ? "Unsaved" : `v${version.number}`} · ${count(version.rows)} rows · built ${relativeTime(version.created_at)}`}
                </span>
            ) : (
                "None yet"
            ),
        ],
    ];
    if (version && version.labels.length > 0) {
        facts.push(["Labels", version.labels.join(", ")]);
    }
    return (
        <PanelSection
            icon={Database}
            title="Training data"
            description="What the next version trains and is scored on."
            actions={
                can.build && (
                    <Button variant="outline" asChild>
                        <Link href={modelDataHref(detail.slug)}>Edit data</Link>
                    </Button>
                )
            }
        >
            <Facts items={facts} />
        </PanelSection>
    );
}

export function CustomModelView({ row, tab }: { row: ModelRow; tab: ModelTab }) {
    const router = useRouter();
    const can = useCan();
    const refresh = useModelsRefresh();
    const detail = useModel(row.key);
    const versions = useVersions(row.key);
    const jobs = useJobs(row.key);
    const page = useModelPage(row.key);
    const presets = usePresets();
    const base = useBaseModel(row.base_model ?? "");
    const [editing, setEditing] = useState<ModelRow | null>(null);
    const [duplicating, setDuplicating] = useState<ModelRow | null>(null);
    const [switching, setSwitching] = useState<{ preferred: string | null } | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const recipe = useRouterState({
        select: (state) => {
            const search = state.location.search as { rows?: unknown; epochs?: unknown };
            return search.rows && search.epochs
                ? `?rows=${String(search.rows)}&epochs=${String(search.epochs)}`
                : "";
        },
    });
    const deleting = beingDeleted(row);
    const serveOnly = detail.data?.serve_only ?? row.serve_only ?? null;
    const moveTo = serveOnly?.switch_to ?? null;
    const deployed = detail.data?.deployed ?? row.deployment.state !== "not_deployed";
    const baseKey = row.base_model ?? "";
    const baseName = base.data?.name ?? baseKey;
    const live = liveVersion(versions.data, detail.data?.current_version);
    const active = (jobs.data ?? []).filter(isActiveJob);
    const preset = presets.data?.presets.find((item) => item.key === detail.data?.preset);
    const reload = () => refresh();
    const deploy = () =>
        setConfirmation(
            deployConfirmation(
                row,
                deployed,
                <p>
                    It becomes callable as <span className="font-mono">{row.key}</span>
                    {live ? `, answered by v${live.number}` : `, answered by ${baseName}`}.
                </p>,
                reload,
            ),
        );
    const act = (next: NextAction) => {
        if (next.kind === "deploy") {
            deploy();
        } else if (next.kind === "promote" && next.version !== null && next.version !== undefined) {
            setConfirmation(promoteConfirmation(row, next.version, reload));
        } else if (next.kind === "switch_base") {
            setSwitching({ preferred: next.base ?? null });
        }
    };
    const openBase = (_row: ModelRow, action: HealthAction) => {
        if (action.kind === "open_base" && baseKey) {
            router.history.push(modelPageHref(baseKey));
        }
    };
    const weights = (
        <WeightsRow
            name={row.key}
            summary={
                live?.kind === "lora"
                    ? `v${live.number} adapter on ${baseName}`
                    : `${baseName} weights, no adapter`
            }
        />
    );
    const facts: [string, ReactNode][] = [
        [
            "Built on",
            <Link key="base" href={modelPageHref(baseKey)} className="text-primary hover:underline">
                {baseName}
            </Link>,
        ],
        ["Task", preset?.label ?? detail.data?.preset ?? "—"],
        [
            "Live version",
            live ? (
                <Link
                    key="live"
                    href={modelCardHref(row.key, live.number)}
                    className="tabular-nums text-primary hover:underline"
                >
                    {`v${live.number} · ${live.kind === "lora" ? "Trained" : "Prompt only"}`}
                </Link>
            ) : (
                "None yet"
            ),
        ],
        [
            "Score",
            <span key="score" className="tabular-nums">
                {live?.score === null || live?.score === undefined
                    ? "—"
                    : `${percent(live.score)} ${metricName(live.main_metric).toLowerCase()} held out`}
            </span>,
        ],
        ...(base.data ? baseFacts(base.data) : []),
        ["Weights", weights],
        ...updatedFacts(row),
        ...activityFacts(row),
    ];
    const overview = (
        <>
            <TeardownNotice row={row} canRetry={can.build} onRetried={reload} />
            <HealthNotice row={row} run={openBase} />
            {can.build && detail.data && <LabelProposalNotice detail={detail.data} />}
            {active.map((job) => (
                <JobPanel key={job.id} job={job} slug={row.key} />
            ))}
            <SummaryCard>
                <QualityRow
                    versions={versions.data ?? []}
                    current={deployed ? detail.data?.current_version : null}
                    metric={detail.data?.main_metric}
                />
                <TrafficRow page={page.data} />
                <NextRow row={row} page={page.data} onAct={act} />
            </SummaryCard>
            <PanelSections>
                <TryIt row={row} />
                <PanelSection icon={Info} title="Details">
                    <Facts items={facts} />
                </PanelSection>
            </PanelSections>
        </>
    );
    return (
        <>
            <ModelHeader
                row={row}
                caption={row.description || `Custom model on ${baseName}`}
                deployed={deployed}
                onDeploy={can.build && !deleting && !busyTearingDown(row) ? deploy : undefined}
                actions={
                    <>
                        {can.build &&
                            (serveOnly ? (
                                <BlockedButton variant="outline" reason={serveOnly.reason}>
                                    Train
                                </BlockedButton>
                            ) : (
                                <Button variant="outline" disabled={deleting} asChild>
                                    <Link href={`${trainingHref(row.key)}${recipe}`}>Train</Link>
                                </Button>
                            ))}
                        <Button variant="outline" asChild>
                            <Link href={evaluationsHref(row.key)}>Review results</Link>
                        </Button>
                        {can.build && (
                            <Button
                                variant="ghost"
                                disabled={deleting}
                                onClick={() => setEditing(row)}
                            >
                                Edit
                            </Button>
                        )}
                        {can.build && (
                            <Button
                                variant="ghost"
                                disabled={deleting}
                                onClick={() => setDuplicating(row)}
                            >
                                Duplicate
                            </Button>
                        )}
                        {can.build && (
                            <Button
                                variant={moveTo ? "outline" : "ghost"}
                                disabled={deleting}
                                onClick={() => setSwitching({ preferred: moveTo?.key ?? null })}
                            >
                                {moveTo ? `Move to ${moveTo.name}` : "Switch base"}
                            </Button>
                        )}
                    </>
                }
            />
            <ModelTabs row={row} />
            {(tab === "overview" || tab === "files") && overview}
            {tab === "versions" && (
                <PanelSections>
                    <VersionTimeline
                        row={row}
                        versions={versions.data ?? []}
                        deployed={deployed}
                        baseName={baseName}
                    />
                    {detail.data && <InstructionsSection detail={detail.data} />}
                    {detail.data && <JudgedSection detail={detail.data} />}
                </PanelSections>
            )}
            {tab === "data" && (
                <>
                    <ModelDataNotice slug={row.key} />
                    <PanelSections>
                        {detail.data && <TrainingData detail={detail.data} />}
                        <PanelSection
                            icon={ThumbsUp}
                            title="Feedback"
                            description="Answers marked right or wrong in the playground and through the API."
                        >
                            <FeedbackSince slug={row.key} />
                        </PanelSection>
                        {can.build && (
                            <PanelSection
                                icon={ListChecks}
                                title="Test examples"
                                description="Conversations saved from the Playground with the answer they should get. Each one joins the held-out rows of the next version's data, so that version is scored on it."
                                bare
                            >
                                <TestExamples slug={row.key} />
                            </PanelSection>
                        )}
                    </PanelSections>
                </>
            )}
            {tab === "api" && (
                <ApiTab
                    scope={{ kind: "custom", key: row.key }}
                    model={detail.data?.models[0] ?? row.key}
                    description={
                        deployed
                            ? `Call it as ${row.key} on the OpenAI-compatible endpoint; ${row.key}@N pins version N.`
                            : "Deploy it to call it from the API; keys can be created now."
                    }
                    actions={
                        <Button variant="outline" asChild>
                            <Link href={deploymentPageHref(row.key)}>Deployment settings</Link>
                        </Button>
                    }
                />
            )}
            <FilesSheet row={row} open={tab === "files"} description={adapterText(live, baseName)}>
                <CustomFiles slug={row.key} live={live} base={baseKey} baseName={baseName} />
            </FilesSheet>
            <EditModelDialog row={editing} onOpenChange={(open) => !open && setEditing(null)} />
            <DuplicateModelDialog
                row={duplicating}
                onOpenChange={(open) => !open && setDuplicating(null)}
            />
            <SwitchBaseDialog
                row={switching ? row : null}
                preferred={switching?.preferred}
                onOpenChange={(open) => !open && setSwitching(null)}
            />
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
        </>
    );
}
