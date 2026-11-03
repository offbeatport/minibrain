import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Button,
    Field,
    Input,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { useState } from "react";
import { type DatasetSummary, type SourceSummary, api, succeed, unwrap } from "~/api/client";
import { keys, useDataset, useDatasetPreview, useModels, useSources } from "~/api/queries";
import { ErrorLine, Section, Stat } from "~/components/Section";
import { count } from "~/lib/format";
import { relativeTime } from "~/lib/time";
import { type MappingBody, PreviewSection, QueryEditor } from "./QueryEditor";
import { DATASETS_GROUP, type ItemRef, itemHref, plural, stem } from "./catalogue";
import {
    About,
    DeleteAction,
    EditDialog,
    ItemHeader,
    LabelBalance,
    Trail,
    modelHref,
    useDataRefresh,
    useModelNames,
} from "./parts";

const SPLITS: [string, string][] = [
    ["train", "Training"],
    ["eval", "Held-out"],
    ["golden", "Test set"],
    ["shots", "Few-shot"],
];

function useDatasetRefresh(slug: string) {
    const client = useQueryClient();
    const refresh = useDataRefresh();
    return async () => {
        await Promise.all([
            client.invalidateQueries({ queryKey: keys.dataset(slug) }),
            client.invalidateQueries({ queryKey: keys.datasetPreview(slug) }),
            refresh(),
        ]);
    };
}

export function DatasetQuery({
    dataset,
    sources,
}: {
    dataset: DatasetSummary;
    sources: SourceSummary[];
}) {
    const refresh = useDatasetRefresh(dataset.slug);
    const path = { params: { path: { slug: dataset.slug } } };
    return (
        <QueryEditor
            mapping={dataset.mapping}
            mode={dataset.mode}
            sourceId={dataset.source_id}
            sources={sources}
            onSave={(body: MappingBody) =>
                unwrap(api.PUT("/api/datasets/{slug}/mapping", { ...path, body })).then(refresh)
            }
            onRun={(sql) =>
                unwrap(api.POST("/api/datasets/{slug}/query", { ...path, body: { sql } }))
            }
        />
    );
}

export function DatasetMapping({ slug }: { slug: string }) {
    const dataset = useDataset(slug);
    const sources = useSources();
    const mapped = Boolean(dataset.data?.mapping.sql);
    const preview = useDatasetPreview(slug, mapped);
    if (!dataset.data) {
        return <ErrorLine error={dataset.error} />;
    }
    return (
        <>
            <DatasetQuery dataset={dataset.data} sources={sources.data ?? []} />
            {mapped && (
                <PreviewSection
                    data={preview.data}
                    error={preview.error}
                    loading={preview.isLoading}
                />
            )}
        </>
    );
}

const EMPTY_MAPPING = { input_column: null, label_column: null, sql: null };

export function CreateDataset({
    source,
    sources,
    onCreated,
    onCancel,
}: {
    source?: SourceSummary;
    sources: SourceSummary[];
    onCreated: (dataset: DatasetSummary) => Promise<void>;
    onCancel: () => void;
}) {
    const [name, setName] = useState(source ? stem(source.name) : "");
    return (
        <QueryEditor
            title="New dataset"
            saveLabel="Create dataset"
            mapping={EMPTY_MAPPING}
            mode="columns"
            sourceId={source?.id}
            sources={sources}
            extraActions={
                <Button variant="ghost" size="sm" onClick={onCancel}>
                    Cancel
                </Button>
            }
            before={
                <Field id="new-dataset-name" label="Name" className="mb-4 max-w-sm">
                    <Input
                        id="new-dataset-name"
                        value={name}
                        maxLength={80}
                        placeholder="Support tickets by team"
                        onChange={(event) => setName(event.target.value)}
                    />
                </Field>
            }
            onSave={async (body) => {
                const fallback = sources.find((item) => item.id === body.source_id)?.name;
                const created = await unwrap(
                    api.POST("/api/datasets", {
                        body: {
                            name: name.trim() || stem(fallback ?? "") || "New dataset",
                            ...body,
                        },
                    }),
                );
                await onCreated(created);
            }}
            onRun={(sql) => unwrap(api.POST("/api/query", { body: { sql } }))}
        />
    );
}

