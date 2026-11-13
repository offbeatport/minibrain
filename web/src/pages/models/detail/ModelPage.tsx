import { useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { TabNav } from "obp-ui";
import { type ReactNode, useEffect, useState } from "react";
import type { BaseModelDetail, ModelDetail, ModelRow, VersionInfo } from "~/api/client";
import {
    keys,
    useAllModels,
    useBaseModel,
    useModel,
    useReservedName,
    useVersions,
} from "~/api/queries";
import { ErrorLine, Page, PanelSections } from "~/components/Section";
import { useCan } from "~/lib/access";
import { modelPageHref } from "~/lib/modelLinks";
import { modelsHref } from "~/lib/modelsSearch";
import { deleteModel, rowId } from "~/lib/teardown";
import { DeleteModelsDialog } from "../DeleteModelsDialog";
import { ConfirmAction, type Confirmation, useModelsRefresh } from "../dialogs";
import type { Entry } from "../entries";
import { useHealthActions } from "../healthActions";
import { About, BaseAbout, BaseDetails, Details } from "./about";
import { ActivityPanel } from "./activity";
import { CompareView } from "./compare";
import { ModelActions } from "./deploy";
import { BaseFiles, CustomFiles, FilesSheet, adapterText, verifiedText } from "./files";
import { Crumbs, ModelHeader, baseNameOf, modelCrumbs } from "./header";
import { KeysTab } from "./keys";
import { liveOf } from "./makeLive";
import { MonitoringTab } from "./monitoring";
import { HealthNotice, TeardownNotice } from "./parts";
import { SettingsTab } from "./settings";
import { TAB_LABELS, tabsFor, useModelTab } from "./tabs";
import { UsagePanel } from "./usage";
import { VersionView, useVersionNumber } from "./version";
import { VersionsTab } from "./versions";

function useRow(): { row: ModelRow | undefined; loading: boolean; error: unknown; name: string } {
    const { name = "" } = useParams({ strict: false }) as { name?: string };
    const models = useAllModels();
    return {
        row: models.data?.find((item) => item.key === name),
        loading: models.isLoading,
        error: models.error,
        name,
    };
}

function useScrollToHash(ready: boolean) {
    const hash = useRouterState({ select: (state) => state.location.hash });
    useEffect(() => {
        if (!ready || !hash) {
            return;
        }
        const target = document.getElementById(hash.replace(/^#/, ""));
        if (target) {
            target.scrollIntoView({ block: "start" });
            target.setAttribute("data-flash", "");
            const timer = window.setTimeout(() => target.removeAttribute("data-flash"), 1500);
            return () => window.clearTimeout(timer);
        }
    }, [ready, hash]);
}

function Missing({ name, loading, error }: { name: string; loading: boolean; error: unknown }) {
    const reserved = useReservedName(loading || error ? null : name);
    return (
        <Page wide>
            <Crumbs items={[{ label: "Models", href: "/models" }, { label: name }]} />
            {(loading || reserved.isLoading) && <p className="text-muted-foreground">Loading…</p>}
            <ErrorLine error={error} />
            {!loading && !error && !reserved.isLoading && (
                <p className="text-muted-foreground">
                    {reserved.data ? `${reserved.data.message}.` : `No model called ${name}.`}
                </p>
            )}
        </Page>
    );
}

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

function Notices({ row }: { row: ModelRow }) {
    const can = useCan();
    const router = useRouter();
    const client = useQueryClient();
    const refresh = useModelsRefresh();
    const models = useAllModels();
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [deleting, setDeleting] = useState<Entry[] | null>(null);
    const reload = async () => {
        await refresh();
        await client.invalidateQueries({ queryKey: keys.modelPage(row.key) });
        await client.invalidateQueries({ queryKey: keys.baseModel(row.key) });
    };
    const health = useHealthActions({
        refresh: reload,
        confirm: setConfirmation,
        remove: (target) => setDeleting([{ key: rowId(target), model: target, version: null }]),
    });
    const run = row.kind === "base" && can.admin ? health.run : undefined;
    return (
        <>
            <TeardownNotice
                row={row}
                canRetry={
                    can.admin ||
                    (can.build && (row.kind === "custom" || row.teardown?.kind === "undeploy"))
                }
                onRetried={reload}
                onReview={() => setDeleting([{ key: rowId(row), model: row, version: null }])}
            />
            <HealthNotice
                row={row}
                run={
                    row.kind === "custom"
                        ? (_, action) => {
                              if (action.kind === "open_base" && row.base_model) {
                                  router.history.push(modelPageHref(row.base_model));
                              }
                          }
                        : run
                }
                shown={(action) => action.kind !== "verify" || row.health?.actions[0] === action}
            />
            {health.dialogs}
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
            <DeleteModelsDialog
                chosen={deleting}
                rows={models.data ?? []}
                onOpenChange={(open) => !open && setDeleting(null)}
                onDelete={async (cascade, cancelJobs) => {
                    await deleteModel(row, { cascade, undeploy: true, cancelJobs });
                    await refresh();
                    router.history.push(modelsHref());
                }}
            />
        </>
    );
}

function Overview({
    row,
    detail,
    base,
    versions,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    base: BaseModelDetail | undefined;
    versions: VersionInfo[];
}) {
    return (
        <OverviewLayout
            main={
                <>
                    <UsagePanel row={row} versions={versions} />
                    {row.kind === "base" ? (
                        <>
                            <BaseAbout row={row} base={base} />
                            <BaseDetails row={row} base={base} />
                        </>
                    ) : (
                        <>
                            <About row={row} detail={detail} versions={versions} />
                            <Details row={row} detail={detail} versions={versions} base={base} />
                        </>
                    )}
                </>
            }
            side={<ActivityPanel row={row} />}
        />
    );
}

function Files({
    row,
    open,
    base,
    versions,
}: {
    row: ModelRow;
    open: boolean;
    base: BaseModelDetail | undefined;
    versions: VersionInfo[];
}) {
    const models = useAllModels();
    const client = useQueryClient();
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const health = useHealthActions({
        refresh: () => client.invalidateQueries({ queryKey: keys.baseModel(row.key) }),
        confirm: setConfirmation,
        remove: () => undefined,
    });
    if (row.kind === "base") {
        return base ? (
            <FilesSheet row={row} open={open} description={verifiedText(base)}>
                <BaseFiles
                    model={base}
                    verify={() => health.run(row, { kind: "verify", label: "Verify files" })}
                />
                {health.dialogs}
                <ConfirmAction
                    confirmation={confirmation}
                    onOpenChange={(next) => !next && setConfirmation(null)}
                />
            </FilesSheet>
        ) : null;
    }
    const live = liveOf(versions);
    const baseName = baseNameOf(models.data, row.base_model);
    return (
        <FilesSheet row={row} open={open} description={adapterText(live, baseName)}>
            <CustomFiles
                slug={row.key}
                live={live}
                base={row.base_model ?? ""}
                baseName={baseName}
            />
        </FilesSheet>
    );
}

function Loaded({ row }: { row: ModelRow }) {
    const can = useCan();
    const custom = row.kind === "custom";
    const detail = useModel(custom ? row.key : "");
    const base = useBaseModel(custom ? (row.base_model ?? "") : row.key);
    const versions = useVersions(custom ? row.key : "");
    const tab = useModelTab(row, can.build);
    const list = custom ? (versions.data ?? []) : [];
    const tabs = tabsFor(row, can.build);
    useScrollToHash(Boolean(detail.data) || !custom);
    const modelDetail = custom ? detail.data : undefined;
    return (
        <Page wide>
            <Crumbs items={modelCrumbs(row)} />
            <div className="flex flex-col gap-3">
                <ModelHeader
                    row={row}
                    base={base.data}
                    actions={
                        <ModelActions
                            row={row}
                            detail={modelDetail}
                            base={base.data}
                            versions={list}
                        />
                    }
                />
                <TabNav
                    label={`${row.name} pages`}
                    tabs={tabs.map((item) => ({
                        href: modelPageHref(row.key, item),
                        label: TAB_LABELS[item],
                    }))}
                />
            </div>
            <Notices row={row} />
            <div>
                {(tab === "overview" || tab === "files") && (
                    <Overview row={row} detail={modelDetail} base={base.data} versions={list} />
                )}
                {tab === "versions" && (
                    <VersionsTab row={row} detail={modelDetail} versions={list} />
                )}
                {tab === "monitoring" && <MonitoringTab row={row} versions={list} />}
                {tab === "api" && <KeysTab row={row} detail={modelDetail} />}
                {tab === "settings" && (
                    <SettingsTab row={row} detail={modelDetail} versions={list} />
                )}
            </div>
            <Files row={row} open={tab === "files"} base={base.data} versions={list} />
        </Page>
    );
}

export function ModelPage() {
    const { row, loading, error, name } = useRow();
    if (!row) {
        return <Missing name={name} loading={loading} error={error} />;
    }
    return <Loaded key={row.key} row={row} />;
}

export function ModelVersionPage() {
    const { row, loading, error, name } = useRow();
    const number = useVersionNumber();
    if (!row || row.kind !== "custom") {
        return <Missing name={name} loading={loading} error={error} />;
    }
    return <VersionView row={row} number={number} />;
}

export function ModelComparePage() {
    const { row, loading, error, name } = useRow();
    if (!row || row.kind !== "custom") {
        return <Missing name={name} loading={loading} error={error} />;
    }
    return <CompareView row={row} />;
}

export function OldModelLink() {
    const params = useParams({ strict: false }) as { key?: string; slug?: string; number?: string };
    const router = useRouter();
    const name = params.key ?? params.slug ?? "";
    const target = params.number
        ? `${modelPageHref(name)}/versions/${params.number}/card`
        : modelPageHref(name);
    useEffect(() => {
        router.history.replace(target);
    }, [router, target]);
    return null;
}
