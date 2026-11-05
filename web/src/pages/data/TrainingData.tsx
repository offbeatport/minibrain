import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from "obp-ui";
import { useState } from "react";
import { type DatasetSummary, type SourceSummary, api, unwrap, uploadFile } from "~/api/client";
import { keys, useDatasets, useSamples, useSources } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { DATA_FILE_TYPES } from "~/lib/dataFiles";
import { count } from "~/lib/format";
import { bytes } from "~/lib/time";
import { DatasetMapping } from "./DatasetDetail";
import { datasetsIn, freeDatasetName } from "./catalogue";

type DataSource = "upload" | "dataset" | "sample";

const SAMPLE_TAGS = ["minibrain:sample", "sample"];

const FILE_BUTTON_FOCUS =
    "cursor-pointer has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-1 has-focus-visible:ring-offset-background";

function stem(filename: string): string {
    return (
        filename
            .replace(/\.[^.]+$/, "")
            .replace(/[_-]+/g, " ")
            .trim() || "Uploaded data"
    );
}

function failure(error: unknown, action: string): Error | null {
    if (!error) {
        return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`${message.replace(/\.$/, "")}. ${action}`);
}

function useCatalogueRefresh() {
    const client = useQueryClient();
    return () =>
        Promise.all([
            client.invalidateQueries({ queryKey: keys.datasets }),
            client.invalidateQueries({ queryKey: keys.sources }),
        ]);
}

function readerOf(source: SourceSummary, datasets: DatasetSummary[]): DatasetSummary | undefined {
    return datasets.find(
        (dataset) =>
            dataset.sources.length === 1 &&
            dataset.sources[0]?.id === source.id &&
            Boolean(dataset.mapping.sql),
    );
}

function uploadNote(source: SourceSummary, outcome: string, dataset: DatasetSummary): string {
    if (outcome === "existing") {
        return `Already uploaded as ${source.name}; using its dataset ${dataset.name}.`;
    }
    return source.name === source.filename
        ? `Added ${source.name} as the dataset ${dataset.name}.`
        : `Added as ${source.name}, since a different ${source.filename} is already uploaded.`;
}

function UploadChoice({ onDataset }: { onDataset: (slug: string) => void }) {
    const refresh = useCatalogueRefresh();
    const datasets = useDatasets();
    const [file, setFile] = useState<File | null>(null);
    const upload = useMutation({
        mutationFn: async (chosen: File) => {
            const uploaded = await uploadFile(chosen);
            if (uploaded.outcome === "name_taken") {
                throw new Error(uploaded.taken.detail);
            }
            const known = datasets.data ?? [];
            const reading = uploaded.outcome === "existing" ? readerOf(uploaded, known) : undefined;
            const dataset =
                reading ??
                (await unwrap(
                    api.POST("/api/datasets", {
                        body: {
                            name: freeDatasetName(datasetsIn(known, null), stem(uploaded.name)),
                            source_id: uploaded.id,
                        },
                    }),
                ));
            return { dataset, note: uploadNote(uploaded, uploaded.outcome, dataset) };
        },
        onSuccess: async ({ dataset }) => {
            await refresh();
            onDataset(dataset.slug);
        },
    });
    return (
        <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
                <Button asChild variant="outline" disabled={upload.isPending}>
                    <label className={FILE_BUTTON_FOCUS}>
                        {file ? "Choose another file" : "Choose file"}
                        <input
                            type="file"
                            accept={DATA_FILE_TYPES}
                            className="sr-only"
                            disabled={upload.isPending}
                            onChange={(event) => {
                                const chosen = event.target.files?.[0];
                                event.target.value = "";
                                if (chosen) {
                                    setFile(chosen);
                                    upload.mutate(chosen);
                                }
                            }}
                        />
                    </label>
                </Button>
                {file && (
                    <span className="min-w-0 truncate text-sm text-muted-foreground">
                        {upload.isPending
                            ? `Reading ${file.name}…`
                            : (upload.data?.note ?? `${file.name} · ${bytes(file.size)}`)}
                    </span>
                )}
            </div>
            <span className="text-sm text-muted-foreground">
                The file is added to Data, where other models can use it too.
            </span>
            <ErrorLine
                error={failure(
                    upload.error,
                    "Choose a CSV, TSV, JSON, JSON Lines or Parquet file with a header row.",
                )}
            />
        </div>
    );
}

function sampleDataset(
    file: string,
    sources: SourceSummary[],
    datasets: DatasetSummary[],
): { dataset?: DatasetSummary; sourceId?: number } {
    const matching = sources.filter(
        (source) =>
            source.filename === file && source.tags.some((tag) => SAMPLE_TAGS.includes(tag)),
    );
    const ids = new Set(matching.map((source) => source.id));
    const dataset = datasets.find(
        (item) => item.sources.some((ref) => ids.has(ref.id)) && item.mapping.sql,
    );
    return { dataset, sourceId: matching[0]?.id };
}

