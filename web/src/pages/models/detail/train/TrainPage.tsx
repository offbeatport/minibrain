import { useParams, useRouter } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { Button, Card, ConfirmDialog, InfoTip, Kbd, Link, cn } from "obp-ui";
import type { KeyboardEvent, ReactNode } from "react";
import type { ModelDetail, ModelRow, VersionInfo } from "~/api/client";
import { useAllModels, useModel, useVersions } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page } from "~/components/Section";
import { count } from "~/lib/format";
import { useSearchParam } from "~/lib/listSearch";
import { modelPageHref } from "~/lib/modelLinks";
import { modelsHref } from "~/lib/modelsSearch";
import { relativeTime } from "~/lib/time";
import { Crumbs, modelCrumbs, nextVersion, trainBlock } from "../header";
import { Advanced } from "./advanced";
import { AUTO, HeldOutWarning, PickSelect, fitText, timeText } from "./parts";
import { MIN_HELD_OUT, QUALITIES, duration, presetText, startFrom } from "./recipe";
import { RunSummary, StatusLine } from "./summary";
import { type TrainRun, type TrainStart, useTrainRun } from "./useTrainRun";

function submitsOnEnter(target: HTMLElement): boolean {
    if (target.getAttribute("role") === "radio") {
        return true;
    }
    return target instanceof HTMLInputElement && target.getAttribute("aria-expanded") !== "true";
}

function numberParam(value: string | null): number | null {
    if (value === null || value.trim() === "") {
        return null;
    }
    const found = Number(value);
    return Number.isInteger(found) ? found : null;
}

function lastTrained(versions: VersionInfo[]): VersionInfo | undefined {
    return versions
        .filter((version) => version.kind === "lora")
        .reduce<VersionInfo | undefined>(
            (best, version) => (best && best.number > version.number ? best : version),
            undefined,
        );
}

function useStart(versions: VersionInfo[]): TrainStart {
    const from = numberParam(useSearchParam("from"));
    const data = numberParam(useSearchParam("data"));
    const source =
        from === null ? lastTrained(versions) : versions.find((item) => item.number === from);
    const start = startFrom(source?.recipe);
    const fromData = from === null ? null : (source?.dataset_version_id ?? null);
    return { ...start, data: data ?? fromData };
}

function FormRow({ id, label, children }: { id: string; label: string; children: ReactNode }) {
    return (
        <section
            aria-labelledby={id}
            className="grid gap-label py-3 first:pt-0 last:pb-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-4"
        >
            <h3 id={id} className="font-medium sm:leading-8">
                {label}
            </h3>
            <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
        </section>
    );
}

function Control({ children }: { children: ReactNode }) {
    return <div className="w-full max-w-md">{children}</div>;
}

function DataRow({ row, detail, run }: { row: ModelRow; detail: ModelDetail; run: TrainRun }) {
    const chosen = run.chosen;
    if (!chosen) {
        return (
            <p className="text-destructive sm:leading-8">
                Add training data first: training needs examples.
            </p>
        );
    }
    const dataset = detail.dataset_name ?? detail.dataset ?? "Data";
    return (
        <>
            <Control>
                <PickSelect
                    id="train-data-select"
                    value={String(chosen.id)}
                    onChange={(next) => run.setPicked(Number(next))}
                    options={run.saved.map((item, index) => ({
                        value: String(item.id),
                        label: `${dataset} v${item.number ?? "–"}${index === 0 ? " · latest" : ""}`,
                        meta: [
                            `${count(item.counts.train ?? item.rows)} rows`,
                            relativeTime(item.taken_at ?? item.created_at),
                        ].join(" · "),
                    }))}
                />
            </Control>
            <p className="flex flex-wrap gap-x-2 text-sm text-muted-foreground tabular-nums">
                <span>
                    {[
                        `${count(chosen.counts.train ?? 0)} training rows`,
                        run.accepted > 0 ? `+ ${count(run.accepted)} accepted feedback` : null,
                        `${count(run.heldOut)} held out`,
                        run.diff,
                    ]
                        .filter(Boolean)
                        .join(" · ")}
                </span>
                {run.pending > 0 && (
                    <Link
                        href={`/feedback?model=${encodeURIComponent(row.key)}`}
                        className="text-primary hover:underline"
                    >
                        {`${count(run.pending)} feedback rows to review`}
                    </Link>
                )}
            </p>
            {run.heldOut < MIN_HELD_OUT && <HeldOutWarning heldOut={run.heldOut} />}
        </>
    );
}

