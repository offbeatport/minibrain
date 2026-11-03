import { useMutation } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Database } from "lucide-react";
import { Button, Field, Link, NumberField } from "obp-ui";
import { useEffect, useRef, useState } from "react";
import { type JobInfo, type MinibrainDetail, api, unwrap } from "~/api/client";
import { isActiveJob, useDatasets, useJobs, useMinibrain } from "~/api/queries";
import { JobPanel } from "~/components/JobPanel";
import { ErrorLine, PanelSection, Section } from "~/components/Section";
import { count } from "~/lib/format";
import { useInvalidate } from "~/lib/jobs";
import { ModelChecks } from "./data/Checks";
import { TrainingData } from "./data/TrainingData";
import { ModelDataNotice } from "./data/versionData";

const FINISHED_SHOWN = 5;

function CreateVersion({ detail, focusTrain }: { detail: MinibrainDetail; focusTrain: boolean }) {
    const slug = detail.slug;
    const invalidate = useInvalidate(slug);
    const trainButton = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (focusTrain) {
            trainButton.current?.focus();
        }
    }, [focusTrain]);
    const preset = useRouterState({
        select: (state) => state.location.search as { rows?: unknown; epochs?: unknown },
    });
    const [maxRows, setMaxRows] = useState<number | null>(Number(preset.rows) || 3000);
    const [epochs, setEpochs] = useState<number | null>(Number(preset.epochs) || 1);
    const create = useMutation({
        mutationFn: (body: { kind: "prompt" | "lora"; max_rows?: number; epochs?: number }) =>
            unwrap(
                api.POST("/api/minibrains/{slug}/versions", { params: { path: { slug } }, body }),
            ),
        onSuccess: invalidate,
    });
    const train = () => {
        if (maxRows !== null && epochs !== null) {
            create.mutate({ kind: "lora", max_rows: maxRows, epochs });
        }
    };
    return (
        <Section
            title="New version"
            caption="Score the base model with a prompt first. Train when the score shows a gap worth closing."
        >
            {detail.snapshot && (
                <p className="mb-4 text-sm text-muted-foreground tabular-nums">
                    {`${detail.dataset_name ?? "Training data"}: ${count(detail.snapshot.counts.train)} training rows, ${count(detail.snapshot.counts.golden)} in the test set, ${count(detail.snapshot.labels.length)} labels. `}
                    <Link
                        href={`/data?minibrain=${encodeURIComponent(slug)}`}
                        className="text-primary hover:underline"
                    >
                        Data and test set
                    </Link>
                </p>
            )}
            <ModelDataNotice slug={slug} />
            <ModelChecks slug={slug} />
            <div className="flex flex-wrap items-end gap-6">
                <Button variant="outline" onClick={() => create.mutate({ kind: "prompt" })}>
                    Score prompt-only version
                </Button>
                <div className="flex flex-wrap items-end gap-2">
                    <Field id="max-rows" label="Training rows">
                        <NumberField
                            id="max-rows"
                            value={maxRows}
                            onValueChange={setMaxRows}
                            min={10}
                            step={100}
                            largeStep={1000}
                            format={{ maximumFractionDigits: 0 }}
                        />
                    </Field>
                    <Field id="epochs" label="Epochs">
                        <NumberField
                            id="epochs"
                            value={epochs}
                            onValueChange={setEpochs}
                            min={0.1}
                            max={10}
                            step={1}
                            smallStep={0.1}
                            format={{ maximumFractionDigits: 2 }}
                        />
                    </Field>
                    <Button
                        ref={trainButton}
                        onClick={train}
                        disabled={create.isPending || maxRows === null || epochs === null}
                    >
                        Train new version
                    </Button>
                </div>
            </div>
            <ErrorLine error={create.error} />
        </Section>
    );
}

function prepareHint(dataset: string, mapped: boolean, preparing: boolean): string {
    if (preparing) {
        return "Preparing the data. Training options appear here when it is done.";
    }
    if (!dataset) {
        return "Choose where the examples come from.";
    }
    if (!mapped) {
        return "Pick the input and label columns above and save them first.";
    }
    return "Splits the rows into training, held-out, few-shot and test rows. Takes a few seconds.";
}

function AddTrainingData({
    detail,
    jobs,
    onPrepared,
}: {
    detail: MinibrainDetail;
    jobs: JobInfo[];
    onPrepared: () => void;
}) {
    const slug = detail.slug;
    const invalidate = useInvalidate(slug);
    const datasets = useDatasets();
    const [dataset, setDataset] = useState(detail.dataset ?? "");
    const mapped = Boolean(datasets.data?.find((item) => item.slug === dataset)?.mapping.sql);
    const job = jobs.find((item) => item.kind === "prepare");
    const preparing = job !== undefined && isActiveJob(job);
    const prepare = useMutation({
        mutationFn: async () => {
            const path = { params: { path: { slug } } };
            await unwrap(api.PUT("/api/minibrains/{slug}/dataset", { ...path, body: { dataset } }));
            return unwrap(api.POST("/api/minibrains/{slug}/snapshots", path));
        },
        onSuccess: onPrepared,
        onSettled: invalidate,
    });
    const busy = prepare.isPending || preparing;
    return (
        <PanelSection
            icon={Database}
            title="Training data"
            description="This model has no examples yet. Add labelled examples, prepare them, then train."
        >
            <div className="flex flex-col gap-4">
                <TrainingData dataset={dataset} onDataset={setDataset} />
                <div className="flex flex-col gap-3 border-t pt-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <Button
                            onClick={() => prepare.mutate()}
                            disabled={!dataset || !mapped || busy}
                        >
                            {busy ? "Preparing…" : "Prepare training data"}
                        </Button>
                        <output className="text-sm text-muted-foreground">
                            {prepareHint(dataset, mapped, busy)}
                        </output>
                    </div>
                    <ErrorLine error={prepare.error} />
                    {job && job.status !== "succeeded" && (
                        <>
                            {!isActiveJob(job) && (
                                <p className="text-sm text-destructive">
                                    {job.status === "cancelled"
                                        ? "Preparing was cancelled. Prepare again when you are ready."
                                        : "Preparing failed. Check the columns, or choose other data with more labelled rows, then prepare again."}
                                </p>
                            )}
                            <JobPanel job={job} slug={slug} />
                        </>
                    )}
                </div>
            </div>
        </PanelSection>
    );
}

export function Training({ slug }: { slug: string }) {
    const { data: detail } = useMinibrain(slug);
    const { data: jobs } = useJobs(slug);
    const [prepared, setPrepared] = useState(false);
    if (!detail) {
        return null;
    }
    if (!detail.snapshot) {
        return (
            <AddTrainingData
                detail={detail}
                jobs={jobs ?? []}
                onPrepared={() => setPrepared(true)}
            />
        );
    }
    const versionJobs = (jobs ?? []).filter((job) => job.kind !== "prepare");
    const active = versionJobs.filter(isActiveJob);
    const finished = versionJobs.filter((job) => !isActiveJob(job)).slice(0, FINISHED_SHOWN);
    return (
        <>
            <CreateVersion detail={detail} focusTrain={prepared} />
            <Section title="Jobs" caption="One job runs at a time; the rest wait in the queue.">
                {active.length + finished.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No jobs yet.</p>
                ) : (
                    <div className="flex flex-col gap-3">
                        {[...active, ...finished].map((job) => (
                            <JobPanel key={job.id} job={job} slug={slug} />
                        ))}
                    </div>
                )}
            </Section>
        </>
    );
}
