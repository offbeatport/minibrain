import { useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { GraduationCap, ScrollText } from "lucide-react";
import { ConfirmDialog, Textarea } from "obp-ui";
import { type KeyboardEvent, useState } from "react";
import type { ModelDetail, ModelRow, VersionInfo } from "~/api/client";
import { useAllModels, useModel, useVersions } from "~/api/queries";
import { CreateLayout, FormCard } from "~/components/CreateLayout";
import { NotFoundState, QueryError } from "~/components/ErrorState";
import { FormControl, FormGroup, FormRow } from "~/components/FormRows";
import { PageCrumbs } from "~/components/PageCrumbs";
import { PageHeader } from "~/components/PageHeader";
import { PickSelect } from "~/components/PickSelect";
import { Page } from "~/components/Section";
import { ModelNotFound } from "~/components/models/ModelNotFound";
import { count } from "~/lib/format";
import { useSearchParam } from "~/lib/listSearch";
import { type TrainMethod, modelPageHref } from "~/lib/modelLinks";
import { modelsHref } from "~/lib/modelsSearch";
import { beingDeleted } from "~/lib/teardown";
import { relativeTime } from "~/lib/time";
import { ModelDataNotice } from "../../../data/versionData";
import { baseNameOf, isDeployed, modelCrumbs, nextVersion, trainBlock } from "../header";
import { AUTO, HeldOutWarning, fitText } from "./parts";
import { MIN_HELD_OUT, duration, startFrom } from "./recipe";
import { RunSummary, problemsOf, statusOf } from "./summary";
import { TrainingCard } from "./training";
import { type TrainRun, type TrainStart, useTrainRun } from "./useTrainRun";

const INSTRUCTIONS_ANCHOR = "instructions";

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

function useMethod(): [TrainMethod, (next: TrainMethod) => void] {
    const router = useRouter();
    const location = useRouterState({ select: (state) => state.location });
    const method: TrainMethod =
        useSearchParam("method") === "instructions" ? "instructions" : "sft";
    const choose = (next: TrainMethod) => {
        const search = new URLSearchParams(location.searchStr);
        if (next === "instructions") {
            search.set("method", next);
        } else {
            search.delete("method");
        }
        const query = search.toString();
        router.history.replace(`${location.pathname}${query ? `?${query}` : ""}`);
    };
    return [method, choose];
}

function DataRow({ row, detail, run }: { row: ModelRow; detail: ModelDetail; run: TrainRun }) {
    const chosen = run.chosen;
    if (!chosen) {
        return (
            <FormRow label="Data">
                <p className="text-destructive">
                    Add training data first: training needs examples.
                </p>
            </FormRow>
        );
    }
    const dataset = detail.dataset_name ?? detail.dataset ?? "Data";
    return (
        <FormRow id="train-data" label="Data" align="start">
            <FormControl>
                <PickSelect
                    id="train-data"
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
                <ModelDataNotice slug={row.key} />
                {run.heldOut < MIN_HELD_OUT && <HeldOutWarning heldOut={run.heldOut} />}
            </FormControl>
        </FormRow>
    );
}

function InstructionsRow({
    detail,
    text,
    onText,
}: {
    detail: ModelDetail;
    text: string;
    onText: (text: string) => void;
}) {
    const changed = text.trim() !== detail.instructions.trim();
    return (
        <FormRow
            id="train-instructions"
            label="Instructions"
            align="start"
            tip="The system prompt. The new version keeps its own copy, and later versions start from it."
        >
            <FormControl width="wide">
                <div id={INSTRUCTIONS_ANCHOR} className="flex scroll-my-24 flex-col gap-1.5">
                    <Textarea
                        id="train-instructions"
                        className="max-h-[calc(12lh+0.875rem)] min-h-[calc(4lh+0.875rem)]"
                        value={text}
                        placeholder={detail.default_instructions}
                        onChange={(event) => onText(event.target.value)}
                    />
                    {changed && (
                        <button
                            type="button"
                            className="w-fit rounded-sm text-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            onClick={() => onText(detail.instructions)}
                        >
                            Reset to current
                        </button>
                    )}
                </div>
            </FormControl>
        </FormRow>
    );
}

function ComputeRow({ run }: { run: TrainRun }) {
    return (
        <FormRow id="train-compute" label="Pool">
            <FormControl>
                <PickSelect
                    id="train-compute"
                    value={run.compute}
                    onChange={run.setCompute}
                    options={[
                        {
                            value: AUTO,
                            label: "Automatic",
                            meta: run.pools.some((item) => item.best)
                                ? "any pool that fits"
                                : "too large for every pool",
                        },
                        ...run.pools.map((item, index) => ({
                            value: item.name,
                            label: item.name,
                            meta: item.best
                                ? `${fitText(item.best.chosen)} · ≈ ${duration(item.best.minutes)}`
                                : item.reason,
                            disabled: !item.best && item.name !== run.compute,
                            separated: index === 0,
                        })),
                    ]}
                />
            </FormControl>
        </FormRow>
    );
}

function againstOf(row: ModelRow, versions: VersionInfo[]): string | null {
    if (isDeployed(row) && row.current_version !== null && row.current_version !== undefined) {
        return `deployed v${row.current_version}`;
    }
    const scored = versions
        .filter((version) => version.score !== null && version.score !== undefined)
        .reduce<number | null>(
            (best, version) => (best === null || version.number > best ? version.number : best),
            null,
        );
    return scored === null ? null : `v${scored}`;
}

function captionOf(
    method: TrainMethod,
    row: ModelRow,
    detail: ModelDetail,
    versions: VersionInfo[],
    run: TrainRun,
    base: string,
): string {
    const against = againstOf(row, versions);
    const scored = `${count(run.heldOut)} held-out rows${against ? ` against ${against}` : ""}`;
    if (method === "instructions") {
        return `Saves new instructions on ${base} and scores them on ${scored}.`;
    }
    const dataset = detail.dataset_name ?? detail.dataset ?? "the dataset";
    const data = run.chosen ? `${dataset} v${run.chosen.number ?? "–"}` : dataset;
    return `Fine-tunes ${base} on ${data}, then scores it on ${scored}.`;
}

function blockFor(method: TrainMethod, row: ModelRow, detail: ModelDetail): string | null {
    if (method === "sft") {
        return trainBlock(row, detail);
    }
    return beingDeleted(row) ? "It is being deleted." : null;
}

function trainCrumbs(row: ModelRow) {
    return modelCrumbs(row, [{ label: `Train v${nextVersion(row)}` }]);
}

function TrainForm({
    row,
    detail,
    versions,
    start,
    method,
    onMethod,
    title,
    base,
}: {
    row: ModelRow;
    detail: ModelDetail;
    versions: VersionInfo[];
    start: TrainStart;
    method: TrainMethod;
    onMethod: (method: TrainMethod) => void;
    title: string;
    base: string;
}) {
    const router = useRouter();
    const [text, setText] = useState(detail.instructions);
    const changed = text.trim() !== detail.instructions.trim();
    const blocked = blockFor(method, row, detail);
    const back = () => router.history.push(modelPageHref(row.key, "versions"));
    const run = useTrainRun({
        row,
        detail,
        versions,
        start,
        blocked,
        method,
        instructions: changed ? text : null,
        onDone: back,
    });
    const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
            return;
        }
        if (submitsOnEnter(event.target as HTMLElement)) {
            event.preventDefault();
            run.submit();
        }
    };
    const training = method === "sft";
    const SubmitIcon = training ? GraduationCap : ScrollText;
    const serveOnly = detail.serve_only ?? row.serve_only;
    const form = (
        <>
            <FormCard>
                <FormGroup>
                    <FormRow id="train-method" label="Method">
                        <FormControl>
                            <PickSelect
                                id="train-method"
                                value={method}
                                onChange={(next) => onMethod(next as TrainMethod)}
                                options={[
                                    {
                                        value: "sft",
                                        label: "Supervised fine-tuning (SFT)",
                                        meta: serveOnly ? serveOnly.reason : "trains an adapter",
                                        disabled: Boolean(serveOnly),
                                    },
                                    {
                                        value: "instructions",
                                        label: "Instructions only (no training)",
                                        meta: "scored at once",
                                    },
                                ]}
                            />
                        </FormControl>
                    </FormRow>
                    <DataRow row={row} detail={detail} run={run} />
                    {training ? (
                        <ComputeRow run={run} />
                    ) : (
                        <InstructionsRow detail={detail} text={text} onText={setText} />
                    )}
                </FormGroup>
            </FormCard>
            {training && <TrainingCard run={run} />}
            {training && (
                <FormCard>
                    <FormGroup>
                        <InstructionsRow detail={detail} text={text} onText={setText} />
                    </FormGroup>
                </FormCard>
            )}
        </>
    );
    return (
        <>
            <PageHeader
                title={title}
                crumbs={trainCrumbs(row)}
                caption={captionOf(method, row, detail, versions, run, base)}
            />
            <CreateLayout
                form={form}
                summary={<RunSummary run={run} blocked={blocked} changed={changed} />}
                summaryLabel="Run summary"
                submit={
                    <>
                        <SubmitIcon />
                        {training ? `Train v${run.number}` : `Create v${run.number}`}
                    </>
                }
                disabled={!run.ready || run.create.isPending}
                status={statusOf(run, blocked)}
                problem={problemsOf(run, blocked).length > 0}
                onSubmit={run.submit}
                onCancel={back}
                onKeyDown={onKeyDown}
            />
            <ConfirmDialog
                open={run.breaking !== null}
                onOpenChange={(open) => !open && run.setBreaking(null)}
                title="This version breaks the contract"
                description={run.breaking ?? ""}
                confirmLabel={training ? "Train it anyway" : "Create it anyway"}
                destructive
                onConfirm={() => {
                    run.setBreaking(null);
                    return run.create.mutateAsync(true);
                }}
            />
        </>
    );
}