function SampleChoice({ onDataset }: { onDataset: (slug: string) => void }) {
    const samples = useSamples();
    const sources = useSources();
    const datasets = useDatasets();
    const refresh = useCatalogueRefresh();
    const [file, setFile] = useState("");
    const add = useMutation({
        mutationFn: async (chosen: string) => {
            const sample = (samples.data ?? []).find((item) => item.file === chosen);
            const found = sampleDataset(chosen, sources.data ?? [], datasets.data ?? []);
            if (found.dataset) {
                return found.dataset;
            }
            const sourceId =
                found.sourceId ??
                (
                    await unwrap(
                        api.POST("/api/samples/{file}", { params: { path: { file: chosen } } }),
                    )
                ).id;
            return unwrap(
                api.POST("/api/datasets", {
                    body: {
                        name: freeDatasetName(
                            datasetsIn(datasets.data ?? [], null),
                            sample?.name ?? stem(chosen),
                        ),
                        source_id: sourceId,
                    },
                }),
            );
        },
        onSuccess: async (dataset) => {
            await refresh();
            onDataset(dataset.slug);
        },
    });
    const chosen = (samples.data ?? []).find((item) => item.file === file);
    return (
        <div className="flex flex-col gap-1">
            <Select
                value={file}
                onValueChange={(next) => {
                    const value = String(next ?? "");
                    setFile(value);
                    if (value) {
                        add.mutate(value);
                    }
                }}
                disabled={add.isPending || sources.isLoading || datasets.isLoading}
            >
                <SelectTrigger aria-label="Sample" className="w-full max-w-sm">
                    <SelectValue placeholder="Choose a sample" />
                </SelectTrigger>
                <SelectContent>
                    {(samples.data ?? []).map((sample) => (
                        <SelectItem
                            key={sample.file}
                            value={sample.file}
                            description={`${sample.format} · ${count(sample.rows)} rows · ${count(sample.labels)} labels`}
                        >
                            {sample.name}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
            {chosen && (
                <span className="text-sm text-muted-foreground">
                    {add.isPending ? `Adding ${chosen.name}…` : chosen.description}
                </span>
            )}
            <ErrorLine
                error={failure(add.error ?? samples.error, "Try again, or upload a file instead.")}
            />
        </div>
    );
}

export function TrainingData({
    dataset,
    onDataset,
    className,
}: {
    dataset: string;
    onDataset: (slug: string) => void;
    className?: string;
}) {
    const datasets = useDatasets();
    const options = datasets.data ?? [];
    const [source, setSource] = useState<DataSource>(dataset ? "dataset" : "upload");
    const mapped = Boolean(options.find((item) => item.slug === dataset)?.mapping.sql);
    const showMapping = dataset !== "" && (source !== "sample" || (!mapped && !datasets.isLoading));
    return (
        <div className={cn("flex flex-col gap-4", className)}>
            <Select
                value={source}
                onValueChange={(next) => {
                    setSource((next ?? "upload") as DataSource);
                    onDataset("");
                }}
            >
                <SelectTrigger aria-label="Training data source" className="w-full max-w-sm">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="upload" description="CSV, TSV, JSON, JSON Lines or Parquet">
                        Upload a file
                    </SelectItem>
                    <SelectItem
                        value="dataset"
                        disabled={options.length === 0}
                        description={options.length ? "One from the Data page" : "No datasets yet"}
                    >
                        Use a dataset
                    </SelectItem>
                    <SelectItem value="sample" description="Labelled intents to try training on">
                        Sample data
                    </SelectItem>
                </SelectContent>
            </Select>
            {source === "upload" && <UploadChoice onDataset={onDataset} />}
            {source === "dataset" && (
                <Select value={dataset} onValueChange={(value) => onDataset(String(value ?? ""))}>
                    <SelectTrigger aria-label="Dataset" className="w-full max-w-sm">
                        <SelectValue placeholder="Choose a dataset" />
                    </SelectTrigger>
                    <SelectContent>
                        {options.map((item) => (
                            <SelectItem
                                key={item.slug}
                                value={item.slug}
                                description={`${count(item.rows)} rows${item.mapping.sql ? "" : " · columns not picked yet"}`}
                            >
                                {item.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}
            {source === "sample" && <SampleChoice onDataset={onDataset} />}
            {showMapping && <DatasetMapping slug={dataset} />}
        </div>
    );
}
