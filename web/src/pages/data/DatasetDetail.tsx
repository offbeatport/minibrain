import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
    Button,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { useState } from "react";
import { type DatasetSummary, type SourceSummary, api, succeed, unwrap } from "~/api/client";
import { keys, useDataset, useDatasetPreview, useModels } from "~/api/queries";
import { ErrorLine, Section, Stat } from "~/components/Section";
import { count } from "~/lib/format";
import { relativeTime } from "~/lib/time";
import { MappingSection, PreviewSection } from "../DataPage";
import { type ItemRef, itemHref } from "./catalogue";
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

export function DatasetMapping({ slug }: { slug: string }) {
    const dataset = useDataset(slug);
    const client = useQueryClient();
    const mapped = Boolean(dataset.data?.mapping.sql);
    const preview = useDatasetPreview(slug, mapped);
    const path = { params: { path: { slug } } };
    const refresh = async () => {
        await client.invalidateQueries({ queryKey: keys.dataset(slug) });
        await client.invalidateQueries({ queryKey: keys.datasets });
        await client.invalidateQueries({ queryKey: keys.datasetPreview(slug) });
    };
    if (!dataset.data) {
        return <ErrorLine error={dataset.error} />;
    }
    return (
        <>
            <MappingSection
                columns={dataset.data.columns.map((column) => column.name)}
                mapping={dataset.data.mapping}
                onSave={(body) =>
                    unwrap(api.PUT("/api/datasets/{slug}/mapping", { ...path, body })).then(refresh)
                }
                onRun={(sql) =>
                    unwrap(api.POST("/api/datasets/{slug}/query", { ...path, body: { sql } }))
                }
            />
            {mapped && <PreviewSection data={preview.data} error={preview.error} />}
        </>
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
                            <li
                                key={slug}
                                className="flex h-9 items-center justify-between gap-3 px-3"
                            >
                                <Link href={modelHref(slug)} className="truncate text-primary">
                                    {nameOf(slug)}
                                </Link>
                                <Link
                                    href={`/data?minibrain=${encodeURIComponent(slug)}`}
                                    className="shrink-0 text-sm text-muted-foreground hover:text-foreground"
                                >
                                    Snapshot and test set
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
    source,
    onSelect,
}: {
    dataset: DatasetSummary;
    source: SourceSummary | undefined;
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
            onSelect({ kind: "group", id: "upload" });
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
                        {` · updated ${relativeTime(dataset.updated_at)}`}
                    </>
                }
                trail={
                    <Trail
                        current="dataset"
                        source={{
                            label: source?.name ?? dataset.sources[0]?.name ?? "–",
                            href: itemHref({ kind: "source", id: dataset.sources[0]?.id ?? 0 }),
                        }}
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
                            description="The mapping goes; the file it reads from stays."
                            onConfirm={() => remove.mutateAsync().catch(() => undefined)}
                        />
                    </>
                }
                about={<About item={dataset} onEdit={() => setEditing(true)} />}
            />
            <ErrorLine error={remove.error} />
            <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat label="Rows" value={count(quality?.rows ?? dataset.rows)} />
                <Stat label="Labels" value={quality ? count(quality.labels) : "–"} />
                {splits ? (
                    SPLITS.filter(([key]) => key in splits).map(([key, label]) => (
                        <Stat key={key} label={label} value={count(splits[key])} />
                    ))
                ) : (
                    <Stat
                        label="Splits"
                        value={
                            <span className="font-normal text-muted-foreground">
                                Set when a model builds it
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
            <DatasetMapping slug={dataset.slug} />
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
