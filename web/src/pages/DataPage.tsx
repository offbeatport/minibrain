import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
    Button,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
} from "obp-ui";
import { ChatBubble } from "obp-ui/chat";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import {
    type ExampleInfo,
    type MinibrainDetail,
    type QueryResponse,
    api,
    unwrap,
    uploadSource,
} from "~/api/client";
import { isActiveJob, keys, useGolden, useJobs, useMinibrain, usePreview } from "~/api/queries";
import { DataTable } from "~/components/DataTable";
import { JobPanel } from "~/components/JobPanel";
import { ScopedPage } from "~/components/PageHeader";
import { ErrorLine, Section, Stat } from "~/components/Section";
import { asCode, count, dateTime } from "~/lib/format";

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
        async (detail?: MinibrainDetail) => {
            if (detail) {
                queryClient.setQueryData(keys.minibrain(slug), detail);
            }
            await queryClient.invalidateQueries({ queryKey: ["minibrain", slug] });
            await queryClient.invalidateQueries({ queryKey: keys.minibrains });
        },
        [queryClient, slug],
    );
}

function SourceSection({ detail }: { detail: MinibrainDetail }) {
    const refresh = useRefresh(detail.slug);
    const upload = useMutation({
        mutationFn: (file: File) => uploadSource(detail.slug, file),
        onSuccess: refresh,
    });
    const choose = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            upload.mutate(file);
        }
        event.target.value = "";
    };
    const source = detail.source;
    return (
        <Section
            title="Source"
            caption="A CSV, TSV, JSON Lines or Parquet file. It is copied into this install."
            actions={
                <Button asChild variant={source ? "outline" : "default"} size="sm">
                    <label className="cursor-pointer">
                        {upload.isPending ? "Uploading…" : source ? "Replace file" : "Upload file"}
                        <input
                            type="file"
                            className="sr-only"
                            accept=".csv,.tsv,.json,.jsonl,.ndjson,.parquet"
                            onChange={choose}
                            disabled={upload.isPending}
                        />
                    </label>
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
            <ErrorLine error={upload.error} />
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
        <div className="flex flex-col gap-1">
            <Label htmlFor={id}>{label}</Label>
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
        </div>
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
        <DataTable
            columns={columns}
            rows={result.rows.map((row) => row.map((cell) => cell ?? ""))}
        />
    );
}

function MappingSection({ detail }: { detail: MinibrainDetail }) {
    const refresh = useRefresh(detail.slug);
    const columns = detail.source?.columns.map((column) => column.name) ?? [];
    const [input, setInput] = useState(detail.mapping.input_column ?? "");
    const [label, setLabel] = useState(detail.mapping.label_column ?? "");
    const [sql, setSql] = useState(detail.mapping.sql ?? "");
    const [editing, setEditing] = useState(false);
    useEffect(() => {
        setInput(detail.mapping.input_column ?? "");
        setLabel(detail.mapping.label_column ?? "");
        setSql(detail.mapping.sql ?? "");
    }, [detail.mapping]);
    const path = { params: { path: { slug: detail.slug } } };
    const save = useMutation({
        mutationFn: (body: { input_column?: string; label_column?: string; sql?: string }) =>
            unwrap(api.PUT("/api/minibrains/{slug}/mapping", { ...path, body })),
        onSuccess: refresh,
    });
    const run = useMutation({
        mutationFn: (statement: string) =>
            unwrap(api.POST("/api/minibrains/{slug}/query", { ...path, body: { sql: statement } })),
    });
    if (!detail.source) {
        return null;
    }
    return (
        <Section
            title="Mapping"
            caption="Pick the column the model reads and the column it should answer with, or write SQL over the table source."
            actions={
                <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)}>
                    {editing ? "Use columns" : "Edit SQL"}
                </Button>
            }
        >
            {editing ? (
                <div className="flex flex-col gap-2">
                    <Textarea
                        value={sql}
                        onChange={(event) => setSql(event.target.value)}
                        rows={6}
                        spellCheck={false}
                        className="font-mono"
                        aria-label="SQL"
                    />
                    <p className="text-sm text-muted-foreground">
                        Return two columns named <span className="font-mono">input</span> and{" "}
                        <span className="font-mono">label</span>. Queries are read-only and cannot
                        reach files or the network.
                    </p>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => run.mutate(sql)}>
                            Run
                        </Button>
                        <Button size="sm" onClick={() => save.mutate({ sql })}>
                            Save SQL
                        </Button>
                    </div>
                    <ErrorLine error={run.error ?? save.error} />
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
                            Save mapping
                        </Button>
                    </div>
                    <ErrorLine error={save.error} />
                </div>
            )}
        </Section>
    );
}

