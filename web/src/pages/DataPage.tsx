import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
    Button,
    DataGrid,
    Field,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    SqlEditor,
} from "obp-ui";
import { ChatBubble } from "obp-ui/chat";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
    type ExampleInfo,
    type MappingInfo,
    type ModelDetail,
    type PreviewResponse,
    type QueryResponse,
    api,
    unwrap,
} from "~/api/client";
import { keys, useDatasets, useGolden, useModel, useModels, usePreview } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, Section, Stat } from "~/components/Section";
import { asCode, count, dateTime } from "~/lib/format";
import { useSearchParam } from "~/lib/listSearch";
import { sqlProblem } from "~/lib/sqlError";
import { DataExplorer } from "./data/Explorer";
import { itemHref } from "./data/catalogue";

type Row = { input: string | null; label: string | null };

const ROW_COLUMNS: ColumnDef<Row, unknown>[] = [
    { header: "Input", accessorKey: "input", cell: (info) => <Clamp text={info.getValue()} /> },
    {
        header: "Label",
        accessorKey: "label",
        cell: (info) => <span className="font-mono">{String(info.getValue() ?? "–")}</span>,
    },
];

function Clamp({ text }: { text: unknown }) {
    return <span className="line-clamp-2 max-w-xl">{text === null ? "–" : String(text)}</span>;
}

function useRefresh(slug: string) {
    const queryClient = useQueryClient();
    return useCallback(
        async (detail?: ModelDetail) => {
            if (detail) {
                queryClient.setQueryData(keys.model(slug), detail);
            }
            await queryClient.invalidateQueries({ queryKey: ["model", slug] });
            await queryClient.invalidateQueries({ queryKey: keys.models });
        },
        [queryClient, slug],
    );
}

function SourceSection({ detail }: { detail: ModelDetail }) {
    const source = detail.source;
    return (
        <Section
            title="Source"
            caption="A CSV, TSV, JSON Lines or Parquet file. It is copied into this install."
            actions={
                <Button asChild variant={source ? "outline" : "default"} size="sm">
                    <Link href="/data">{source ? "Change data" : "Add data"}</Link>
                </Button>
            }
        >
            {source ? (
                <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-6">
                        <Stat
                            label="File"
                            value={<span className="font-mono">{source.file}</span>}
                        />
                        <Stat label="Rows" value={count(source.rows)} />
                        <Stat label="Columns" value={count(source.columns.length)} />
                    </div>
                    <p className="text-sm text-muted-foreground">
                        {source.columns.map((column) => (
                            <span key={column.name} className="mr-3 inline-block">
                                <span className="font-mono text-foreground">{column.name}</span>{" "}
                                {column.type.toLowerCase()}
                            </span>
                        ))}
                    </p>
                </div>
            ) : (
                <p className="text-sm text-muted-foreground">No data yet.</p>
            )}
        </Section>
    );
}

