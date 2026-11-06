import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ExternalLink, Info } from "lucide-react";
import { Button, Link } from "obp-ui";
import { type ReactNode, useState } from "react";
import { type BaseModelDetail, type ModelRow, type NextAction, api, unwrap } from "~/api/client";
import { isActiveJob, keys, useAllModels, useModelPage } from "~/api/queries";
import { Facts } from "~/components/Facts";
import { JobPanel } from "~/components/JobPanel";
import { PanelSection, PanelSections } from "~/components/Section";
import { useCan } from "~/lib/access";
import type { ModelTab } from "~/lib/modelLinks";
import { modelsHref } from "~/lib/modelsSearch";
import { beingDeleted, busyTearingDown, deleteModel, rowId } from "~/lib/teardown";
import { bytes } from "~/lib/time";
import { DeleteModelsDialog } from "../DeleteModelsDialog";
import { Updated } from "../MyModels";
import {
    ConfirmAction,
    type Confirmation,
    EditModelDialog,
    TestBaseDialog,
    useModelsRefresh,
} from "../dialogs";
import type { Entry } from "../entries";
import { useHealthActions } from "../healthActions";
import { BaseFiles, FilesSheet, baseWeightsText, verifiedText } from "./files";
import { NextRow, SummaryCard, SummaryRow, TrafficRow, TryIt, WeightsRow } from "./overview";
import {
    ApiTab,
    HealthNotice,
    ModelHeader,
    ModelTabs,
    TeardownNotice,
    activityFacts,
    baseFacts,
    deployConfirmation,
    parametersText,
    updatedFacts,
} from "./parts";

function useJob(jobId: number | null | undefined) {
    return useQuery({
        queryKey: ["jobs", "detail", jobId],
        queryFn: () =>
            unwrap(api.GET("/api/jobs/{job_id}", { params: { path: { job_id: jobId ?? 0 } } })),
        enabled: jobId !== null && jobId !== undefined,
        refetchInterval: (query) =>
            query.state.data && isActiveJob(query.state.data) ? 2000 : false,
    });
}

