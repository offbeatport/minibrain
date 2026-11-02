import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronLeft, Database, FileText, Users } from "lucide-react";
import {
    Button,
    DataGrid,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import type { ChangeEvent } from "react";
import { type DatasetSummary, type SourceSummary, api, unwrap, uploadFile } from "~/api/client";
import {
    keys,
    useDataset,
    useDatasetPreview,
    useDatasets,
    useModels,
    useSources,
} from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, PanelSection, PanelSections } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { DATA_FILE_TYPES } from "~/lib/dataFiles";
import { count } from "~/lib/format";
import { bytes, relativeTime } from "~/lib/time";
import { MappingSection, PreviewSection } from "./DataPage";

function datasetHref(slug: string): string {
    return `/data/datasets/${encodeURIComponent(slug)}`;
}

function stem(filename: string): string {
    const dot = filename.lastIndexOf(".");
    return (dot > 0 ? filename.slice(0, dot) : filename).replaceAll(/[_-]+/g, " ");
}

function mappingLabel(dataset: DatasetSummary) {
    const { input_column: input, label_column: label, sql } = dataset.mapping;
    if (input && label) {
        return <span className="font-mono">{`${input} → ${label}`}</span>;
    }
    if (sql) {
        return <span>SQL</span>;
    }
    return <StatusText tone="warning">Needs mapping</StatusText>;
}

function useDataRefresh() {
    const client = useQueryClient();
    return () =>
        Promise.all([
            client.invalidateQueries({ queryKey: keys.datasets }),
            client.invalidateQueries({ queryKey: keys.sources }),
            client.invalidateQueries({ queryKey: keys.models }),
            client.invalidateQueries({ queryKey: ["minibrain"] }),
        ]);
}

function DeleteButton({
    blocked,
    onDelete,
    label,
}: { blocked: string | null; onDelete: () => void; label: string }) {
    if (!blocked) {
        return (
            <Button variant="ghost" size="xs" onClick={onDelete} aria-label={label}>
                Delete
            </Button>
        );
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span>
                    <Button variant="ghost" size="xs" disabled aria-label={label}>
                        Delete
                    </Button>
                </span>
            </TooltipTrigger>
            <TooltipContent>{blocked}</TooltipContent>
        </Tooltip>
    );
}

function datasetColumns(
    onDelete: (dataset: DatasetSummary) => void,
): ColumnDef<DatasetSummary, unknown>[] {
    return [
        {
            id: "name",
            header: "Dataset",
            accessorFn: (dataset) => dataset.name.toLowerCase(),
            cell: ({ row }) => (
                <Link
                    href={datasetHref(row.original.slug)}
                    className="font-semibold text-foreground"
                >
                    {row.original.name}
                </Link>
            ),
        },
        {
            id: "file",
            header: "File",
            accessorFn: (dataset) => dataset.source_name,
        },
        {
            id: "rows",
            header: "Rows",
            accessorFn: (dataset) => dataset.rows,
            cell: ({ row }) => <span className="tabular-nums">{count(row.original.rows)}</span>,
        },
        {
            id: "mapping",
            header: "Mapping",
            enableSorting: false,
            cell: ({ row }) => mappingLabel(row.original),
        },
        {
            id: "models",
            header: "Used by",
            accessorFn: (dataset) => dataset.models.length,
            cell: ({ row }) =>
                row.original.models.length === 0 ? (
                    <span className="text-muted-foreground">No models</span>
                ) : (
                    <span>{`${row.original.models.length} model${row.original.models.length === 1 ? "" : "s"}`}</span>
                ),
        },
        {
            id: "updated",
            header: "Updated",
            accessorFn: (dataset) => dataset.updated_at,
            cell: ({ row }) => (
                <span className="tabular-nums">{relativeTime(row.original.updated_at)}</span>
            ),
        },
        {
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }) => (
                <DeleteButton
                    label={`Delete dataset ${row.original.name}`}
                    blocked={
                        row.original.models.length
                            ? "Used by models: pick another dataset for them first"
                            : null
                    }
                    onDelete={() => onDelete(row.original)}
                />
            ),
        },
    ];
}

function sourceColumns(
    onUse: (source: SourceSummary) => void,
    onDelete: (source: SourceSummary) => void,
): ColumnDef<SourceSummary, unknown>[] {
    return [
        {
            id: "name",
            header: "File",
            accessorFn: (source) => source.filename.toLowerCase(),
            cell: ({ row }) => <span className="font-mono">{row.original.filename}</span>,
        },
        {
            id: "rows",
            header: "Rows",
            accessorFn: (source) => source.rows,
            cell: ({ row }) => <span className="tabular-nums">{count(row.original.rows)}</span>,
        },
        {
            id: "columns",
            header: "Columns",
            enableSorting: false,
            cell: ({ row }) => (
                <span className="line-clamp-2 max-w-md whitespace-normal font-mono text-sm text-muted-foreground">
                    {row.original.columns.map((column) => column.name).join(", ")}
                </span>
            ),
        },
        {
            id: "size",
            header: "Size",
            accessorFn: (source) => source.size,
            cell: ({ row }) => <span className="tabular-nums">{bytes(row.original.size)}</span>,
        },
        {
            id: "actions",
            header: () => <span className="sr-only">Actions</span>,
            enableSorting: false,
            cell: ({ row }) => (
                <div className="flex items-center justify-end gap-1">
                    <Button variant="outline" size="xs" onClick={() => onUse(row.original)}>
                        New dataset
                    </Button>
                    <DeleteButton
                        label={`Delete file ${row.original.filename}`}
                        blocked={
                            row.original.datasets.length
                                ? "Used by datasets: delete those first"
                                : null
                        }
                        onDelete={() => onDelete(row.original)}
                    />
                </div>
            ),
        },
    ];
}

