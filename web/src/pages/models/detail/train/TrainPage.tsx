import { useParams, useRouter, useRouterState } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { Button, Card, ConfirmDialog, InfoTip, Kbd, Textarea, cn } from "obp-ui";
import { type KeyboardEvent, type ReactNode, useState } from "react";
import type { ModelDetail, ModelRow, VersionInfo } from "~/api/client";
import { useAllModels, useModel, useVersions } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page } from "~/components/Section";
import { count } from "~/lib/format";
import { useSearchParam } from "~/lib/listSearch";
import { type TrainMethod, modelPageHref } from "~/lib/modelLinks";
import { modelsHref } from "~/lib/modelsSearch";
import { beingDeleted } from "~/lib/teardown";
import { relativeTime } from "~/lib/time";
import { ModelDataNotice } from "../../../data/versionData";
import { Crumbs, modelCrumbs, nextVersion, trainBlock } from "../header";
import { Advanced } from "./advanced";
import { AUTO, HeldOutWarning, PickSelect, fitText, timeText } from "./parts";
import { MIN_HELD_OUT, QUALITIES, duration, presetText, startFrom } from "./recipe";
import { ProblemLine, RunSummary, StatusLine } from "./summary";
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

function FormRow({
    id,
    label,
    tip,
    anchor,
    children,
}: {
    id: string;
    label: string;
    tip?: ReactNode;
    anchor?: string;
    children: ReactNode;
}) {
    return (
        <section
            id={anchor}
            aria-labelledby={id}
            className="grid scroll-my-24 gap-label py-3 first:pt-0 last:pb-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-4"
        >
            <span className="flex items-center gap-1.5 sm:h-8 sm:self-start">
                <h3 id={id} className="font-medium">
                    {label}
                </h3>
                {tip && <InfoTip label={`About ${label.toLowerCase()}`}>{tip}</InfoTip>}
            </span>
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
            <ModelDataNotice slug={row.key} />
            {run.heldOut < MIN_HELD_OUT && <HeldOutWarning heldOut={run.heldOut} />}
        </>
    );
}

function firstLine(text: string): string {
    return (
        text
            .split("\n")
            .find((line) => line.trim())
            ?.trim() ?? ""
    );
}