function ColumnSelect({
    id,
    label,
    value,
    columns,
    onChange,
}: {
    id: string;
    label: string;
    value: string;
    columns: string[];
    onChange: (value: string) => void;
}) {
    return (
        <Field id={id} label={label}>
            <Select value={value} onValueChange={(next) => onChange(String(next ?? ""))}>
                <SelectTrigger id={id} className="w-56">
                    <SelectValue placeholder="Pick a column" />
                </SelectTrigger>
                <SelectContent>
                    {columns.map((column) => (
                        <SelectItem key={column} value={column}>
                            {column}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </Field>
    );
}

function QueryResult({ result }: { result: QueryResponse }) {
    const columns: ColumnDef<string[], unknown>[] = result.columns.map((name, index) => ({
        id: name,
        header: name,
        accessorFn: (row) => row[index],
        cell: (info) => <Clamp text={info.getValue()} />,
    }));
    return (
        <DataGrid
            columns={columns}
            rows={result.rows.map((row) => row.map((cell) => cell ?? ""))}
        />
    );
}

type MappingBody = { input_column?: string; label_column?: string; sql?: string };

export function MappingSection({
    columns,
    mapping,
    onSave,
    onRun,
    title = "Mapping",
    saveLabel,
    before,
    extraActions,
}: {
    columns: string[];
    mapping: MappingInfo;
    onSave: (body: MappingBody) => Promise<unknown>;
    onRun: (sql: string) => Promise<QueryResponse>;
    title?: string;
    saveLabel?: string;
    before?: ReactNode;
    extraActions?: ReactNode;
}) {
    const [input, setInput] = useState(mapping.input_column ?? "");
    const [label, setLabel] = useState(mapping.label_column ?? "");
    const [sql, setSql] = useState(mapping.sql ?? "");
    const [editing, setEditing] = useState(false);
    useEffect(() => {
        setInput(mapping.input_column ?? "");
        setLabel(mapping.label_column ?? "");
        setSql(mapping.sql ?? "");
    }, [mapping]);
    const save = useMutation({ mutationFn: onSave });
    const run = useMutation({ mutationFn: onRun });
    const problem = run.error
        ? sqlProblem(run.error, run.variables, sql)
        : sqlProblem(save.error, save.variables?.sql, sql);
    const runSql = (text: string) => {
        if (text.trim() && !run.isPending) {
            run.mutate(text);
        }
    };
    return (
        <Section
            title={title}
            caption="Pick the column the model reads and the column it should answer with, or write SQL over the table source."
            actions={
                <>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)}>
                        {editing ? "Use columns" : "Edit SQL"}
                    </Button>
                    {extraActions}
                </>
            }
        >
            {before}
            {editing ? (
                <div className="flex flex-col gap-2">
                    <SqlEditor
                        value={sql}
                        onValueChange={setSql}
                        onRun={runSql}
                        schema={{ source: columns }}
                        diagnostics={problem?.diagnostics}
                        minLines={6}
                        aria-label="SQL"
                    />
                    <p className="text-sm text-muted-foreground">
                        Return two columns named <span className="font-mono">input</span> and{" "}
                        <span className="font-mono">label</span>; Cmd/Ctrl+Enter runs it. Queries
                        are read-only and cannot reach files or the network.
                    </p>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => runSql(sql)}>
                            Run
                        </Button>
                        <Button size="sm" onClick={() => save.mutate({ sql })}>
                            {saveLabel ?? "Save SQL"}
                        </Button>
                    </div>
                    <ErrorLine error={problem?.message} />
                    {run.data && <QueryResult result={run.data} />}
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-end gap-3">
                        <ColumnSelect
                            id="input-column"
                            label="Input"
                            value={input}
                            columns={columns}
                            onChange={setInput}
                        />
                        <ColumnSelect
                            id="label-column"
                            label="Label"
                            value={label}
                            columns={columns}
                            onChange={setLabel}
                        />
                        <Button
                            size="default"
                            disabled={!input || !label || save.isPending}
                            onClick={() =>
                                save.mutate({ input_column: input, label_column: label })
                            }
                        >
                            {saveLabel ?? "Save mapping"}
                        </Button>
                    </div>
                    <ErrorLine error={save.error} />
                </div>
            )}
        </Section>
    );
}

export function PreviewSection({
    data,
    error,
}: { data: PreviewResponse | undefined; error: unknown }) {
    const quality = data?.quality;
    return (
        <Section
            title="Preview"
            caption="The first rows as the model will see them, and checks over all rows."
        >
            <ErrorLine error={error} />
            {quality && (
                <div className="mb-4 flex flex-wrap gap-6">
                    <Stat label="Rows" value={count(quality.rows)} />
                    <Stat label="Empty" value={count(quality.empty)} />
                    <Stat label="Duplicate inputs" value={count(quality.duplicates)} />
                    <Stat label="Labels" value={count(quality.labels)} />
                    <Stat
                        label="Rows per label"
                        value={`${count(quality.smallest_label)}–${count(quality.largest_label)}`}
                    />
                    <Stat
                        label="Average input"
                        value={`${count(quality.mean_input_chars)} chars`}
                    />
                </div>
            )}
            {data && (
                <div className="flex flex-col gap-4">
                    <DataGrid columns={ROW_COLUMNS} rows={data.rows} />
                    <div className="flex max-w-2xl flex-col gap-2">
                        <h3 className="text-sm font-semibold">One training example</h3>
                        {data.example.map((message) => (
                            <ChatBubble
                                key={message.role}
                                role={message.role === "user" ? "user" : "system"}
                                text={message.content}
                            />
                        ))}
                        <ChatBubble
                            role="assistant"
                            text={asCode(data.rows.find((row) => row.label)?.label ?? "")}
                        />
                    </div>
                </div>
            )}
        </Section>
    );
}

