import { useMutation } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
    Button,
    DataGrid,
    Field,
    SegmentedTabs,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
} from "obp-ui";
import { ChatBubble } from "obp-ui/chat";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type {
    DatasetSummary,
    MappingInfo,
    PreviewResponse,
    QueryResponse,
    SourceSummary,
} from "~/api/client";
import { ErrorLine, Section, Stat } from "~/components/Section";
import { asCode, count } from "~/lib/format";

export type MappingBody = {
    source_id?: number;
    input_column?: string;
    label_column?: string;
    sql?: string;
};

type Mode = "columns" | "sql";

const MODES = [
    { key: "columns", label: "Columns" },
    { key: "sql", label: "SQL" },
];

type Row = { input: string | null; label: string | null };

function Clamp({ text }: { text: unknown }) {
    return (
        <span className="line-clamp-2 max-w-xl whitespace-normal">
            {text === null || text === undefined || text === "" ? "–" : String(text)}
        </span>
    );
}

const PREVIEW_COLUMNS: ColumnDef<Row, unknown>[] = [
    { header: "Input", accessorKey: "input", cell: (info) => <Clamp text={info.getValue()} /> },
    {
        header: "Label",
        accessorKey: "label",
        cell: (info) => <span className="font-mono">{String(info.getValue() ?? "–")}</span>,
    },
];

export function QueryResult({ result }: { result: QueryResponse }) {
    const columns: ColumnDef<(string | null)[], unknown>[] = result.columns.map((name, index) => ({
        id: `${index}:${name}`,
        header: () => <span className="font-mono">{name}</span>,
        accessorFn: (row) => row[index] ?? "",
        cell: (info) => <Clamp text={info.getValue()} />,
    }));
    return (
        <DataGrid
            columns={columns}
            rows={result.rows}
            maxHeight="360px"
            minWidth={result.columns.length > 4 ? "min-w-[960px]" : undefined}
            empty="The query returned no rows."
        />
    );
}