function repoLink(model: BaseModelDetail): ReactNode {
    if (!model.repo) {
        return "—";
    }
    return (
        <a
            key="repo"
            href={`https://huggingface.co/${model.repo}/tree/${model.revision ?? "main"}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-primary hover:underline"
        >
            {model.repo}@{(model.revision ?? "").slice(0, 12)}
            <ExternalLink aria-hidden="true" className="ml-0.5 inline size-3.5" />
        </a>
    );
}

function CatalogueRow({ model }: { model: BaseModelDetail }) {
    const parts = [
        model.parameters ? `${parametersText(model.parameters)} parameters` : null,
        model.context_tokens ? `${model.context_tokens.toLocaleString()}-token context` : null,
        model.license_name ?? model.license,
    ].filter(Boolean);
    return (
        <SummaryRow label="Model">
            <span className="tabular-nums">{parts.length > 0 ? parts.join(" · ") : "—"}</span>
            {model.catalog_id && (
                <Link
                    href={`/discover/${encodeURIComponent(model.catalog_id)}`}
                    className="text-primary hover:underline"
                >
                    View in Discover
                </Link>
            )}
        </SummaryRow>
    );
}

export function BaseModelView({ model, tab }: { model: BaseModelDetail; tab: ModelTab }) {
    const router = useRouter();
    const can = useCan();
    const refresh = useModelsRefresh();
    const queryClient = useQueryClient();
    const page = useModelPage(model.key);
    const job = useJob(model.activity.job_id ?? model.availability.job_id);
    const [testing, setTesting] = useState<ModelRow | null>(null);
    const [editing, setEditing] = useState<ModelRow | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [deleting, setDeleting] = useState<Entry[] | null>(null);
    const models = useAllModels();
    const reload = async () => {
        await refresh();
        await queryClient.invalidateQueries({ queryKey: keys.baseModel(model.key) });
    };
    const deployed = model.deployed;
    const tearingDown = busyTearingDown(model);
    const available = model.availability.state === "available" && !model.health && !tearingDown;
    const remove = (row: ModelRow) => setDeleting([{ key: rowId(row), model: row, version: null }]);
    const health = useHealthActions({ refresh: reload, confirm: setConfirmation, remove });
    const deploy = () =>
        setConfirmation(
            deployConfirmation(
                model,
                deployed,
                <p>
                    It becomes callable as <span className="font-mono">{model.key}</span>
                    {model.needed_bytes
                        ? ` and uses about ${bytes(model.needed_bytes)} of memory`
                        : ""}
                    .
                </p>,
                reload,
            ),
        );
    const act = (next: NextAction) => {
        if (next.kind === "deploy") {
            deploy();
        }
    };
    const facts: [string, ReactNode][] = [
        ...baseFacts(model),
        ["Weights", <WeightsRow key="weights" name={model.key} summary={baseWeightsText(model)} />],
        [
            "Source",
            model.source === "download"
                ? "Downloaded from the catalogue"
                : `Imported from ${model.source_path?.replace(/^\w+:/, "")}`,
        ],
        ["Repository", repoLink(model)],
        [
            "Update",
            model.update_available
                ? `A newer revision is published (${(model.latest_revision ?? "").slice(0, 12)}); this pin stays until you choose.`
                : "Pinned revision is current",
        ],
        ["Last used", model.last_used_at ? <Updated key="used" value={model.last_used_at} /> : "—"],
        ...updatedFacts(model),
        ...activityFacts(model),
    ];
    return (
        <>
            <ModelHeader
                row={model}
                caption={model.description || model.key}
                deployed={deployed}
                onDeploy={can.build && !tearingDown && (available || deployed) ? deploy : undefined}
                actions={
                    <>
                        {available && (
                            <Button variant="outline" onClick={() => setTesting(model)}>
                                Test
                            </Button>
                        )}
                        {can.admin && !beingDeleted(model) && (
                            <Button variant="ghost" onClick={() => setEditing(model)}>
                                Edit
                            </Button>
                        )}
                    </>
                }
            />
            <ModelTabs row={model} />
            {(tab === "overview" || tab === "files") && (
                <>
                    <TeardownNotice
                        row={model}
                        canRetry={can.admin || (can.build && model.teardown?.kind === "undeploy")}
                        onRetried={reload}
                        onReview={() => remove(model)}
                    />
                    <HealthNotice
                        row={model}
                        run={can.admin ? health.run : undefined}
                        shown={(action) =>
                            action.kind !== "verify" || model.health?.actions[0] === action
                        }
                    />
                    {job.data && <JobPanel job={job.data} slug="" />}
                    <SummaryCard>
                        <CatalogueRow model={model} />
                        <TrafficRow page={page.data} />
                        <NextRow row={model} page={page.data} onAct={act} />
                    </SummaryCard>
                    <PanelSections>
                        <TryIt row={model} />
                        <PanelSection icon={Info} title="Details">
                            <Facts items={facts} />
                            {model.error && !model.health && (
                                <p className="mt-2 text-sm text-destructive">{model.error}</p>
                            )}
                        </PanelSection>
                    </PanelSections>
                </>
            )}
            {tab === "api" && (
                <ApiTab
                    scope={{ kind: "base", key: model.key }}
                    model={model.key}
                    description={
                        deployed
                            ? `Call it as ${model.key} on the OpenAI-compatible endpoint.`
                            : "Deploy it to call it from the API; keys can be created now."
                    }
                />
            )}
            <FilesSheet row={model} open={tab === "files"} description={verifiedText(model)}>
                <BaseFiles
                    model={model}
                    verify={() => health.run(model, { kind: "verify", label: "Verify files" })}
                />
            </FilesSheet>
            <TestBaseDialog row={testing} onOpenChange={(open) => !open && setTesting(null)} />
            <EditModelDialog row={editing} onOpenChange={(open) => !open && setEditing(null)} />
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
            <DeleteModelsDialog
                chosen={deleting}
                rows={models.data ?? []}
                onOpenChange={(open) => !open && setDeleting(null)}
                onDelete={async (cascade) => {
                    await deleteModel(model, { cascade, undeploy: true });
                    await refresh();
                    router.history.push(modelsHref());
                }}
            />
            {health.dialogs}
        </>
    );
}