function InstructionsRow({
    detail,
    text,
    onText,
    open,
    onOpen,
}: {
    detail: ModelDetail;
    text: string;
    onText: (text: string) => void;
    open: boolean;
    onOpen?: (open: boolean) => void;
}) {
    const shown = text.trim() ? text : detail.default_instructions;
    const changed = text.trim() !== detail.instructions.trim();
    return (
        <FormRow
            id="train-instructions"
            label="Instructions"
            anchor={INSTRUCTIONS_ANCHOR}
            tip="The system prompt. The new version keeps its own copy, and later versions start from it."
        >
            {open ? (
                <div className="flex w-full max-w-2xl flex-col gap-2">
                    <Textarea
                        id="train-instructions-text"
                        aria-labelledby="train-instructions"
                        className="min-h-40"
                        value={text}
                        placeholder={detail.default_instructions}
                        onChange={(event) => onText(event.target.value)}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                        {onOpen && (
                            <Button type="button" variant="outline" onClick={() => onOpen(false)}>
                                Done
                            </Button>
                        )}
                        {changed && (
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() => onText(detail.instructions)}
                            >
                                Undo changes
                            </Button>
                        )}
                    </div>
                </div>
            ) : (
                <div className="flex w-full max-w-2xl min-w-0 items-center gap-3">
                    <span className="min-w-0 flex-1 truncate sm:leading-8">
                        {firstLine(shown) || "None"}
                        {!text.trim() && <span className="text-muted-foreground"> (default)</span>}
                    </span>
                    {changed && <span className="text-sm text-muted-foreground">Changed</span>}
                    <Button type="button" variant="outline" onClick={() => onOpen?.(true)}>
                        Edit
                    </Button>
                </div>
            )}
        </FormRow>
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

function blockFor(method: TrainMethod, row: ModelRow, detail: ModelDetail): string | null {
    if (method === "sft") {
        return trainBlock(row, detail);
    }
    return beingDeleted(row) ? "It is being deleted." : null;
}

function TrainForm({
    row,
    detail,
    versions,
    start,
    method,
    onMethod,
}: {
    row: ModelRow;
    detail: ModelDetail;
    versions: VersionInfo[];
    start: TrainStart;
    method: TrainMethod;
    onMethod: (method: TrainMethod) => void;
}) {
    const router = useRouter();
    const hash = useRouterState({ select: (state) => state.location.hash });
    const [text, setText] = useState(detail.instructions);
    const [editing, setEditing] = useState(hash.replace(/^#/, "") === INSTRUCTIONS_ANCHOR);
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
    const disabled = !run.ready || run.create.isPending;
    const submitLabel = training ? `Train v${run.number}` : `Create v${run.number}`;
    const serveOnly = detail.serve_only ?? row.serve_only;
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
                            <Control>
                                <PickSelect
                                    id="train-method-select"
                                    value={method}
                                    onChange={(next) => onMethod(next as TrainMethod)}
                                    options={[
                                        {
                                            value: "sft",
                                            label: "Supervised fine-tuning (SFT)",
                                            meta: serveOnly
                                                ? serveOnly.reason
                                                : "trains an adapter",
                                            disabled: Boolean(serveOnly),
                                        },
                                        {
                                            value: "instructions",
                                            label: "Instructions only (no training)",
                                            meta: "scored at once",
                                        },
                                    ]}
                                />
                            </Control>
                        </FormRow>
                        <InstructionsRow
                            detail={detail}
                            text={text}
                            onText={setText}
                            open={editing || !training}
                            onOpen={training ? setEditing : undefined}
                        />
                        <FormRow id="train-data" label="Data">
                            <DataRow row={row} detail={detail} run={run} />
                        </FormRow>
                        {training && (
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
                        )}
                        {training && (
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
                        )}
                    </Card>
                    {training && (
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
                    )}
                    <div className="hidden flex-wrap items-center gap-3 @4xl:flex">
                        <Button type="submit" disabled={disabled}>
                            {submitLabel}
                            <Kbd>↵</Kbd>
                        </Button>
                        <Button type="button" variant="outline" onClick={back}>
                            Cancel
                        </Button>
                        {disabled && (
                            <ProblemLine run={run} blocked={blocked} className="min-w-0" />
                        )}
                    </div>
                </div>
                <aside aria-label="Run summary" className="min-w-0 @4xl:sticky @4xl:top-6">
                    <RunSummary run={run} blocked={blocked} changed={changed} />
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
                    {submitLabel}
                </Button>
            </div>
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
        </form>
    );
}

function Loaded({
    row,
    method,
    onMethod,
}: {
    row: ModelRow;
    method: TrainMethod;
    onMethod: (method: TrainMethod) => void;
}) {
    const detail = useModel(row.key);
    const versions = useVersions(row.key);
    const list = versions.data;
    const start = useStart(list ?? []);
    return (
        <>
            <ErrorLine error={detail.error ?? versions.error} />
            {detail.data && list ? (
                <TrainForm
                    row={row}
                    detail={detail.data}
                    versions={list}
                    start={start}
                    method={method}
                    onMethod={onMethod}
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
    const [method, setMethod] = useMethod();
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
    const title =
        method === "sft"
            ? `Train version v${nextVersion(row)} of ${row.name}`
            : `New version v${nextVersion(row)} of ${row.name}`;
    return (
        <Page>
            <Crumbs items={modelCrumbs(row, [{ label: "Train" }])} />
            <PageHeader title={title} />
            <Loaded key={row.key} row={row} method={method} onMethod={setMethod} />
        </Page>
    );
}