function UsedBy({ dataset }: { dataset: DatasetSummary }) {
    const refresh = useDataRefresh();
    const models = useModels();
    const nameOf = useModelNames();
    const candidates = (models.data ?? []).filter(
        (row) => row.kind === "custom" && !dataset.models.includes(row.key),
    );
    const assign = useMutation({
        mutationFn: (slug: string) =>
            unwrap(
                api.PUT("/api/minibrains/{slug}/dataset", {
                    params: { path: { slug } },
                    body: { dataset: dataset.slug },
                }),
            ),
        onSuccess: refresh,
    });
    return (
        <Section
            title="Used by"
            caption="Models that train on this dataset. Several models can share one to compare fairly."
        >
            <div className="flex flex-col gap-3">
                {dataset.models.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No model trains on it yet.</p>
                ) : (
                    <ul className="flex flex-col divide-y rounded-lg border">
                        {dataset.models.map((slug) => (
                            <li key={slug} className="flex h-9 items-center gap-3 px-3">
                                <Link href={modelHref(slug)} className="truncate text-primary">
                                    {nameOf(slug)}
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
                {candidates.length > 0 && (
                    <Select
                        value=""
                        onValueChange={(slug) => slug && assign.mutate(String(slug))}
                        disabled={assign.isPending}
                    >
                        <SelectTrigger aria-label="Use for a model" className="w-72 max-w-full">
                            <SelectValue placeholder="Use it for another model" />
                        </SelectTrigger>
                        <SelectContent>
                            {candidates.map((row) => (
                                <SelectItem key={row.key} value={row.key}>
                                    {row.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
                <ErrorLine error={assign.error} />
            </div>
        </Section>
    );
}

export function DatasetDetail({
    dataset,
    sources,
    onSelect,
}: {
    dataset: DatasetSummary;
    sources: SourceSummary[];
    onSelect: (item: ItemRef) => void;
}) {
    const refresh = useDataRefresh();
    const nameOf = useModelNames();
    const [editing, setEditing] = useState(false);
    const mapped = Boolean(dataset.mapping.sql);
    const preview = useDatasetPreview(dataset.slug, mapped);
    const path = { params: { path: { slug: dataset.slug } } };
    const remove = useMutation({
        mutationFn: () => succeed(api.DELETE("/api/datasets/{slug}", path)),
        onSuccess: async () => {
            onSelect(DATASETS_GROUP);
            await refresh();
        },
    });
    const quality = preview.data?.quality;
    const splits = dataset.splits;
    return (
        <div className="flex flex-col gap-6">
            <ItemHeader
                title={dataset.name}
                detail={
                    <>
                        Dataset <span className="font-mono">{dataset.slug}</span>
                        {` · ${dataset.mode === "sql" ? "SQL" : "columns"} · updated ${relativeTime(dataset.updated_at)}`}
                    </>
                }
                trail={
                    <Trail
                        current="dataset"
                        sources={dataset.sources.map((source) => ({
                            label: source.name,
                            href: itemHref({ kind: "source", id: source.id }),
                        }))}
                        datasets={[
                            {
                                label: dataset.name,
                                href: itemHref({ kind: "dataset", id: dataset.slug }),
                            },
                        ]}
                        models={dataset.models.map((slug) => ({
                            label: nameOf(slug),
                            href: modelHref(slug),
                        }))}
                    />
                }
                actions={
                    <>
                        <Button asChild>
                            <Link href={`/models/new?dataset=${encodeURIComponent(dataset.slug)}`}>
                                Train a model
                            </Link>
                        </Button>
                        <Button variant="outline" onClick={() => setEditing(true)}>
                            Edit
                        </Button>
                        <DeleteAction
                            blocked={
                                dataset.models.length
                                    ? "Used by models: pick another dataset for them first"
                                    : null
                            }
                            title={`Delete ${dataset.name}?`}
                            description="The query goes; the sources it reads stay."
                            onConfirm={() => remove.mutateAsync().catch(() => undefined)}
                        />
                    </>
                }
                about={<About item={dataset} onEdit={() => setEditing(true)} />}
            />
            <ErrorLine error={remove.error} />
            {dataset.error && (
                <p className="text-sm text-destructive">{`The query fails: ${dataset.error}`}</p>
            )}
            <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat label="Rows" value={count(quality?.rows ?? dataset.rows)} />
                <Stat label="Labels" value={quality ? count(quality.labels) : "–"} />
                <Stat label="Sources" value={count(dataset.sources.length)} />
                {splits ? (
                    SPLITS.filter(([key]) => key in splits).map(([key, label]) => (
                        <Stat key={key} label={label} value={count(splits[key])} />
                    ))
                ) : (
                    <Stat
                        label="Splits"
                        value={
                            <span className="font-normal text-muted-foreground">
                                Set when a snapshot is taken
                            </span>
                        }
                    />
                )}
            </div>
            {mapped && preview.data && (
                <Section
                    title="Label balance"
                    caption="Rows per label across the whole dataset. Rare labels are the ones a model gets wrong."
                >
                    <LabelBalance counts={preview.data.label_counts} />
                </Section>
            )}
            <DatasetQuery dataset={dataset} sources={sources} />
            {mapped && (
                <PreviewSection
                    data={preview.data}
                    error={preview.error}
                    loading={preview.isLoading}
                />
            )}
            <UsedBy dataset={dataset} />
            <EditDialog
                item={dataset}
                noun="dataset"
                open={editing}
                onOpenChange={setEditing}
                onSave={(body) =>
                    unwrap(api.PATCH("/api/datasets/{slug}", { ...path, body })).then(refresh)
                }
            />
        </div>
    );
}

export function DatasetsGroup({
    datasets,
    onCreate,
    creating,
}: {
    datasets: DatasetSummary[];
    onCreate: () => void;
    creating: boolean;
}) {
    const models = new Set(datasets.flatMap((dataset) => dataset.models));
    const sql = datasets.filter((dataset) => dataset.mode === "sql").length;
    return (
        <header className="flex flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 className="text-2xl font-semibold">Datasets</h2>
                    <p className="text-sm text-muted-foreground">
                        Saved queries that turn one or more sources into input and label rows.
                        Models train on a snapshot of one.
                    </p>
                </div>
                <Button onClick={onCreate} disabled={creating}>
                    New dataset
                </Button>
            </div>
            <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat label="Datasets" value={count(datasets.length)} />
                <Stat label="Written in SQL" value={count(sql)} />
                <Stat label="Models using them" value={count(models.size)} />
            </div>
            {datasets.length === 0 && !creating && (
                <p className="text-sm text-muted-foreground">
                    No datasets yet. Add a file under Uploads, then pick its input and label
                    columns, or write SQL across several sources.
                </p>
            )}
            {datasets.length > 0 && !creating && (
                <p className="text-sm text-muted-foreground">
                    {`${plural(datasets.length, "dataset")}. Pick one to see its query, preview and the models that use it.`}
                </p>
            )}
        </header>
    );
}