function ColumnSelect({
    id,
    label,
    value,
    options,
    placeholder,
    onChange,
    disabled,
}: {
    id: string;
    label: string;
    value: string;
    options: { value: string; label: string; description?: string }[];
    placeholder: string;
    onChange: (value: string) => void;
    disabled?: boolean;
}) {
    return (
        <Field id={id} label={label}>
            <Select
                value={value}
                onValueChange={(next) => onChange(String(next ?? ""))}
                disabled={disabled}
            >
                <SelectTrigger id={id} className="w-56 max-w-full">
                    <SelectValue placeholder={placeholder} />
                </SelectTrigger>
                <SelectContent>
                    {options.map((option) => (
                        <SelectItem
                            key={option.value}
                            value={option.value}
                            description={option.description}
                        >
                            {option.label}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </Field>
    );
}

function TableList({
    sources,
    onInsert,
}: {
    sources: SourceSummary[];
    onInsert: (name: string) => void;
}) {
    return (
        <div className="flex min-w-0 flex-col rounded-lg border">
            <div className="border-b px-3 py-1.5 text-sm text-muted-foreground">
                Tables: click one to insert its name
            </div>
            {sources.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">No sources yet.</p>
            ) : (
                <ul className="max-h-64 divide-y overflow-y-auto">
                    {[...sources]
                        .sort((left, right) => left.table.localeCompare(right.table))
                        .map((source) => (
                            <li key={source.id}>
                                <button
                                    type="button"
                                    onClick={() => onInsert(source.table)}
                                    className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <span className="font-mono text-sm">{source.table}</span>
                                    <span className="w-full truncate text-sm text-muted-foreground">
                                        {source.columns.map((column) => column.name).join(", ")}
                                    </span>
                                </button>
                            </li>
                        ))}
                </ul>
            )}
        </div>
    );
}

function primarySource(
    mapping: MappingInfo,
    sourceId: number | null | undefined,
    sources: SourceSummary[],
): string {
    if (sourceId !== null && sourceId !== undefined) {
        return String(sourceId);
    }
    return mapping.sql ? "" : String(sources[0]?.id ?? "");
}

export function QueryEditor({
    mapping,
    mode: savedMode,
    sourceId,
    sources,
    onSave,
    onRun,
    title = "Query",
    saveLabel,
    before,
    extraActions,
}: {
    mapping: MappingInfo;
    mode: DatasetSummary["mode"];
    sourceId: number | null | undefined;
    sources: SourceSummary[];
    onSave: (body: MappingBody) => Promise<unknown>;
    onRun: (sql: string) => Promise<QueryResponse>;
    title?: string;
    saveLabel?: string;
    before?: ReactNode;
    extraActions?: ReactNode;
}) {
    const [mode, setMode] = useState<Mode>(savedMode);
    const [source, setSource] = useState(primarySource(mapping, sourceId, sources));
    const [input, setInput] = useState(mapping.input_column ?? "");
    const [label, setLabel] = useState(mapping.label_column ?? "");
    const [sql, setSql] = useState(mapping.sql ?? "");
    const editor = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        setMode(savedMode);
        setInput(mapping.input_column ?? "");
        setLabel(mapping.label_column ?? "");
        setSql(mapping.sql ?? "");
    }, [mapping, savedMode]);
    useEffect(() => {
        if (sourceId !== null && sourceId !== undefined) {
            setSource(String(sourceId));
        }
    }, [sourceId]);
    const save = useMutation({ mutationFn: onSave });
    const run = useMutation({ mutationFn: onRun });
    const chosen = sources.find((item) => String(item.id) === source);
    const columns = (chosen?.columns ?? []).map((column) => ({
        value: column.name,
        label: column.name,
        description: column.type.toLowerCase(),
    }));
    const insert = (name: string) => {
        const area = editor.current;
        const start = area?.selectionStart ?? sql.length;
        const end = area?.selectionEnd ?? sql.length;
        const next = `${sql.slice(0, start)}${name}${sql.slice(end)}`;
        setSql(next);
        requestAnimationFrame(() => {
            area?.focus();
            area?.setSelectionRange(start + name.length, start + name.length);
        });
    };
    const switchMode = (next: string) => {
        if (next === "sql" && !sql && chosen && input && label) {
            setSql(
                `SELECT CAST("${input}" AS VARCHAR) AS input, CAST("${label}" AS VARCHAR) AS label FROM ${chosen.table}`,
            );
        }
        setMode(next as Mode);
    };
    return (
        <Section
            title={title}
            caption="Pick a source and the columns a model reads and answers with, or write SQL over one or more sources."
            actions={
                <>
                    <SegmentedTabs tabs={MODES} active={mode} onSelect={switchMode} />
                    {extraActions}
                </>
            }
        >
            {before}
            {mode === "sql" ? (
                <div className="@container flex flex-col gap-3">
                    <div className="grid gap-3 @2xl:grid-cols-[minmax(0,1fr)_16rem]">
                        <Textarea
                            ref={editor}
                            value={sql}
                            onChange={(event) => setSql(event.target.value)}
                            rows={9}
                            spellCheck={false}
                            className="min-h-48 font-mono"
                            aria-label="SQL"
                            placeholder="SELECT text AS input, category AS label FROM tickets WHERE category IS NOT NULL"
                        />
                        <TableList sources={sources} onInsert={insert} />
                    </div>
                    <p className="text-sm text-muted-foreground">
                        Return columns named <span className="font-mono">input</span> and{" "}
                        <span className="font-mono">label</span>; other columns are kept in
                        snapshots. Join, union, filter and clean up with DuckDB SQL. Queries are
                        read-only and cannot reach other files or the network.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            variant="outline"
                            onClick={() => run.mutate(sql)}
                            disabled={!sql.trim() || run.isPending}
                        >
                            {run.isPending ? "Running…" : "Run"}
                        </Button>
                        <Button
                            onClick={() => save.mutate({ sql })}
                            disabled={!sql.trim() || save.isPending}
                        >
                            {saveLabel ?? "Save query"}
                        </Button>
                    </div>
                    <ErrorLine error={run.error ?? save.error} />
                    {run.data && !run.error && <QueryResult result={run.data} />}
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-end gap-3">
                        <ColumnSelect
                            id="dataset-source"
                            label="Source"
                            value={source}
                            placeholder="Pick a source"
                            options={sources.map((item) => ({
                                value: String(item.id),
                                label: item.name,
                                description: item.table,
                            }))}
                            onChange={(next) => {
                                setSource(next);
                                setInput("");
                                setLabel("");
                            }}
                        />
                        <ColumnSelect
                            id="dataset-input"
                            label="Input"
                            value={input}
                            placeholder="Pick a column"
                            options={columns}
                            onChange={setInput}
                            disabled={!chosen}
                        />
                        <ColumnSelect
                            id="dataset-label"
                            label="Label"
                            value={label}
                            placeholder="Pick a column"
                            options={columns}
                            onChange={setLabel}
                            disabled={!chosen}
                        />
                        <Button
                            disabled={!chosen || !input || !label || save.isPending}
                            onClick={() =>
                                save.mutate({
                                    source_id: chosen?.id,
                                    input_column: input,
                                    label_column: label,
                                })
                            }
                        >
                            {saveLabel ?? "Save columns"}
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
    loading,
}: {
    data: PreviewResponse | undefined;
    error: unknown;
    loading: boolean;
}) {
    const quality = data?.quality;
    return (
        <Section
            title="Preview"
            caption="The first 20 rows as a model sees them, from a live run of the query, and checks over every row."
            flush
        >
            <ErrorLine error={error} />
            {quality && (
                <div className="flex flex-wrap gap-x-8 gap-y-3 border-b px-5 py-4">
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
            <DataGrid
                columns={PREVIEW_COLUMNS}
                rows={data?.rows ?? []}
                loading={loading}
                loadingRows={6}
                maxHeight="420px"
                empty="The query returned no rows."
            />
            {data && data.example.length > 0 && (
                <div className="flex max-w-2xl flex-col gap-2 border-t px-5 py-4">
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
            )}
        </Section>
    );
}