export function DataLibrary() {
    const router = useRouter();
    const refresh = useDataRefresh();
    const datasets = useDatasets();
    const sources = useSources();
    const createFrom = async (source: SourceSummary) => {
        const dataset = await unwrap(
            api.POST("/api/datasets", {
                body: { name: stem(source.filename), source_id: source.id },
            }),
        );
        await refresh();
        router.history.push(datasetHref(dataset.slug));
    };
    const upload = useMutation({
        mutationFn: async (file: File) => createFrom(await uploadFile(file)),
    });
    const remove = useMutation({
        mutationFn: (target: { dataset?: string; source?: number }) =>
            target.dataset
                ? unwrap(
                      api.DELETE("/api/datasets/{slug}", {
                          params: { path: { slug: target.dataset } },
                      }),
                  )
                : unwrap(
                      api.DELETE("/api/sources/{source_id}", {
                          params: { path: { source_id: target.source ?? 0 } },
                      }),
                  ),
        onSuccess: refresh,
    });
    const choose = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            upload.mutate(file);
        }
        event.target.value = "";
    };
    return (
        <Page wide>
            <PageHeader
                title="Data"
                caption="Datasets and the files behind them, shared by every model."
                actions={
                    <Button asChild>
                        <label className="cursor-pointer">
                            {upload.isPending ? "Uploading…" : "Upload file"}
                            <input
                                type="file"
                                className="sr-only"
                                accept={DATA_FILE_TYPES}
                                onChange={choose}
                                disabled={upload.isPending}
                            />
                        </label>
                    </Button>
                }
            />
            <ErrorLine error={upload.error ?? remove.error ?? datasets.error ?? sources.error} />
            <PanelSections>
                <PanelSection icon={Database} title="Datasets" bare>
                    <DataGrid
                        columns={datasetColumns((dataset) =>
                            remove.mutate({ dataset: dataset.slug }),
                        )}
                        rows={datasets.data ?? []}
                        storageKey="minibrain.datasets.columns"
                        onOpen={(dataset) => router.history.push(datasetHref(dataset.slug))}
                        rowLabel={(dataset) => `${dataset.name} dataset`}
                        empty={
                            <p className="text-muted-foreground">
                                No datasets yet. Upload a CSV, TSV, JSON Lines or Parquet file to
                                make one.
                            </p>
                        }
                        minWidth="min-w-[720px]"
                    />
                </PanelSection>
                <PanelSection icon={FileText} title="Files" bare>
                    <DataGrid
                        columns={sourceColumns(createFrom, (source) =>
                            remove.mutate({ source: source.id }),
                        )}
                        rows={sources.data ?? []}
                        storageKey="minibrain.files.columns"
                        empty={<p className="text-muted-foreground">No files uploaded yet.</p>}
                        minWidth="min-w-[720px]"
                    />
                </PanelSection>
            </PanelSections>
        </Page>
    );
}

function UsedBy({ dataset }: { dataset: DatasetSummary }) {
    const refresh = useDataRefresh();
    const models = useModels();
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
    const names = new Map((models.data ?? []).map((row) => [row.key, row.name]));
    return (
        <PanelSection icon={Users} title="Used by">
            <div className="flex flex-col gap-3">
                {dataset.models.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No model trains on it yet.</p>
                ) : (
                    <ul className="flex flex-wrap gap-x-4 gap-y-1">
                        {dataset.models.map((slug) => (
                            <li key={slug}>
                                <Link
                                    href={`/data?minibrain=${encodeURIComponent(slug)}`}
                                    className="text-primary hover:underline"
                                >
                                    {names.get(slug) ?? slug}
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
                {candidates.length > 0 && (
                    <Select
                        onValueChange={(slug) => slug && assign.mutate(String(slug))}
                        disabled={assign.isPending}
                    >
                        <SelectTrigger aria-label="Use for a model" className="w-72">
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
        </PanelSection>
    );
}

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

export function DatasetPage() {
    const { slug = "" } = useParams({ strict: false }) as { slug?: string };
    const dataset = useDataset(slug);
    return (
        <Page>
            <Link
                href="/data"
                className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ChevronLeft className="size-4" />
                Data
            </Link>
            <ErrorLine error={dataset.error} />
            {dataset.data && (
                <>
                    <PageHeader
                        title={dataset.data.name}
                        caption={`${dataset.data.source_name} · ${count(dataset.data.rows)} rows · ${count(dataset.data.columns.length)} columns`}
                    />
                    <PanelSections>
                        <UsedBy dataset={dataset.data} />
                        <DatasetMapping slug={slug} />
                    </PanelSections>
                </>
            )}
        </Page>
    );
}