function Loaded({
    row,
    method,
    onMethod,
    title,
    base,
}: {
    row: ModelRow;
    method: TrainMethod;
    onMethod: (method: TrainMethod) => void;
    title: string;
    base: string;
}) {
    const detail = useModel(row.key);
    const versions = useVersions(row.key);
    const list = versions.data;
    const start = useStart(list ?? []);
    return (
        <>
            {detail.data && list ? (
                <TrainForm
                    row={row}
                    detail={detail.data}
                    versions={list}
                    start={start}
                    method={method}
                    onMethod={onMethod}
                    title={title}
                    base={base}
                />
            ) : (
                <>
                    <PageHeader title={title} crumbs={trainCrumbs(row)} />
                    {detail.error || versions.error ? (
                        <QueryError
                            heading="h2"
                            error={detail.error ?? versions.error}
                            retry={() => Promise.all([detail.refetch(), versions.refetch()])}
                        />
                    ) : (
                        <p className="text-muted-foreground">Loading…</p>
                    )}
                </>
            )}
        </>
    );
}

export function TrainPage() {
    const { name = "" } = useParams({ strict: false }) as { name?: string };
    const models = useAllModels();
    const [method, setMethod] = useMethod();
    const row = models.data?.find((item) => item.key === name);
    if (!row || row.kind !== "custom") {
        return (
            <Page>
                <PageCrumbs
                    items={[
                        { label: "Models", href: modelsHref() },
                        { label: name, href: row ? modelPageHref(row.key) : undefined },
                        { label: "Train" },
                    ]}
                />
                {models.isLoading ? (
                    <p className="text-muted-foreground">Loading…</p>
                ) : models.error ? (
                    <QueryError error={models.error} retry={models.refetch} />
                ) : row ? (
                    <NotFoundState
                        title="Base models can't be trained"
                        primary={{
                            label: "Add model",
                            href: `/models/new?base=${encodeURIComponent(row.key)}`,
                        }}
                        secondary={{ label: `Go to ${row.name}`, href: modelPageHref(row.key) }}
                    >
                        {`${row.name} is a base model. Add a custom model on it, then train that.`}
                    </NotFoundState>
                ) : (
                    <ModelNotFound name={name} />
                )}
            </Page>
        );
    }
    const title =
        method === "sft"
            ? `Train version v${nextVersion(row)} of ${row.name}`
            : `New version v${nextVersion(row)} of ${row.name}`;
    return (
        <Page>
            <Loaded
                key={row.key}
                row={row}
                method={method}
                onMethod={setMethod}
                title={title}
                base={baseNameOf(models.data, row.base_model)}
            />
        </Page>
    );
}