function ParametersHeader({ run }: { run: TrainRun }) {
    return (
        <div className="flex h-12 items-center justify-between gap-3 border-b px-panel">
            <h2 id="train-parameters" className="font-medium">
                Parameters
            </h2>
            {run.custom ? (
                run.changed > 0 && (
                    <button
                        type="button"
                        className="rounded-sm text-sm text-primary tabular-nums hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        onClick={run.reset}
                    >
                        {`${run.changed} changed · Reset`}
                    </button>
                )
            ) : (
                <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Lock aria-hidden="true" className="size-3.5" />
                    Locked
                    <InfoTip label="Locked parameters">
                        Choose Custom under Training to change them.
                    </InfoTip>
                </span>
            )}
        </div>
    );
}

function TrainForm({
    row,
    detail,
    versions,
    start,
    blocked,
}: {
    row: ModelRow;
    detail: ModelDetail;
    versions: VersionInfo[];
    start: TrainStart;
    blocked: string | null;
}) {
    const router = useRouter();
    const back = () => router.history.push(modelPageHref(row.key, "training"));
    const run = useTrainRun({ row, detail, versions, start, blocked, onDone: back });
    const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
            return;
        }
        if (submitsOnEnter(event.target as HTMLElement)) {
            event.preventDefault();
            run.submit();
        }
    };
    const disabled = !run.ready || run.create.isPending;
    const trainLabel = `Train v${run.number}`;
    return (
        <form
            noValidate
            className="@container"
            onSubmit={(event) => {
                event.preventDefault();
                run.submit();
            }}
            onKeyDown={onKeyDown}
        >
            <div className="grid items-start gap-6 @4xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
                <div className="flex min-w-0 flex-col gap-6">
                    <Card className="gap-0 divide-y p-panel">
                        <FormRow id="train-method" label="Method">
                            <p className="sm:leading-8">Supervised fine-tuning (SFT)</p>
                        </FormRow>
                        <FormRow id="train-data" label="Data">
                            <DataRow row={row} detail={detail} run={run} />
                        </FormRow>
                        <FormRow id="train-quality" label="Training">
                            <Control>
                                <PickSelect
                                    id="train-quality-select"
                                    value={run.level}
                                    onChange={(next) => run.choose(next as typeof run.level)}
                                    options={[
                                        ...QUALITIES.map((item) => ({
                                            value: item.id,
                                            label: item.label,
                                            meta: `${presetText(item.id)} · ${timeText(run.minutes[item.id])}`,
                                        })),
                                        {
                                            value: "custom",
                                            label: "Custom",
                                            meta: "set each parameter",
                                            separated: true,
                                        },
                                    ]}
                                />
                            </Control>
                        </FormRow>
                        <FormRow id="train-compute" label="Compute">
                            <Control>
                                <PickSelect
                                    id="train-compute-select"
                                    value={run.compute}
                                    onChange={run.setCompute}
                                    options={[
                                        {
                                            value: AUTO,
                                            label: "Automatic",
                                            meta: run.fastest
                                                ? `fastest that fits · ${run.fastest.name}`
                                                : "nothing fits",
                                        },
                                        ...(run.info?.machines ?? []).map((item, index) => ({
                                            value: item.name,
                                            label: `${item.name} · ${item.pool}`,
                                            meta: item.chosen
                                                ? `${fitText(item.chosen)} · ≈ ${duration(item.minutes)}`
                                                : (item.reason ?? "does not fit"),
                                            disabled: !item.chosen,
                                            separated: index === 0,
                                        })),
                                    ]}
                                />
                            </Control>
                        </FormRow>
                    </Card>
                    <Card aria-labelledby="train-parameters" className="gap-0 py-0">
                        <ParametersHeader run={run} />
                        <div className="p-panel">
                            <Advanced
                                disabled={!run.custom}
                                recipe={run.recipe}
                                onChange={run.change}
                                plan={run.info}
                                available={run.available}
                                heldOut={run.heldOut}
                                issues={run.issues}
                                next={run.number}
                            />
                        </div>
                    </Card>
                </div>
                <aside aria-label="Run summary" className="min-w-0 @4xl:sticky @4xl:top-6">
                    <RunSummary
                        run={run}
                        blocked={blocked}
                        actions={
                            <div className="hidden flex-col gap-2 @4xl:flex">
                                <Button type="submit" className="w-full" disabled={disabled}>
                                    {trainLabel}
                                    <Kbd>↵</Kbd>
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    className="w-full"
                                    onClick={back}
                                >
                                    Cancel
                                </Button>
                            </div>
                        }
                    />
                </aside>
            </div>
            <div
                className={cn(
                    "sticky bottom-0 z-10 -mx-6 -mb-6 mt-6 flex items-center gap-3 border-t bg-background px-6 pt-3",
                    "pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] @4xl:hidden",
                )}
            >
                <StatusLine run={run} blocked={blocked} className="min-w-0 flex-1 truncate" />
                <Button type="button" variant="outline" onClick={back}>
                    Cancel
                </Button>
                <Button type="submit" disabled={disabled}>
                    {trainLabel}
                </Button>
            </div>
            <ConfirmDialog
                open={run.breaking !== null}
                onOpenChange={(open) => !open && run.setBreaking(null)}
                title="This version breaks the contract"
                description={run.breaking ?? ""}
                confirmLabel="Train it anyway"
                destructive
                onConfirm={() => {
                    run.setBreaking(null);
                    return run.create.mutateAsync(true);
                }}
            />
        </form>
    );
}

