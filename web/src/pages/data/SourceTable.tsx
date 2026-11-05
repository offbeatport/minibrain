import { useMutation } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Trash2, X } from "lucide-react";
import {
    Button,
    Checkbox,
    DataGrid,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    Input,
    Label,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import { useEffect, useState } from "react";
import { type DatasetSummary, type SourceSummary, api, succeed, unwrap } from "~/api/client";
import { useDatasets } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { bytes, relativeTime } from "~/lib/time";
import { type ItemRef, itemHref, plural, stem } from "./catalogue";
import { SourceIcon } from "./icons";
import { useDataRefresh } from "./parts";

const INPUT_NAMES = /text|message|input|question|prompt|content|body|utterance|query/i;
const LABEL_NAMES = /label|intent|category|class|target|tag|topic|answer/i;

const COLUMNS: ColumnDef<SourceSummary, unknown>[] = [
    {
        id: "name",
        header: "Name",
        accessorKey: "name",
        cell: ({ row }) => (
            <span className="flex min-w-0 items-center gap-2">
                <SourceIcon source={row.original} className="size-4 shrink-0" />
                <Link href={itemHref({ kind: "source", id: row.original.id })} className="truncate">
                    {row.original.name}
                </Link>
            </span>
        ),
    },
    {
        id: "table",
        header: "Table in SQL",
        accessorKey: "table",
        cell: ({ row }) => <span className="font-mono">{row.original.table}</span>,
    },
    {
        id: "rows",
        header: "Rows",
        accessorFn: (source) => source.rows ?? -1,
        cell: ({ row }) => (
            <span className="tabular-nums">
                {row.original.rows === null ? "–" : count(row.original.rows)}
            </span>
        ),
    },
    {
        id: "size",
        header: "Size",
        accessorKey: "size",
        cell: ({ row }) => <span className="tabular-nums">{bytes(row.original.size)}</span>,
    },
    {
        id: "datasets",
        header: "Datasets",
        accessorFn: (source) => source.datasets.length,
        cell: ({ row }) => (
            <span className="tabular-nums">{count(row.original.datasets.length)}</span>
        ),
    },
    {
        id: "added",
        header: "Added",
        accessorKey: "created_at",
        cell: ({ row }) => relativeTime(row.original.created_at),
    },
];

function quoted(name: string): string {
    return `"${name.replaceAll('"', '""')}"`;
}

export function stackedSql(sources: SourceSummary[], input: string, label: string): string {
    return sources
        .map(
            (source) =>
                `SELECT ${quoted(input)} AS input, ${quoted(label)} AS label FROM ${quoted(source.table)}`,
        )
        .join("\nUNION ALL\n");
}

export function sharedColumns(sources: SourceSummary[]): string[] {
    const [first, ...rest] = sources;
    if (!first) {
        return [];
    }
    return first.columns
        .map((column) => column.name)
        .filter((name) =>
            rest.every((source) => source.columns.some((column) => column.name === name)),
        );
}

function guess(columns: string[], pattern: RegExp, skip?: string): string {
    return (
        columns.find((name) => pattern.test(name) && name !== skip) ??
        columns.find((name) => name !== skip) ??
        ""
    );
}

function defaultName(sources: SourceSummary[]): string {
    const first = sources[0];
    if (!first) {
        return "";
    }
    const base = stem(first.name);
    return sources.length === 1 ? base : `${base} and ${plural(sources.length - 1, "more")}`;
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
                <SelectTrigger id={id} className="w-full">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {columns.map((name) => (
                        <SelectItem key={name} value={name}>
                            <span className="font-mono">{name}</span>
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </Field>
    );
}

function MakeDatasetDialog({
    sources,
    onOpenChange,
    onCreated,
}: {
    sources: SourceSummary[] | null;
    onOpenChange: (open: boolean) => void;
    onCreated: (dataset: DatasetSummary) => Promise<void>;
}) {
    const chosen = sources ?? [];
    const columns = sharedColumns(chosen);
    const opened = sources ? sources.map((source) => source.id).join(",") : null;
    const [name, setName] = useState("");
    const [input, setInput] = useState("");
    const [label, setLabel] = useState("");
    const create = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/datasets", {
                    body: {
                        name: name.trim() || defaultName(chosen) || "New dataset",
                        sql: stackedSql(chosen, input, label),
                    },
                }),
            ),
        onSuccess: async (dataset) => {
            await onCreated(dataset);
            onOpenChange(false);
        },
    });
    const reset = create.reset;
    useEffect(() => {
        if (opened === null) {
            return;
        }
        const picked = sources ?? [];
        const shared = sharedColumns(picked);
        const guessedInput = guess(shared, INPUT_NAMES);
        setName(defaultName(picked));
        setInput(guessedInput);
        setLabel(guess(shared, LABEL_NAMES, guessedInput));
        reset();
    }, [opened, sources, reset]);
    const total = chosen.reduce((sum, source) => sum + (source.rows ?? 0), 0);
    const ready = Boolean(input && label && input !== label);
    return (
        <Dialog open={sources !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{`Make a dataset from ${plural(chosen.length, "source")}`}</DialogTitle>
                    <DialogDescription>
                        Their rows are stacked into one dataset, saved as its version 1. Pick the
                        column that holds the input and the one that holds the label; every source
                        needs both.
                    </DialogDescription>
                </DialogHeader>
                <ul className="flex max-h-48 flex-col divide-y overflow-y-auto rounded-lg border">
                    {chosen.map((source) => (
                        <li key={source.id} className="flex items-center gap-3 px-3 py-2">
                            <SourceIcon source={source} className="size-4 shrink-0" />
                            <span className="min-w-0 flex-1 truncate">{source.name}</span>
                            <span className="text-sm text-muted-foreground tabular-nums">
                                {source.rows === null ? "–" : plural(source.rows, "row")}
                            </span>
                        </li>
                    ))}
                </ul>
                {columns.length < 2 ? (
                    <StatusText tone="warning" className="whitespace-normal">
                        {chosen.length > 1
                            ? "These sources share fewer than two column names, so there is no input and label pair in all of them. Pick sources with the same columns, or write SQL on the Datasets page."
                            : "This source has fewer than two columns."}
                    </StatusText>
                ) : (
                    <div className="flex flex-col gap-field">
                        <Field id="stack-name" label="Name">
                            <Input
                                id="stack-name"
                                value={name}
                                maxLength={80}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </Field>
                        <div className="grid gap-field sm:grid-cols-2">
                            <ColumnSelect
                                id="stack-input"
                                label="Input column"
                                value={input}
                                columns={columns}
                                onChange={setInput}
                            />
                            <ColumnSelect
                                id="stack-label"
                                label="Label column"
                                value={label}
                                columns={columns}
                                onChange={setLabel}
                            />
                        </div>
                        <span className="text-sm text-muted-foreground tabular-nums">
                            {`About ${plural(total, "row")} before empty and repeated inputs are dropped.`}
                        </span>
                    </div>
                )}
                {input && input === label && (
                    <StatusText tone="warning">Pick different input and label columns.</StatusText>
                )}
                <ErrorLine error={create.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        disabled={!ready || columns.length < 2 || create.isPending}
                        onClick={() => create.mutate()}
                    >
                        {create.isPending ? "Making…" : "Make dataset"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function DeleteSourcesDialog({
    sources,
    onOpenChange,
    onDeleted,
}: {
    sources: SourceSummary[] | null;
    onOpenChange: (open: boolean) => void;
    onDeleted: () => void;
}) {
    const refresh = useDataRefresh();
    const datasets = useDatasets();
    const [cascade, setCascade] = useState(false);
    const opened = sources ? sources.map((source) => source.id).join(",") : null;
    useEffect(() => {
        if (opened !== null) {
            setCascade(false);
        }
    }, [opened]);
    const chosen = sources ?? [];
    const readers = [...new Set(chosen.flatMap((source) => source.datasets))];
    const nameOf = (slug: string) =>
        datasets.data?.find((dataset) => dataset.slug === slug)?.name ?? slug;
    const deletable = cascade ? chosen : chosen.filter((source) => source.datasets.length === 0);
    const remove = useMutation({
        mutationFn: async () => {
            if (cascade) {
                for (const slug of readers) {
                    await succeed(
                        api.DELETE("/api/datasets/{slug}", { params: { path: { slug } } }),
                    );
                }
            }
            for (const source of deletable) {
                await succeed(
                    api.DELETE("/api/sources/{source_id}", {
                        params: { path: { source_id: source.id } },
                    }),
                );
            }
        },
        onSuccess: () => {
            onDeleted();
            onOpenChange(false);
        },
        onSettled: refresh,
    });
    const what = [
        plural(deletable.length, "source"),
        cascade && readers.length > 0 ? plural(readers.length, "dataset") : "",
    ]
        .filter(Boolean)
        .join(" and ");
    return (
        <Dialog open={sources !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{`Delete ${plural(chosen.length, "source")}?`}</DialogTitle>
                    <DialogDescription>
                        Uploaded files are removed from storage; folders, buckets and tables outside
                        minibrain are left as they are. This cannot be undone.
                    </DialogDescription>
                </DialogHeader>
                <ul className="flex max-h-56 flex-col divide-y overflow-y-auto rounded-lg border">
                    {chosen.map((source) => (
                        <li key={source.id} className="flex items-center gap-3 px-3 py-2.5">
                            <span
                                aria-hidden="true"
                                className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background"
                            >
                                <SourceIcon source={source} className="size-4" />
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate font-medium">{source.name}</span>
                                <span className="truncate text-sm text-muted-foreground">
                                    {source.datasets.length > 0
                                        ? `Read by ${source.datasets.map(nameOf).join(", ")}`
                                        : bytes(source.size)}
                                </span>
                            </span>
                            {source.datasets.length > 0 && !cascade && (
                                <StatusText tone="warning">In use</StatusText>
                            )}
                        </li>
                    ))}
                </ul>
                {readers.length > 0 && (
                    <div className="flex flex-col gap-3 rounded-lg border p-3">
                        <Label className="flex items-start gap-2 font-normal">
                            <Checkbox
                                checked={cascade}
                                onCheckedChange={(value) => setCascade(value === true)}
                                className="mt-0.5"
                            />
                            <span className="flex flex-col gap-0.5">
                                <span className="font-medium">
                                    {`Also delete the ${plural(readers.length, "dataset")} that ${readers.length === 1 ? "reads" : "read"} them`}
                                </span>
                                <span className="text-sm text-muted-foreground">
                                    A source can't go while a dataset reads it. Models trained on
                                    those datasets keep their versions.
                                </span>
                            </span>
                        </Label>
                        <ul className="flex flex-col divide-y rounded-md border text-sm">
                            {readers.map((slug) => (
                                <li key={slug} className="truncate px-3 py-2">
                                    {nameOf(slug)}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                <ErrorLine error={remove.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        disabled={deletable.length === 0 || remove.isPending}
                        onClick={() => remove.mutate()}
                    >
                        {remove.isPending
                            ? "Deleting…"
                            : deletable.length === 0
                              ? "Delete"
                              : `Delete ${what}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export function SourceTable({
    sources,
    onSelect,
    onCreated,
}: {
    sources: SourceSummary[];
    onSelect: (item: ItemRef) => void;
    onCreated: (dataset: DatasetSummary) => Promise<void>;
}) {
    const [selected, setSelected] = useState<string[]>([]);
    const [making, setMaking] = useState<SourceSummary[] | null>(null);
    const [deleting, setDeleting] = useState<SourceSummary[] | null>(null);
    const chosen = sources.filter((source) => selected.includes(String(source.id)));
    const clear = () => setSelected([]);
    return (
        <div className="flex flex-col gap-3">
            {chosen.length > 0 && (
                <div className="flex min-h-8 flex-wrap items-center gap-2">
                    <span className="text-sm font-medium tabular-nums">{`${chosen.length} selected`}</span>
                    <Button variant="outline" size="sm" onClick={clear}>
                        <X />
                        Clear selection
                    </Button>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                        <Button size="sm" onClick={() => setMaking(chosen)}>
                            Make a dataset
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => setDeleting(chosen)}>
                            <Trash2 />
                            Delete
                        </Button>
                    </div>
                </div>
            )}
            <DataGrid
                columns={COLUMNS}
                rows={sources}
                getRowId={(row) => String(row.id)}
                onOpen={(row) => onSelect({ kind: "source", id: row.id })}
                rowLabel={(row) => row.name}
                selectedIds={selected}
                onSelectedIdsChange={setSelected}
            />
            <MakeDatasetDialog
                sources={making}
                onOpenChange={(open) => !open && setMaking(null)}
                onCreated={async (dataset) => {
                    clear();
                    await onCreated(dataset);
                }}
            />
            <DeleteSourcesDialog
                sources={deleting}
                onOpenChange={(open) => !open && setDeleting(null)}
                onDeleted={clear}
            />
        </div>
    );
}
