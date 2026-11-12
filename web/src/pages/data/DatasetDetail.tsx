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
import {
    keys,
    useAllModels,
    useDataset,
    useDatasetPreview,
    useDatasets,
    useSources,
} from "~/api/queries";
import { ErrorLine, Section, Stat } from "~/components/Section";
import { datasetDeleteNote } from "~/lib/datasetUse";
import { count } from "~/lib/format";
import { relativeTime } from "~/lib/time";
import { ChecksSection } from "./Checks";
import { MoveDialog, type MoveTarget, PathLinks, folderRef } from "./DatasetFolders";
import {
    ChangeNotice,
    FirstVersionNotice,
    RowLimitNotice,
    VersionsSection,
    useVersionRefresh,
} from "./DatasetVersions";
import { type MappingBody, PreviewSection, QueryEditor } from "./QueryEditor";
import {
    type FolderIndex,
    type ItemRef,
    datasetNameProblem,
    datasetsIn,
    freeDatasetName,
    itemHref,
    stem,
} from "./catalogue";
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
    const versions = useVersionRefresh(slug);
    return async () => {
        await Promise.all([
            client.invalidateQueries({ queryKey: keys.dataset(slug) }),
            client.invalidateQueries({ queryKey: keys.datasetPreview(slug) }),
            versions(),
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
            caption="Pick a source and the columns a model reads and answers with, or write SQL over one or more sources. Saving makes the next version of the dataset."
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
    folderId = null,
    onCreated,
    onCancel,
}: {
    source?: SourceSummary;
    sources: SourceSummary[];
    folderId?: number | null;
    onCreated: (dataset: DatasetSummary) => Promise<void>;
    onCancel: () => void;
}) {
    const datasets = useDatasets();
    const siblings = datasetsIn(datasets.data ?? [], folderId);
    const [typed, setTyped] = useState<string | null>(null);
    const name = typed ?? (source ? freeDatasetName(siblings, stem(source.name)) : "");
    const problem = datasetNameProblem(siblings, name);
    return (
        <QueryEditor
            title="New dataset"
            caption="Pick a source and the columns a model reads and answers with, or write SQL over one or more sources. Creating the dataset saves version 1 of its rows."
            saveLabel="Create dataset"
            saveBlocked={problem !== null}
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
                <Field id="new-dataset-name" label="Name" className="mb-4 max-w-sm" error={problem}>
                    <Input
                        id="new-dataset-name"
                        value={name}
                        maxLength={80}
                        placeholder="Support tickets by team"
                        aria-invalid={problem ? true : undefined}
                        onChange={(event) => setTyped(event.target.value)}
                    />
                </Field>
            }
            onSave={async (body) => {
                const fallback = sources.find((item) => item.id === body.source_id)?.name;
                const created = await unwrap(
                    api.POST("/api/datasets", {
                        body: {
                            name:
                                name.trim() ||
                                freeDatasetName(siblings, stem(fallback ?? "") || "New dataset"),
                            folder_id: folderId,
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

function TestExampleNote({ count: total }: { count: number }) {
    if (total === 0) {
        return null;
    }
    return (
        <span className="text-sm text-muted-foreground tabular-nums">
            {`adds ${count(total)} test ${total === 1 ? "example" : "examples"} from the Playground to the held-out rows of its next version`}
        </span>
    );
}

function UsedBy({ dataset }: { dataset: DatasetSummary }) {
    const refresh = useDataRefresh();
    const models = useAllModels();
    const nameOf = useModelNames();
    const candidates = (models.data ?? []).filter(
        (row) => row.kind === "custom" && !dataset.models.includes(row.key),
    );
    const assign = useMutation({
        mutationFn: (slug: string) =>
            unwrap(
                api.PUT("/api/models/{name}/dataset", {
                    params: { path: { name: slug } },
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
                    <p className="text-muted-foreground">No model trains on it yet.</p>
                ) : (
                    <ul className="flex flex-col divide-y rounded-lg border">
                        {dataset.models.map((slug) => (
                            <li key={slug} className="flex min-h-9 items-center gap-3 px-3 py-1.5">
                                <Link href={modelHref(slug)} className="truncate text-primary">
                                    {nameOf(slug)}
                                </Link>
                                <TestExampleNote count={dataset.test_examples?.[slug] ?? 0} />
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
    index,
    onSelect,
}: {
    dataset: DatasetSummary;
    sources: SourceSummary[];
    index: FolderIndex;
    onSelect: (item: ItemRef) => void;
}) {
    const refresh = useDataRefresh();
    const nameOf = useModelNames();
    const [editing, setEditing] = useState(false);
    const [moving, setMoving] = useState<MoveTarget | null>(null);
    const folderId = dataset.folder_id ?? null;
    const mapped = Boolean(dataset.mapping.sql);
    const preview = useDatasetPreview(dataset.slug, mapped);
    const path = { params: { path: { slug: dataset.slug } } };
    const remove = useMutation({
        mutationFn: () => succeed(api.DELETE("/api/datasets/{slug}", path)),
        onSuccess: async () => {
            onSelect(folderRef(folderId));
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
                        {folderId !== null && (
                            <>
                                {" · in "}
                                <PathLinks index={index} folderId={folderId} />
                            </>
                        )}
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
                        <Button
                            variant="outline"
                            onClick={() =>
                                setMoving({
                                    item: { kind: "dataset", id: dataset.slug },
                                    name: dataset.name,
                                    from: folderId,
                                })
                            }
                        >
                            Move to…
                        </Button>
                        <DeleteAction
                            blocked={null}
                            title={`Delete ${dataset.name}?`}
                            description={datasetDeleteNote(dataset.model_names ?? [])}
                            onConfirm={() => remove.mutateAsync().catch(() => undefined)}
                        />
                    </>
                }
                about={<About item={dataset} onEdit={() => setEditing(true)} />}
            />
            <ErrorLine error={remove.error} />
            {dataset.error && (
                <p className="text-destructive">{`The query fails: ${dataset.error}`}</p>
            )}
            <RowLimitNotice rows={dataset.rows} limit={dataset.row_limit ?? 0} />
            <FirstVersionNotice dataset={dataset} />
            <ChangeNotice
                changed={dataset.changed}
                datasetVersion={dataset.dataset_version}
                dataset={dataset.slug}
                after="Models keep training on it until you update."
            />
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
                                {dataset.dataset_version
                                    ? "Unknown since the change"
                                    : "Set by the first version"}
                            </span>
                        }
                    />
                )}
            </div>
            <VersionsSection dataset={dataset} />
            <ChecksSection datasetVersion={dataset.dataset_version} dataset={dataset.slug} />
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
            <MoveDialog
                targets={moving ? [moving] : null}
                index={index}
                onOpenChange={(open) => !open && setMoving(null)}
            />
            <EditDialog
                item={dataset}
                noun="dataset"
                problem={(name) =>
                    datasetNameProblem(index.datasets.get(folderId) ?? [], name, dataset.slug)
                }
                open={editing}
                onOpenChange={setEditing}
                onSave={(body) =>
                    unwrap(api.PATCH("/api/datasets/{slug}", { ...path, body })).then(refresh)
                }
            />
        </div>
    );
}