const GOLDEN_COLUMNS: ColumnDef<ExampleInfo, unknown>[] = [
    { header: "Input", accessorKey: "input", cell: (info) => <Clamp text={info.getValue()} /> },
    {
        header: "Label",
        accessorKey: "label",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
];

function DatasetSection({ detail }: { detail: ModelDetail }) {
    const refresh = useRefresh(detail.slug);
    const build = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/models/{slug}/dataset-versions", {
                    params: { path: { slug: detail.slug } },
                }),
            ),
        onSuccess: () => refresh(),
    });
    const golden = useGolden(detail.slug, Boolean(detail.dataset_version));
    const [showGolden, setShowGolden] = useState(false);
    if (!detail.mapping.sql) {
        return null;
    }
    const datasetVersion = detail.dataset_version;
    return (
        <Section
            title="Dataset version"
            caption="The saved copy of the dataset's rows that new versions train on, split into a test set, a held-out set, few-shot examples and training rows."
            actions={
                <Button size="sm" onClick={() => build.mutate()} disabled={build.isPending}>
                    {build.isPending ? "Saving…" : datasetVersion ? "Update" : "Save version 1"}
                </Button>
            }
        >
            <ErrorLine error={build.error} />
            {datasetVersion ? (
                <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-6">
                        <Stat label="Test set" value={count(datasetVersion.counts.golden)} />
                        <Stat label="Held-out" value={count(datasetVersion.counts.eval)} />
                        <Stat label="Few-shot" value={count(datasetVersion.counts.shots)} />
                        <Stat label="Training" value={count(datasetVersion.counts.train)} />
                        <Stat label="Labels" value={count(datasetVersion.labels.length)} />
                        <Stat
                            label="Version"
                            value={
                                datasetVersion.number == null ? "–" : count(datasetVersion.number)
                            }
                        />
                        <Stat
                            label="SHA-256"
                            value={
                                <span className="font-mono">
                                    {datasetVersion.hash.slice(0, 12)}
                                </span>
                            }
                        />
                    </div>
                    <p className="text-sm text-muted-foreground">
                        Saved {dateTime(datasetVersion.taken_at ?? datasetVersion.created_at)}
                    </p>
                    <div>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowGolden(!showGolden)}
                        >
                            {showGolden ? "Hide test set" : "Show test set"}
                        </Button>
                    </div>
                    {showGolden && <DataGrid columns={GOLDEN_COLUMNS} rows={golden.data ?? []} />}
                </div>
            ) : (
                <p className="text-sm text-muted-foreground">
                    Save a version of the dataset before scoring or training.
                </p>
            )}
        </Section>
    );
}

function DatasetPicker({ detail }: { detail: ModelDetail }) {
    const refresh = useRefresh(detail.slug);
    const datasets = useDatasets();
    const choose = useMutation({
        mutationFn: (dataset: string) =>
            unwrap(
                api.PUT("/api/models/{slug}/dataset", {
                    params: { path: { slug: detail.slug } },
                    body: { dataset },
                }),
            ),
        onSuccess: refresh,
    });
    const options = datasets.data ?? [];
    return (
        <Section
            title="Dataset"
            caption="Datasets are shared: several models can train on the same one. Upload a new file below, or pick one."
            actions={
                <Link href="/data" className="text-sm text-primary hover:underline">
                    All datasets
                </Link>
            }
        >
            <div className="flex flex-wrap items-center gap-3">
                <Select
                    value={detail.dataset ?? ""}
                    onValueChange={(next) => next && choose.mutate(String(next))}
                    disabled={options.length === 0 || choose.isPending}
                >
                    <SelectTrigger aria-label="Dataset" className="w-72">
                        <SelectValue
                            placeholder={options.length ? "Pick a dataset" : "No datasets yet"}
                        />
                    </SelectTrigger>
                    <SelectContent>
                        {options.map((dataset) => (
                            <SelectItem key={dataset.slug} value={dataset.slug}>
                                {`${dataset.name} · ${count(dataset.rows)} rows`}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {detail.dataset && (
                    <Link
                        href={itemHref({ kind: "dataset", id: detail.dataset })}
                        className="text-sm text-primary hover:underline"
                    >
                        Open dataset
                    </Link>
                )}
            </div>
            <ErrorLine error={choose.error} />
        </Section>
    );
}

export function DataSections({ slug }: { slug: string }) {
    const { data } = useModel(slug);
    const refresh = useRefresh(slug);
    const mapped = Boolean(data?.mapping.sql);
    const preview = usePreview(slug, mapped);
    if (!data) {
        return null;
    }
    const path = { params: { path: { slug } } };
    return (
        <>
            <DatasetPicker detail={data} />
            <SourceSection detail={data} />
            {data.source && (
                <MappingSection
                    columns={data.source.columns.map((column) => column.name)}
                    mapping={data.mapping}
                    onSave={(body) =>
                        unwrap(api.PUT("/api/models/{slug}/mapping", { ...path, body })).then(
                            refresh,
                        )
                    }
                    onRun={(sql) =>
                        unwrap(api.POST("/api/models/{slug}/query", { ...path, body: { sql } }))
                    }
                />
            )}
            {mapped && <PreviewSection data={preview.data} error={preview.error} />}
            <DatasetSection detail={data} />
        </>
    );
}

function ModelData({ slug }: { slug: string }) {
    const models = useModels();
    const model = models.data?.find((item) => item.slug === slug);
    return (
        <Page>
            <PageHeader
                title="Data"
                caption={`The dataset ${model?.name ?? "this model"} trains on, its mapping and its latest version.`}
            />
            <ErrorLine error={models.error} />
            {models.data && !model && (
                <p className="text-sm text-muted-foreground">No custom model called {slug}.</p>
            )}
            {model && <DataSections key={slug} slug={slug} />}
        </Page>
    );
}

export function DataPage() {
    const requested = useSearchParam("model");
    return requested ? <ModelData slug={requested} /> : <DataExplorer />;
}