function PreviewSection({ detail }: { detail: MinibrainDetail }) {
    const { data, error } = usePreview(detail.slug, Boolean(detail.mapping.sql));
    if (!detail.mapping.sql) {
        return null;
    }
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
                    <DataTable columns={ROW_COLUMNS} rows={data.rows} />
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

function DatasetSection({ detail }: { detail: MinibrainDetail }) {
    const refresh = useRefresh(detail.slug);
    const { data: jobs } = useJobs(detail.slug);
    const latest = (jobs ?? []).find((job) => job.kind === "prepare");
    const building = latest !== undefined && isActiveJob(latest);
    const build = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/minibrains/{slug}/snapshots", {
                    params: { path: { slug: detail.slug } },
                }),
            ),
        onSuccess: () => refresh(),
    });
    const finishedId = latest?.status === "succeeded" ? latest.id : null;
    useEffect(() => {
        if (finishedId !== null) {
            refresh();
        }
    }, [finishedId, refresh]);
    const golden = useGolden(detail.slug, Boolean(detail.snapshot));
    const [showGolden, setShowGolden] = useState(false);
    if (!detail.mapping.sql) {
        return null;
    }
    const snapshot = detail.snapshot;
    return (
        <Section
            title="Dataset"
            caption="A frozen copy of the cleaned rows, split into a test set, a held-out set, few-shot examples and training rows."
            actions={
                <Button
                    size="sm"
                    onClick={() => build.mutate()}
                    disabled={build.isPending || building}
                >
                    {build.isPending || building
                        ? "Building…"
                        : snapshot
                          ? "Rebuild"
                          : "Build dataset"}
                </Button>
            }
        >
            <ErrorLine error={build.error} />
            {latest && latest.status !== "succeeded" && (
                <JobPanel job={latest} slug={detail.slug} />
            )}
            {snapshot ? (
                <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-6">
                        <Stat label="Test set" value={count(snapshot.counts.golden)} />
                        <Stat label="Held-out" value={count(snapshot.counts.eval)} />
                        <Stat label="Few-shot" value={count(snapshot.counts.shots)} />
                        <Stat label="Training" value={count(snapshot.counts.train)} />
                        <Stat label="Labels" value={count(snapshot.labels.length)} />
                        <Stat
                            label="Snapshot"
                            value={<span className="font-mono">{snapshot.hash.slice(0, 12)}</span>}
                        />
                    </div>
                    <p className="text-sm text-muted-foreground">
                        Built {dateTime(snapshot.created_at)}
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
                    {showGolden && <DataTable columns={GOLDEN_COLUMNS} rows={golden.data ?? []} />}
                </div>
            ) : (
                <p className="text-sm text-muted-foreground">
                    Build the dataset before scoring or training.
                </p>
            )}
        </Section>
    );
}

function DataSections({ slug }: { slug: string }) {
    const { data } = useMinibrain(slug);
    if (!data) {
        return null;
    }
    return (
        <>
            <SourceSection detail={data} />
            <MappingSection detail={data} />
            <PreviewSection detail={data} />
            <DatasetSection detail={data} />
        </>
    );
}

export function DataPage() {
    return (
        <ScopedPage title="Data" caption="Upload a file, map its columns and build the dataset.">
            {(slug) => <DataSections key={slug} slug={slug} />}
        </ScopedPage>
    );
}