function Loaded({ row }: { row: ModelRow }) {
    const detail = useModel(row.key);
    const versions = useVersions(row.key);
    const list = versions.data;
    const start = useStart(list ?? []);
    const blocked = trainBlock(row, detail.data);
    return (
        <>
            <ErrorLine error={detail.error ?? versions.error} />
            {detail.data && list ? (
                <TrainForm
                    row={row}
                    detail={detail.data}
                    versions={list}
                    start={start}
                    blocked={blocked}
                />
            ) : (
                !detail.error &&
                !versions.error && <p className="text-muted-foreground">Loading…</p>
            )}
        </>
    );
}

export function TrainPage() {
    const { name = "" } = useParams({ strict: false }) as { name?: string };
    const models = useAllModels();
    const row = models.data?.find((item) => item.key === name);
    if (!row || row.kind !== "custom") {
        return (
            <Page>
                <Crumbs
                    items={[
                        { label: "Models", href: modelsHref() },
                        { label: name, href: row ? modelPageHref(row.key) : undefined },
                        { label: "Train" },
                    ]}
                />
                <ErrorLine error={models.error} />
                <p className="text-muted-foreground">
                    {models.isLoading
                        ? "Loading…"
                        : row
                          ? `${row.name} is a base model. Add a custom model on it to train.`
                          : `No model called ${name}.`}
                </p>
            </Page>
        );
    }
    return (
        <Page>
            <Crumbs items={modelCrumbs(row, [{ label: "Train" }])} />
            <PageHeader title={`Train version v${nextVersion(row)} of ${row.name}`} />
            <Loaded key={row.key} row={row} />
        </Page>
    );
}
