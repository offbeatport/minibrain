import { useMutation } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Database } from "lucide-react";
import {
    Button,
    ConfirmDialog,
    Field,
    Link,
    NumberField,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { useEffect, useRef, useState } from "react";
import { type ModelDetail, type VersionCreate, api, unwrap } from "~/api/client";
import { type DatasetVersionInfo, useDatasetVersions } from "~/api/dataQueries";
import { isActiveJob, useDatasets, useJobs, useModel } from "~/api/queries";
import { FeedbackSince } from "~/components/FeedbackSince";
import { JobPanel } from "~/components/JobPanel";
import { ErrorLine, PanelSection, Section, errorMessage } from "~/components/Section";
import { count } from "~/lib/format";
import { useInvalidate } from "~/lib/jobs";
import { relativeTime } from "~/lib/time";
import { ModelChecks } from "./data/Checks";
import { TrainingData } from "./data/TrainingData";
import { ModelDataNotice } from "./data/versionData";
import {
    NO_CHOICES,
    type TrainingChoices,
    TrainingPlanPanel,
    chosenSettings,
    useTrainingPlan,
} from "./training/TrainingPlan";

const FINISHED_SHOWN = 5;

function DataLine({
    detail,
    datasetVersion,
}: {
    detail: ModelDetail;
    datasetVersion: DatasetVersionInfo | null | undefined;
}) {
    if (!datasetVersion) {
        return null;
    }
    const name = detail.dataset_name ?? "Training data";
    const version =
        datasetVersion.number === null || datasetVersion.number === undefined
            ? ""
            : `, version ${datasetVersion.number}`;
    return (
        <p className="text-sm text-muted-foreground tabular-nums">
            {`${name}${version}: ${count(datasetVersion.counts.train)} training rows, ${count(datasetVersion.counts.golden)} in the test set, ${count(datasetVersion.labels.length)} labels. Accepted feedback joins these rows when a version starts. `}
            <Link
                href={`/data?model=${encodeURIComponent(detail.slug)}`}
                className="text-primary hover:underline"
            >
                Data and test set
            </Link>
        </p>
    );
}

function VersionPicker({
    versions,
    value,
    onChange,
}: {
    versions: DatasetVersionInfo[];
    value: string;
    onChange: (value: string) => void;
}) {
    return (
        <Field id="dataset-version" label="Dataset version">
            <Select value={value} onValueChange={(next) => next && onChange(String(next))}>
                <SelectTrigger id="dataset-version" className="w-72 max-w-full">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {versions.map((item, index) => (
                        <SelectItem
                            key={item.id}
                            value={String(item.id)}
                            description={`${count(item.rows)} rows · saved ${relativeTime(item.taken_at ?? item.created_at)}`}
                        >
                            {index === 0
                                ? `Version ${item.number} (latest)`
                                : `Version ${item.number}`}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </Field>
    );
}

function CreateVersion({ detail, focusTrain }: { detail: ModelDetail; focusTrain: boolean }) {
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
    const [choices, setChoices] = useState<TrainingChoices>(NO_CHOICES);
    const versions = useDatasetVersions(detail.dataset ?? "", Boolean(detail.dataset));
    const options = versions.data ?? [];
    const [picked, setPicked] = useState<string | null>(null);
    const chosen = options.find((item) => String(item.id) === picked);
    const shown = chosen ?? detail.dataset_version;
    const settings = { ...choices, max_rows: maxRows, epochs };
    const plan = useTrainingPlan(slug, chosen?.id ?? null, settings);
    const [breaking, setBreaking] = useState<{ body: VersionCreate; reason: string } | null>(null);
    const create = useMutation({
        mutationFn: (body: VersionCreate) =>
            unwrap(
                api.POST("/api/models/{slug}/versions", {
                    params: { path: { slug } },
                    body: chosen ? { ...body, dataset_version_id: chosen.id } : body,
                }),
            ),
        onSuccess: invalidate,
        onError: (error, body) => {
            const reason = errorMessage(error) ?? "";
            if (!body.breaking && reason.includes("breaking change")) {
                setBreaking({ body, reason });
            }
        },
    });
    const train = () => {
        if (maxRows !== null && epochs !== null) {
            create.mutate({ kind: "lora", ...chosenSettings(settings) });
        }
    };
    const refused = plan.data?.level === "insufficient";
    return (
        <Section
            title="New version"
            caption="Score the base model with a prompt first. Train when the score shows a gap worth closing."
        >
            <div className="mb-4 flex flex-col gap-3">
                <DataLine detail={detail} datasetVersion={shown} />
                {options.length > 0 && (
                    <VersionPicker
                        versions={options}
                        value={String((chosen ?? options[0]).id)}
                        onChange={setPicked}
                    />
                )}
                <ModelDataNotice slug={slug} />
            </div>
            <ModelChecks datasetVersion={shown} />
            <TrainingPlanPanel
                plan={plan.data}
                error={plan.error}
                choices={choices}
                onChange={setChoices}
            />
            <ErrorLine error={plan.error} />
            <div className="flex flex-wrap items-end gap-6 pt-4">
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
                        disabled={
                            create.isPending || maxRows === null || epochs === null || refused
                        }
                    >
                        Train new version
                    </Button>
                </div>
            </div>
            <ErrorLine error={breaking ? null : create.error} />
            <ConfirmDialog
                open={breaking !== null}
                onOpenChange={(open) => !open && setBreaking(null)}
                title="This version breaks the contract"
                description={breaking?.reason ?? ""}
                confirmLabel="Create it anyway"
                destructive
                onConfirm={() => {
                    const body = breaking?.body;
                    setBreaking(null);
                    return body ? create.mutateAsync({ ...body, breaking: true }) : undefined;
                }}
            />
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
    return "Models train on a saved version of the dataset's rows, split into training, held-out, few-shot and test rows.";
}

function AddTrainingData({
    detail,
    onPrepared,
}: {
    detail: ModelDetail;
    onPrepared: () => void;
}) {
    const slug = detail.slug;
    const invalidate = useInvalidate(slug);
    const datasets = useDatasets();
    const [dataset, setDataset] = useState(detail.dataset ?? "");
    const mapped = Boolean(datasets.data?.find((item) => item.slug === dataset)?.mapping.sql);
    const prepare = useMutation({
        mutationFn: async () => {
            const path = { params: { path: { slug } } };
            await unwrap(api.PUT("/api/models/{slug}/dataset", { ...path, body: { dataset } }));
            return unwrap(api.POST("/api/models/{slug}/dataset-versions", path));
        },
        onSuccess: onPrepared,
        onSettled: invalidate,
    });
    const busy = prepare.isPending;
    return (
        <PanelSection
            icon={Database}
            title="Training data"
            description="This model has no examples yet. Add labelled examples, pick the dataset, then train."
        >
            <div className="flex flex-col gap-4">
                <TrainingData dataset={dataset} onDataset={setDataset} />
                <div className="flex flex-col gap-3 border-t pt-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <Button
                            onClick={() => prepare.mutate()}
                            disabled={!dataset || !mapped || busy}
                        >
                            {busy ? "Saving…" : "Use this dataset"}
                        </Button>
                        <output className="text-sm text-muted-foreground">
                            {prepareHint(dataset, mapped, busy)}
                        </output>
                    </div>
                    <ErrorLine error={prepare.error} />
                </div>
            </div>
        </PanelSection>
    );
}

export function Training({ slug }: { slug: string }) {
    const { data: detail } = useModel(slug);
    const { data: jobs } = useJobs(slug);
    const [prepared, setPrepared] = useState(false);
    if (!detail) {
        return null;
    }
    if (!detail.dataset_version) {
        return <AddTrainingData detail={detail} onPrepared={() => setPrepared(true)} />;
    }
    const active = (jobs ?? []).filter(isActiveJob);
    const finished = (jobs ?? []).filter((job) => !isActiveJob(job)).slice(0, FINISHED_SHOWN);
    return (
        <>
            <CreateVersion detail={detail} focusTrain={prepared} />
            <Section
                title="Feedback"
                caption="Answers marked right or wrong since the last version. Accepted ones join the next training data."
            >
                <FeedbackSince slug={slug} />
            </Section>
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
