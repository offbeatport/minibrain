import { useRouter } from "@tanstack/react-router";
import { Button, SearchInput, cn, useToast } from "obp-ui";
import { type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from "react";
import type { ModelRow, ModelVersionRow } from "~/api/client";
import { useAllModels } from "~/api/queries";
import { ErrorLine } from "~/components/Section";
import type { HealthAction } from "~/components/models/HealthStatus";
import { useCan } from "~/lib/access";
import { type ModelsSearch, useModelsSearch } from "~/lib/modelsSearch";
import { retryTeardown } from "~/lib/teardown";
import { DeleteModelsDialog } from "../DeleteModelsDialog";
import { DuplicateModelDialog } from "../DuplicateModelDialog";
import { ModelsEmpty } from "../ModelsEmpty";
import { SwitchBaseDialog } from "../SwitchBaseDialog";
import {
    ConfirmAction,
    type Confirmation,
    EditModelDialog,
    cancelJob,
    useModelsRefresh,
} from "../dialogs";
import type { Entry } from "../entries";
import { useHealthActions } from "../healthActions";
import { QuickLook } from "./QuickLook";
import { FilterChips, ViewOptions } from "./ViewOptions";
import { deleteEntries, deployRows, promoteVersion, retryDownload } from "./actions";
import {
    COLUMNS,
    type Column,
    DEFAULT_COLUMNS,
    DEFAULT_SORT,
    type Filters,
    type KindKey,
    NO_FILTERS,
    activeCount,
    filterSearch,
    gridTemplate,
    passes,
    readFilters,
    readSort,
    sortModels,
} from "./filters";
import {
    type ListModel,
    attention,
    childCount,
    childHits,
    listModels,
    matchesText,
    plural,
    shownVersions,
    variantKey,
    variantMatches,
    versionKey,
    versionMatches,
} from "./model";
import {
    type Handlers,
    ModelLine,
    MoreLine,
    ROW_GRID,
    type RowProps,
    VariantLine,
    VersionLine,
} from "./rows";
import { CompareDialog, SelectionBar, pickedVariants, pickedVersions } from "./selection";

type Line =
    | { key: string; type: "model"; model: ListModel; expanded: boolean }
    | { key: string; type: "version"; model: ListModel; version: ModelVersionRow }
    | { key: string; type: "variant"; model: ListModel; row: ModelRow }
    | { key: string; type: "more"; model: ListModel; shown: number; searching: boolean };
type RowLine = Extract<Line, { type: "model" | "version" | "variant" }>;
type Group = { kind: KindKey; label: string; count: number; lines: Line[] };

const GROUPS: { kind: KindKey; label: string }[] = [
    { kind: "custom", label: "Your models" },
    { kind: "base", label: "Base models" },
];

const EXPANDED_KEY = "minibrain.models.expanded";
const COLUMNS_KEY = "minibrain.models.columns.shown.v2";
const NESTED_KEY = "minibrain.models.showVersions";

function readStored<T>(key: string, fallback: T): T {
    try {
        const raw = window.localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
}

function writeStored(key: string, value: unknown) {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
        return;
    }
}

function useStored<T>(key: string, fallback: T) {
    const [value, setValue] = useState<T>(() => readStored(key, fallback));
    const save = (next: T) => {
        setValue(next);
        writeStored(key, next);
    };
    return [value, save] as const;
}

function sameColumns(a: Column[], b: Column[]): boolean {
    return a.length === b.length && a.every((id) => b.includes(id));
}

function lineId(key: string): string {
    return `models-line-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function childLines(model: ListModel, text: string): Line[] {
    if (model.kind === "base") {
        const hits = text ? model.variants.filter((row) => variantMatches(row, text)) : [];
        return (hits.length > 0 ? hits : model.variants).map((row) => ({
            key: variantKey(row),
            type: "variant" as const,
            model,
            row,
        }));
    }
    const hits = text ? model.versions.filter((version) => versionMatches(version, text)) : [];
    const searching = hits.length > 0;
    const shown = searching ? hits : shownVersions(model);
    const lines: Line[] = shown.map((version) => ({
        key: versionKey(model.key, version.number),
        type: "version",
        model,
        version,
    }));
    if (shown.length < model.versions.length) {
        lines.push({
            key: `${model.key}:more`,
            type: "more",
            model,
            shown: shown.length,
            searching,
        });
    }
    return lines;
}

function defaultExpanded(model: ListModel): boolean {
    if (model.kind === "base") {
        return model.variants.some((row) => row.update_available);
    }
    return attention(model);
}

function buildLines(
    models: ListModel[],
    text: string,
    stored: Record<string, boolean>,
    searchToggles: Record<string, boolean>,
    nested: boolean,
): Line[] {
    return models.flatMap((model): Line[] => {
        const searching = childHits(model, text) > 0;
        const expanded =
            nested &&
            childCount(model) > 0 &&
            (searching
                ? (searchToggles[model.id] ?? true)
                : (stored[model.id] ?? defaultExpanded(model)));
        const row: Line = { key: model.id, type: "model", model, expanded };
        return expanded ? [row, ...childLines(model, searching ? text : "")] : [row];
    });
}

function GroupBand({ group }: { group: Group }) {
    return (
        <h2
            id={`models-group-${group.kind}`}
            className="sticky top-9 z-[12] col-span-full -mt-px flex h-8 min-w-0 items-center gap-1.5 border-y bg-card px-4 text-sm text-muted-foreground"
        >
            <span className="font-medium">{group.label}</span>
            <span className="font-normal text-faint tabular-nums">{group.count}</span>
        </h2>
    );
}

function Toolbar({ search, chips }: { search: ReactNode; chips: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
            {search}
            {chips}
        </div>
    );
}

export function ModelsList() {
    const router = useRouter();
    const toast = useToast();
    const can = useCan();
    const refresh = useModelsRefresh();
    const all = useAllModels();
    const { search, update } = useModelsSearch("/models");
    const rows = all.data ?? [];
    const models = useMemo(() => listModels(rows), [rows]);
    const [expanded, setExpanded] = useStored<Record<string, boolean>>(EXPANDED_KEY, {});
    const [nested, setNested] = useStored<boolean>(NESTED_KEY, false);
    const [columns, setColumns] = useStored<Column[]>(COLUMNS_KEY, DEFAULT_COLUMNS);
    const [searchToggles, setSearchToggles] = useState<Record<string, boolean>>({});
    const [selection, setSelection] = useState<string[]>([]);
    const [focusKey, setFocusKey] = useState<string | null>(null);
    const [peek, setPeek] = useState<string | null>(null);
    const [compared, setCompared] = useState<{
        model: ListModel;
        numbers: [number, number];
    } | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [deleting, setDeleting] = useState<Entry[] | null>(null);
    const [editing, setEditing] = useState<ModelRow | null>(null);
    const [duplicating, setDuplicating] = useState<ModelRow | null>(null);
    const [switching, setSwitching] = useState<{ row: ModelRow; preferred: string | null } | null>(
        null,
    );
    const healthRun = useRef<Handlers["health"] | null>(null);
    const filters = readFilters(search);
    const sort = readSort(search);
    const shownColumns = COLUMNS.map((column) => column.id).filter((id) => columns.includes(id));
    const text = (search.q ?? "").trim().toLowerCase();
    const setFilters = (next: Filters) => update(filterSearch(next));
    const pool = useMemo(() => models.filter((model) => matchesText(model, text)), [models, text]);
    const groups = GROUPS.map((group): Group => {
        const members = sortModels(
            pool.filter((model) => model.kind === group.kind && passes(model, filters)),
            sort,
        );
        return {
            ...group,
            count: members.length,
            lines: buildLines(members, text, expanded, searchToggles, nested),
        };
    }).filter((group) => group.count > 0);
    const lines = groups.flatMap((group) => group.lines);
    const rowLines = lines.filter((line): line is RowLine => line.type !== "more");
    const activeKey = rowLines.some((line) => line.key === focusKey) ? focusKey : rowLines[0]?.key;
    const visible = new Set(rowLines.map((line) => line.key));
    const picked = selection.filter((key) => visible.has(key));
    const versions = pickedVersions(models, picked);
    const variants = pickedVariants(models, picked);
    const clear = () => setSelection([]);
    const peekModel = models.find((model) => model.id === peek) ?? null;
    const done = async () => {
        clear();
        await refresh();
    };
    const confirm = (step: Confirmation) =>
        setConfirmation({
            ...step,
            run: async () => {
                await step.run();
                await done();
            },
        });
    const on: Handlers = {
        open: (href) => router.history.push(href),
        peek: (model) => {
            setPeek(model.id);
            focusLine(model.id);
        },
        makeLive: (model, version) => {
            const live = model.versions.find((item) => item.live);
            const notes = [
                `Requests to ${model.key} are answered by v${version.number} from now on.`,
                live
                    ? `v${live.number} stays callable as ${model.key}@${live.number}, and you can deploy it again at any time.`
                    : `${model.name} is not deployed yet: this deploys it.`,
            ];
            confirm({
                title: `Deploy v${version.number} of ${model.name}?`,
                description: <p>{notes.join(" ")}</p>,
                confirmLabel: `Deploy v${version.number}`,
                run: async () => {
                    await promoteVersion(model.key, version.number);
                    toast({
                        title: `v${version.number} of ${model.name} is deployed`,
                        tone: "success",
                    });
                },
            });
        },
        compare: (model, numbers) => setCompared({ model, numbers }),
        edit: setEditing,
        duplicate: setDuplicating,
        switchBase: (row, preferred) => setSwitching({ row, preferred }),
        createFrom: (row) => router.history.push(`/models/new?base=${encodeURIComponent(row.key)}`),
        deploy: (chosen) =>
            confirm({
                title:
                    chosen.length === 1
                        ? `Deploy ${chosen[0].name}?`
                        : `Deploy ${plural(chosen.length, "variant")}?`,
                description: (
                    <p>
                        {`${chosen.map((row) => row.key).join(", ")} ${chosen.length === 1 ? "becomes" : "become"} callable on the OpenAI-compatible API with ${chosen.length === 1 ? "its" : "their"} own keys.`}
                    </p>
                ),
                confirmLabel: "Deploy",
                run: () => deployRows(chosen, true),
            }),
        undeploy: (chosen) =>
            confirm({
                title:
                    chosen.length === 1
                        ? `Undeploy ${chosen[0].name}?`
                        : `Undeploy ${plural(chosen.length, "variant")}?`,
                description: (
                    <p>
                        {`Requests to ${chosen.map((row) => row.key).join(", ")} stop being answered; versions, keys and files stay.`}
                    </p>
                ),
                confirmLabel: "Undeploy",
                destructive: true,
                run: () => deployRows(chosen, false),
            }),
        remove: setDeleting,
        health: (row, action) => healthRun.current?.(row, action),
        retryTeardown: (row) => {
            retryTeardown(row).then(refresh);
        },
        retryDownload: (row) => {
            retryDownload(row).then(refresh);
        },
        cancelTransfer: (row) =>
            confirm({
                title: `Cancel ${row.activity.label.toLowerCase()}?`,
                description: <p>Files already validated are kept, so a retry resumes.</p>,
                confirmLabel: "Cancel transfer",
                destructive: true,
                run: () => cancelJob(row.activity.job_id ?? 0),
            }),
    };
    const health = useHealthActions({
        refresh,
        confirm: setConfirmation,
        remove: (row) =>
            setDeleting([{ key: `${row.kind}:${row.key}`, model: row, version: null }]),
    });
    healthRun.current = health.run as (row: ModelRow, action: HealthAction) => void;
    const select = (key: string, value: boolean) =>
        setSelection(value ? [...new Set([...picked, key])] : picked.filter((k) => k !== key));
    const toggle = (line: Extract<Line, { type: "model" }>) => {
        const next = !line.expanded;
        if (!next) {
            const children = new Set(childLines(line.model, "").map((child) => child.key));
            setSelection(picked.filter((key) => !children.has(key)));
        }
        if (childHits(line.model, text) > 0) {
            setSearchToggles({ ...searchToggles, [line.model.id]: next });
        } else {
            setExpanded({ ...expanded, [line.model.id]: next });
        }
    };
    function focusLine(key: string | undefined) {
        if (!key) {
            return;
        }
        setFocusKey(key);
        requestAnimationFrame(() => document.getElementById(lineId(key))?.focus());
    }
    const hrefOfLine = (line: RowLine) => {
        if (line.type === "version") {
            return `/models/${encodeURIComponent(line.model.key)}/versions`;
        }
        if (line.type === "variant") {
            return `/models/${encodeURIComponent(line.row.key)}`;
        }
        return `/models/${encodeURIComponent(line.model.row.key)}`;
    };
    const selectable = (line: RowLine) =>
        line.type === "version" || (line.type === "variant" && can.build);
    const onKey = (line: RowLine) => (event: KeyboardEvent<HTMLLIElement>) => {
        if (event.target !== event.currentTarget) {
            return;
        }
        const index = rowLines.findIndex((row) => row.key === line.key);
        const keys: Record<string, () => void> = {
            ArrowDown: () => focusLine(rowLines[index + 1]?.key),
            ArrowUp: () => focusLine(rowLines[index - 1]?.key),
            Home: () => focusLine(rowLines[0]?.key),
            End: () => focusLine(rowLines.at(-1)?.key),
            Enter: () => on.open(hrefOfLine(line)),
            Escape: () => setPeek(null),
            " ": () => {
                if (line.type === "model") {
                    setPeek(peek === line.model.id ? null : line.model.id);
                } else if (selectable(line)) {
                    select(line.key, !picked.includes(line.key));
                }
            },
            ArrowRight: () => {
                if (line.type !== "model") {
                    return;
                }
                if (line.expanded) {
                    focusLine(rowLines[index + 1]?.key);
                } else if (nested && childCount(line.model) > 0) {
                    toggle(line);
                }
            },
            ArrowLeft: () => {
                if (line.type === "model" && line.expanded) {
                    toggle(line);
                } else if (line.type !== "model") {
                    focusLine(line.model.id);
                }
            },
        };
        const action = keys[event.key];
        if (action) {
            event.preventDefault();
            action();
        }
    };
    const rowProps = (line: RowLine): RowProps => ({
        id: lineId(line.key),
        nested,
        focused: line.key === activeKey,
        selected: picked.includes(line.key),
        selecting: picked.length > 0,
        selectable: selectable(line),
        peeked: peek !== null && line.type === "model" && line.model.id === peek,
        columns: shownColumns,
        can,
        onFocus: () => {
            setFocusKey(line.key);
            if (peek !== null && line.type === "model") {
                setPeek(line.model.id);
            }
        },
        onKey: onKey(line),
        onSelect: (value) => select(line.key, value),
        open: () => on.open(hrefOfLine(line)),
    });
    const render = (line: Line) => {
        if (line.type === "model") {
            return (
                <ModelLine
                    key={line.key}
                    model={line.model}
                    expanded={line.expanded}
                    onToggle={() => toggle(line)}
                    on={on}
                    {...rowProps(line)}
                />
            );
        }
        if (line.type === "version") {
            return (
                <VersionLine
                    key={line.key}
                    model={line.model}
                    version={line.version}
                    on={on}
                    {...rowProps(line)}
                />
            );
        }
        if (line.type === "variant") {
            return (
                <VariantLine
                    key={line.key}
                    model={line.model}
                    row={line.row}
                    on={on}
                    {...rowProps(line)}
                />
            );
        }
        return (
            <MoreLine
                key={line.key}
                model={line.model}
                shown={line.shown}
                searching={line.searching}
            />
        );
    };
    const toolbar =
        picked.length > 0 ? (
            <SelectionBar
                versions={versions}
                variants={variants}
                on={on}
                can={can}
                onClear={clear}
            />
        ) : (
            <Toolbar
                search={
                    <SearchInput
                        aria-label="Search models, versions and variants"
                        placeholder="Search"
                        value={search.q ?? ""}
                        onValueChange={(value) => {
                            update({ q: value });
                            setSearchToggles({});
                        }}
                        className="w-64 shrink-0"
                    />
                }
                chips={<FilterChips models={models} filters={filters} onFilters={setFilters} />}
            />
        );
    const empty = rows.length === 0;
    const viewOptions = (
        <ViewOptions
            pool={pool}
            models={models}
            filters={filters}
            onFilters={setFilters}
            sort={sort}
            onSort={(value) => update({ sort: value === DEFAULT_SORT ? "" : value })}
            onReset={() => {
                update({ ...filterSearch(NO_FILTERS), sort: "" });
                setNested(false);
                setColumns(DEFAULT_COLUMNS);
            }}
            pristine={
                activeCount(filters) === 0 &&
                sort === DEFAULT_SORT &&
                !nested &&
                sameColumns(shownColumns, DEFAULT_COLUMNS)
            }
            nested={nested}
            onNested={(value) => {
                setNested(value);
                if (!value) {
                    clear();
                }
            }}
            columns={shownColumns}
            onColumns={setColumns}
        />
    );
    const body = all.isLoading ? (
        <p className="col-span-full px-4 py-6 text-muted-foreground">Loading models…</p>
    ) : all.error ? (
        <div className="col-span-full flex items-center gap-2 px-4 py-6">
            <ErrorLine error={all.error} />
            <Button variant="outline" onClick={() => all.refetch()}>
                Try again
            </Button>
        </div>
    ) : empty ? (
        <div className="col-span-full flex min-h-72 flex-col items-center justify-center gap-3 px-4 text-center">
            <ModelsEmpty />
        </div>
    ) : groups.length === 0 ? (
        <div className="col-span-full flex min-h-40 flex-wrap items-center justify-center gap-3 text-muted-foreground">
            No models, versions or variants match.
            <Button variant="outline" onClick={() => update(clearedSearch())}>
                Clear filters
            </Button>
        </div>
    ) : (
        groups.map((group) => (
            <section
                key={group.kind}
                aria-labelledby={`models-group-${group.kind}`}
                className="col-span-full grid grid-cols-subgrid"
            >
                <GroupBand group={group} />
                <ul
                    aria-labelledby={`models-group-${group.kind}`}
                    className="col-span-full grid grid-cols-subgrid divide-y"
                >
                    {group.lines.map(render)}
                </ul>
            </section>
        ))
    );
    return (
        <div className="flex flex-col gap-3">
            {toolbar}
            <div
                className="grid gap-x-3 overflow-x-auto rounded-lg border bg-card lg:overflow-x-clip"
                style={{ gridTemplateColumns: gridTemplate(shownColumns) }}
            >
                <div
                    className={cn(
                        ROW_GRID,
                        "sticky top-0 z-[15] h-10 border-b bg-secondary font-medium text-muted-foreground",
                    )}
                >
                    <span className={nested ? "pl-8" : undefined}>Model</span>
                    {COLUMNS.filter((column) => shownColumns.includes(column.id)).map((column) => (
                        <span key={column.id} className="whitespace-nowrap">
                            {column.label}
                        </span>
                    ))}
                    <span>Status</span>
                    <span className="flex justify-end">{viewOptions}</span>
                </div>
                {body}
            </div>
            <QuickLook
                model={peekModel}
                on={on}
                can={can}
                onClose={() => setPeek(null)}
                returnFocus={() => (activeKey ? document.getElementById(lineId(activeKey)) : null)}
            />
            <CompareDialog
                compared={compared}
                on={on}
                can={can}
                onClose={() => setCompared(null)}
            />
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
            <DeleteModelsDialog
                chosen={deleting}
                rows={rows}
                onOpenChange={(open) => !open && setDeleting(null)}
                onDelete={async (cascade, cancelJobs) => {
                    await deleteEntries(deleting ?? [], rows, cascade, cancelJobs);
                    await done();
                }}
            />
            <EditModelDialog row={editing} onOpenChange={(open) => !open && setEditing(null)} />
            <DuplicateModelDialog
                row={duplicating}
                onOpenChange={(open) => !open && setDuplicating(null)}
            />
            <SwitchBaseDialog
                row={switching?.row ?? null}
                preferred={switching?.preferred}
                onOpenChange={(open) => !open && setSwitching(null)}
            />
            {health.dialogs}
        </div>
    );
}

function clearedSearch(): ModelsSearch {
    return { q: "", state: "", kind: "", base: "" };
}
