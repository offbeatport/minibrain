import { useRouter } from "@tanstack/react-router";
import { GitCompare, PowerOff, Trash2, X } from "lucide-react";
import {
    Button,
    InfoTip,
    SearchInput,
    Separator,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
    useToast,
} from "obp-ui";
import { type KeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { PageHeader } from "~/components/PageHeader";
import { useCan } from "./flowOverlays";
import {
    type BaseVariant,
    type FlowModel,
    type FlowVersion,
    KIND_LABELS,
    attention,
    compareHref,
    deleteModels,
    deleteVariantFiles,
    deleteVersions,
    deployVariants,
    flowHref,
    liveVersion,
    modelHref,
    newestFirst,
    shownVersions,
    togglePin,
    undeployModels,
    undeployVariants,
    useFlowModels,
    variantKey,
    versionKey,
    versionState,
} from "./modelsFlowData";
import { AutopilotDialog, type Confirm, ConfirmDialog } from "./modelsFlowDialogs";
import { AddModel, ModelsToolbar, ShortcutsHelp } from "./modelsFlowHeader";
import { QuickLook } from "./modelsFlowPeek";
import {
    COLUMNS,
    type Column,
    type Handlers,
    type Hint,
    ModelRow,
    MoreRow,
    ROW_GRID,
    type RowProps,
    VariantRow,
    VersionRow,
    gridTemplate,
    plural,
} from "./modelsFlowRows";
import {
    DEFAULT_SORT,
    FilterChips,
    type Filters,
    type KindKey,
    NO_FILTERS,
    type SortKey,
    ViewOptions,
    passes,
    sortModels,
} from "./modelsFlowView";

type Line =
    | { key: string; type: "model"; model: FlowModel; expanded: boolean }
    | { key: string; type: "version"; model: FlowModel; version: FlowVersion }
    | { key: string; type: "variant"; model: FlowModel; variant: BaseVariant }
    | {
          key: string;
          type: "more";
          model: FlowModel;
          shown: number;
          searching: boolean;
      };
type RowLine = Extract<Line, { type: "model" | "version" | "variant" }>;
type Group = { kind: KindKey; label: string; count: number; lines: Line[] };

const GROUPS: { kind: KindKey; label: string }[] = [
    { kind: "custom", label: "Your models" },
    { kind: "base", label: "Base models" },
];

const HINTS: Record<string, Hint> = {
    "support-triage": {
        text: "Qwen3 0.6B scores 85.9% vs 86.7% at 1/12 the cost.",
        action: "Try smaller base",
        href: modelHref("support-triage", "versions"),
    },
};

const EXPANDED_KEY = "minibrain.proto.flow.expanded";
const COLUMNS_KEY = "minibrain.proto.flow.columns";
const NESTED_KEY = "minibrain.proto.flow.showVersions";
const DEFAULT_COLUMNS: Column[] = ["quality", "requests", "cost"];

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

function lineId(key: string): string {
    return `flow-line-${key}`;
}

function modelText(model: FlowModel): string {
    return `${model.name} ${model.description} ${model.base ?? ""} ${model.slug}`.toLowerCase();
}

function versionMatches(model: FlowModel, version: FlowVersion, text: string): boolean {
    const number = /^v(\d+)$/.exec(text);
    if (number) {
        return version.number === Number(number[1]);
    }
    const state = versionState(model, version).label;
    return `${KIND_LABELS[version.kind]} ${state} job #${version.jobId}`
        .toLowerCase()
        .includes(text);
}

function variantMatches(item: BaseVariant, text: string): boolean {
    return `${item.format} ${item.apiName} ${item.live ? "deployed" : "not deployed"}`
        .toLowerCase()
        .includes(text);
}

function childHits(model: FlowModel, text: string): number {
    if (!text) {
        return 0;
    }
    return model.kind === "base"
        ? model.variants.filter((item) => variantMatches(item, text)).length
        : model.versions.filter((version) => versionMatches(model, version, text)).length;
}

function childLines(model: FlowModel, text: string): Line[] {
    if (model.kind === "base") {
        const shown = text ? model.variants.filter((item) => variantMatches(item, text)) : [];
        return (shown.length > 0 ? shown : model.variants).map((item) => ({
            key: variantKey(model.slug, item.id),
            type: "variant" as const,
            model,
            variant: item,
        }));
    }
    const hits = text ? newestFirst(model).filter((v) => versionMatches(model, v, text)) : [];
    const searching = hits.length > 0;
    const shown = searching ? hits : shownVersions(model);
    const lines: Line[] = shown.map((version) => ({
        key: versionKey(model.slug, version.number),
        type: "version",
        model,
        version,
    }));
    if (shown.length < model.versions.length) {
        lines.push({
            key: `${model.slug}:more`,
            type: "more",
            model,
            shown: shown.length,
            searching,
        });
    }
    return lines;
}

function defaultExpanded(model: FlowModel): boolean {
    if (model.kind === "base") {
        return model.variants.some((item) => item.update !== null);
    }
    return attention(model) !== null || model.autopilot?.run !== undefined;
}

function matchesText(model: FlowModel, text: string): boolean {
    return !text || modelText(model).includes(text) || childHits(model, text) > 0;
}

function buildLines(
    models: FlowModel[],
    text: string,
    stored: Record<string, boolean>,
    searchToggles: Record<string, boolean>,
    nested: boolean,
): Line[] {
    return models.flatMap((model): Line[] => {
        const children = model.kind === "base" ? model.variants : model.versions;
        const searching = childHits(model, text) > 0;
        const expanded =
            nested &&
            children.length > 0 &&
            (searching
                ? (searchToggles[model.slug] ?? true)
                : (stored[model.slug] ?? defaultExpanded(model)));
        const row: Line = { key: model.slug, type: "model", model, expanded };
        return expanded ? [row, ...childLines(model, searching ? text : "")] : [row];
    });
}

type PickedVersion = { model: FlowModel; version: FlowVersion };
type PickedVariant = { model: FlowModel; variant: BaseVariant; key: string };

function pickedVersions(models: FlowModel[], keys: string[]): PickedVersion[] {
    return models.flatMap((model) =>
        model.versions
            .filter((version) => keys.includes(versionKey(model.slug, version.number)))
            .map((version) => ({ model, version })),
    );
}

function pickedVariants(models: FlowModel[], keys: string[]): PickedVariant[] {
    return models.flatMap((model) =>
        model.variants
            .map((item) => ({
                model,
                variant: item,
                key: variantKey(model.slug, item.id),
            }))
            .filter((item) => keys.includes(item.key)),
    );
}

function isLiveVersion(item: PickedVersion): boolean {
    return liveVersion(item.model)?.number === item.version.number;
}

function compareBlock(picked: PickedVersion[]): string | null {
    if (picked.length !== 2) {
        return `Compare takes exactly two versions of one model; ${plural(picked.length, "version")} ${picked.length === 1 ? "is" : "are"} ticked.`;
    }
    if (picked[0].model.slug !== picked[1].model.slug) {
        return "The two versions belong to different models; pick two of one model.";
    }
    if (picked.some((item) => !item.version.scores)) {
        return "Both versions need a score to compare.";
    }
    return null;
}

function WithTip({ tip, children }: { tip: string | null; children: ReactNode }) {
    if (!tip) {
        return children;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex">{children}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{tip}</TooltipContent>
        </Tooltip>
    );
}

function selectionCount(versions: PickedVersion[], variants: PickedVariant[]): string {
    const parts = [
        versions.length > 0 && plural(versions.length, "version"),
        variants.length > 0 && plural(variants.length, "variant"),
    ].filter(Boolean);
    const owners = [...new Set([...versions, ...variants].map((item) => item.model.name))];
    return `${parts.join(" and ")} selected${owners.length === 1 ? ` of ${owners[0]}` : ""}`;
}

function SelectionBar({
    versions,
    variants,
    onClear,
    on,
    onDelete,
}: {
    versions: PickedVersion[];
    variants: PickedVariant[];
    onClear: () => void;
    on: Handlers;
    onDelete: () => void;
}) {
    const mixed = versions.length > 0 && variants.length > 0;
    const liveVersions = versions.filter(isLiveVersion);
    const liveVariants = variants.filter((item) => item.variant.live);
    const skipped = [
        ...liveVersions.map((item) => `v${item.version.number} of ${item.model.name}`),
        ...liveVariants.map((item) => `${item.model.name} ${item.variant.format}`),
    ];
    const deletable = versions.length + variants.length - skipped.length;
    const blocked = compareBlock(versions);
    const sorted = [...versions].sort((a, b) => a.version.number - b.version.number);
    return (
        <div className="flex min-h-8 flex-wrap items-center gap-2">
            <span className="font-medium tabular-nums">{selectionCount(versions, variants)}</span>
            <Button variant="outline" onClick={onClear}>
                <X aria-hidden="true" />
                Clear selection
            </Button>
            {skipped.length > 0 && (
                <span className="text-sm text-muted-foreground">
                    {`${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} live and will not be deleted.`}
                </span>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
                {mixed && (
                    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        Only Delete fits both
                        <InfoTip label="Why only Delete">
                            Compare works on two versions of one custom model; Deploy and Undeploy
                            work on base formats, since a custom model makes one version live from
                            its row. Tick only versions or only variants to see those.
                        </InfoTip>
                    </span>
                )}
                {!mixed && versions.length > 0 && (
                    <WithTip tip={blocked}>
                        <Button
                            variant="outline"
                            disabled={Boolean(blocked)}
                            onClick={() =>
                                on.open(
                                    compareHref(
                                        sorted[0].model.slug,
                                        sorted[0].version.number,
                                        sorted[1].version.number,
                                    ),
                                )
                            }
                        >
                            <GitCompare aria-hidden="true" />
                            Compare
                        </Button>
                    </WithTip>
                )}
                {!mixed && variants.length > 0 && (
                    <>
                        <WithTip
                            tip={
                                liveVariants.length === variants.length
                                    ? "Every ticked variant is already live."
                                    : null
                            }
                        >
                            <Button
                                variant="outline"
                                disabled={liveVariants.length === variants.length}
                                onClick={() =>
                                    on.deployVariants(
                                        variants
                                            .filter((item) => !item.variant.live)
                                            .map((item) => item.key),
                                    )
                                }
                            >
                                Deploy
                            </Button>
                        </WithTip>
                        <WithTip tip={liveVariants.length === 0 ? "None of them is live." : null}>
                            <Button
                                variant="outline"
                                disabled={liveVariants.length === 0}
                                onClick={() =>
                                    on.undeployVariants(liveVariants.map((item) => item.key))
                                }
                            >
                                <PowerOff aria-hidden="true" />
                                Undeploy
                            </Button>
                        </WithTip>
                    </>
                )}
                <Separator
                    orientation="vertical"
                    className="mx-1 data-[orientation=vertical]:h-5"
                />
                <WithTip tip={deletable === 0 ? "Everything ticked is live." : null}>
                    <Button variant="destructive" disabled={deletable === 0} onClick={onDelete}>
                        <Trash2 aria-hidden="true" />
                        {variants.length > 0 && versions.length === 0 ? "Delete files" : "Delete"}
                    </Button>
                </WithTip>
            </div>
        </div>
    );
}

function useExpanded() {
    const [stored, setStored] = useState<Record<string, boolean>>(() =>
        readStored(EXPANDED_KEY, {}),
    );
    const toggle = (slug: string, next: boolean) => {
        const value = { ...stored, [slug]: next };
        setStored(value);
        writeStored(EXPANDED_KEY, value);
    };
    return { stored, toggle };
}

function confirmDeletion(
    versions: PickedVersion[],
    variants: PickedVariant[],
    done: (count: number) => void,
): Confirm {
    const goingVersions = versions.filter((item) => !isLiveVersion(item));
    const goingVariants = variants.filter((item) => !item.variant.live);
    const skipped = versions.length + variants.length - goingVersions.length - goingVariants.length;
    const names = [
        ...goingVersions.map((item) => `${item.model.name} v${item.version.number}`),
        ...goingVariants.map(
            (item) => `${item.model.name} ${item.variant.format} (${item.variant.size})`,
        ),
    ];
    const total = names.length;
    return {
        title:
            goingVariants.length > 0 && goingVersions.length === 0
                ? `Delete the files of ${plural(total, "variant")}?`
                : `Delete ${total === 1 ? names[0] : `${total} items`}?`,
        description: (
            <div className="flex flex-col gap-2">
                {total > 1 && <p>{names.join(", ")}</p>}
                {goingVariants.length > 0 && (
                    <p>Variant files can be downloaded again from Discover.</p>
                )}
                {skipped > 0 && (
                    <p>{`${plural(skipped, "live item")} skipped: undeploy it or move the live pointer first.`}</p>
                )}
            </div>
        ),
        label: "Delete",
        run: () => {
            deleteVersions(
                goingVersions.map((item) => versionKey(item.model.slug, item.version.number)),
            );
            deleteVariantFiles(goingVariants.map((item) => item.key));
            done(total);
        },
    };
}

export function ModelsFlowList() {
    const models = useFlowModels();
    const router = useRouter();
    const toast = useToast();
    const expanded = useExpanded();
    const [query, setQuery] = useState("");
    const [searchToggles, setSearchToggles] = useState<Record<string, boolean>>({});
    const [selection, setSelection] = useState<string[]>([]);
    const [focusKey, setFocusKey] = useState<string | null>(null);
    const [nested, setNested] = useState<boolean>(() => readStored(NESTED_KEY, false));
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const [filters, setFilters] = useState<Filters>(NO_FILTERS);
    const [sort, setSort] = useState<SortKey>(DEFAULT_SORT);
    const [columns, setColumns] = useState<Column[]>(() =>
        readStored(COLUMNS_KEY, DEFAULT_COLUMNS),
    );
    const [peek, setPeek] = useState<string | null>(null);
    const [autopilotFor, setAutopilotFor] = useState<string | null>(null);
    const canAdd = useCan("builder");
    const text = query.trim().toLowerCase();
    const pool = useMemo(() => models.filter((model) => matchesText(model, text)), [models, text]);
    const groups = useMemo(
        () =>
            GROUPS.map((group): Group => {
                const members = sortModels(
                    pool.filter((model) => model.kind === group.kind && passes(model, filters)),
                    sort,
                );
                return {
                    ...group,
                    count: members.length,
                    lines: buildLines(members, text, expanded.stored, searchToggles, nested),
                };
            }).filter((group) => group.count > 0),
        [pool, filters, sort, text, expanded.stored, searchToggles, nested],
    );
    const lines = groups.flatMap((group) => group.lines);
    const rows = lines.filter((line): line is RowLine =>
        ["model", "version", "variant"].includes(line.type),
    );
    const activeKey = rows.some((line) => line.key === focusKey) ? focusKey : rows[0]?.key;
    const visibleKeys = new Set(rows.map((line) => line.key));
    const picked = selection.filter((key) => visibleKeys.has(key));
    const versions = pickedVersions(models, picked);
    const variants = pickedVariants(models, picked);
    const clear = () => setSelection([]);
    const peekModel = models.find((model) => model.slug === peek) ?? null;
    const on: Handlers = {
        open: (href) => router.history.push(href),
        peek: (model) => {
            setPeek(model.slug);
            focusLine(model.slug);
        },
        pin: (model) => {
            togglePin(model.slug);
            toast({
                title: model.pinned ? `Unpinned ${model.name}` : `Pinned ${model.name}`,
            });
        },
        autopilot: (model) => setAutopilotFor(model.slug),
        undeploy: (chosen) =>
            setConfirm({
                title:
                    chosen.length === 1
                        ? `Undeploy ${chosen[0].name}?`
                        : `Undeploy ${plural(chosen.length, "model")}?`,
                description: (
                    <p>
                        Their names stop answering; the live pointer, versions, keys and files stay.
                    </p>
                ),
                label: "Undeploy",
                run: () => {
                    undeployModels(chosen.map((model) => model.slug));
                    toast({
                        title: `${chosen.map((model) => model.name).join(", ")} undeployed`,
                        tone: "success",
                    });
                },
            }),
        removeModels: (chosen) =>
            setConfirm({
                title: `Delete ${chosen[0].name}?`,
                description: (
                    <p>{`${chosen[0].name} goes with every version, variant file, key and score.`}</p>
                ),
                label: "Delete",
                run: () => {
                    deleteModels(chosen.map((model) => model.slug));
                    toast({ title: `Deleted ${chosen[0].name}`, tone: "success" });
                },
            }),
        removeVersions: (items) =>
            setConfirm(
                confirmDeletion(items, [], (count) =>
                    toast({
                        title: `Deleted ${plural(count, "version")}`,
                        tone: "success",
                    }),
                ),
            ),
        deployVariants: (keys) => {
            deployVariants(keys);
            clear();
            toast({
                title: `${plural(keys.length, "variant")} deployed`,
                tone: "success",
            });
        },
        undeployVariants: (keys) => {
            const chosen = pickedVariants(models, keys);
            setConfirm({
                title: `Undeploy ${chosen.map((item) => `${item.model.name} ${item.variant.format}`).join(", ")}?`,
                description: (
                    <p>{`Requests to ${chosen.map((item) => item.variant.apiName).join(", ")} stop being answered; the files stay.`}</p>
                ),
                label: "Undeploy",
                run: () => {
                    undeployVariants(keys);
                    clear();
                    toast({ title: `${plural(keys.length, "variant")} undeployed` });
                },
            });
        },
        removeVariants: (keys) =>
            setConfirm(
                confirmDeletion([], pickedVariants(models, keys), (count) =>
                    toast({
                        title: `Deleted ${plural(count, "variant file")}`,
                        tone: "success",
                    }),
                ),
            ),
    };
    const select = (key: string, value: boolean) =>
        setSelection(value ? [...new Set([...picked, key])] : picked.filter((k) => k !== key));
    const toggle = (line: Extract<Line, { type: "model" }>) => {
        const next = !line.expanded;
        if (!next) {
            setSelection(
                picked.filter(
                    (key) =>
                        !key.startsWith(`${line.model.slug}@`) &&
                        !key.startsWith(`${line.model.slug}#`),
                ),
            );
        }
        if (childHits(line.model, text) > 0) {
            setSearchToggles({ ...searchToggles, [line.model.slug]: next });
        } else {
            expanded.toggle(line.model.slug, next);
        }
    };
    function focusLine(key: string | undefined) {
        if (!key) {
            return;
        }
        setFocusKey(key);
        requestAnimationFrame(() => document.getElementById(lineId(key))?.focus());
    }
    const hrefOf = (line: RowLine) =>
        line.type === "version"
            ? flowHref(line.model.slug, line.version.number)
            : flowHref(line.model.slug);
    const onKey = (line: RowLine) => (event: KeyboardEvent<HTMLLIElement>) => {
        if (event.target !== event.currentTarget) {
            return;
        }
        const index = rows.findIndex((row) => row.key === line.key);
        const keys: Record<string, () => void> = {
            ArrowDown: () => focusLine(rows[index + 1]?.key),
            ArrowUp: () => focusLine(rows[index - 1]?.key),
            Home: () => focusLine(rows[0]?.key),
            End: () => focusLine(rows.at(-1)?.key),
            Enter: () => on.open(hrefOf(line)),
            Escape: () => setPeek(null),
            " ": () => {
                if (line.type === "model") {
                    setPeek(peek === line.model.slug ? null : line.model.slug);
                } else {
                    select(line.key, !picked.includes(line.key));
                }
            },
            ArrowRight: () => {
                if (line.type !== "model") {
                    return;
                }
                if (line.expanded) {
                    focusLine(rows[index + 1]?.key);
                } else if (nested && line.model.versions.length + line.model.variants.length > 0) {
                    toggle(line);
                }
            },
            ArrowLeft: () => {
                if (line.type === "model" && line.expanded) {
                    toggle(line);
                } else if (line.type !== "model") {
                    focusLine(line.model.slug);
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
        peeked: peek !== null && line.type === "model" && line.model.slug === peek,
        columns,
        onFocus: () => {
            setFocusKey(line.key);
            if (peek !== null) {
                setPeek(line.model.slug);
            }
        },
        onKey: onKey(line),
        onSelect: (value) => select(line.key, value),
        open: () => on.open(hrefOf(line)),
    });
    const render = (line: Line) => {
        if (line.type === "model") {
            return (
                <ModelRow
                    key={line.key}
                    model={line.model}
                    expanded={line.expanded}
                    onToggle={() => toggle(line)}
                    on={on}
                    hint={HINTS[line.model.slug]}
                    {...rowProps(line)}
                />
            );
        }
        if (line.type === "version") {
            return (
                <VersionRow
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
                <VariantRow
                    key={line.key}
                    model={line.model}
                    variant={line.variant}
                    on={on}
                    {...rowProps(line)}
                />
            );
        }
        return (
            <MoreRow
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
                onClear={clear}
                on={on}
                onDelete={() =>
                    setConfirm(
                        confirmDeletion(versions, variants, (count) => {
                            clear();
                            toast({
                                title: `Deleted ${plural(count, "item")}`,
                                tone: "success",
                            });
                        }),
                    )
                }
            />
        ) : (
            <ModelsToolbar
                search={
                    <SearchInput
                        aria-label="Search models, versions and variants"
                        placeholder="Search"
                        value={query}
                        onValueChange={(value) => {
                            setQuery(value);
                            setSearchToggles({});
                        }}
                        className="w-64 shrink-0"
                    />
                }
                chips={<FilterChips models={models} filters={filters} onFilters={setFilters} />}
                actions={
                    <>
                        <ShortcutsHelp nested={nested} />
                        <ViewOptions
                            pool={pool}
                            models={models}
                            filters={filters}
                            onFilters={setFilters}
                            sort={sort}
                            onSort={setSort}
                            columns={columns}
                            onColumns={(value) => {
                                setColumns(value);
                                writeStored(COLUMNS_KEY, value);
                            }}
                            nested={nested}
                            onNested={(value) => {
                                setNested(value);
                                writeStored(NESTED_KEY, value);
                                if (!value) {
                                    clear();
                                }
                            }}
                        />
                        {canAdd && <AddModel />}
                    </>
                }
            />
        );
    return (
        <div className="flex flex-col gap-3">
            <PageHeader title="Models" caption="Your models and the bases they run on." />
            {toolbar}
            <div
                className="grid gap-x-3 overflow-x-auto rounded-lg border bg-card"
                style={{ gridTemplateColumns: gridTemplate(columns) }}
            >
                <div
                    className={cn(
                        ROW_GRID,
                        "h-9 border-b bg-secondary font-medium text-muted-foreground",
                    )}
                >
                    <span className={nested ? "pl-8" : undefined}>Model</span>
                    {COLUMNS.filter((column) => columns.includes(column.id)).map((column) => (
                        <span key={column.id} className="whitespace-nowrap">
                            {column.label}
                        </span>
                    ))}
                    <span>Status</span>
                    <span className="sr-only">Actions</span>
                </div>
                {lines.length === 0 ? (
                    <div className="col-span-full flex min-h-40 items-center justify-center gap-2 text-muted-foreground">
                        No models, versions or variants match.
                    </div>
                ) : (
                    groups.map((group) => (
                        <section
                            key={group.kind}
                            aria-labelledby={`flow-group-${group.kind}`}
                            className="col-span-full grid grid-cols-subgrid border-t first-of-type:border-t-0"
                        >
                            <h2
                                id={`flow-group-${group.kind}`}
                                className={cn(
                                    "col-span-full flex h-9 items-center gap-2 border-b px-4 font-medium",
                                    nested && "pl-12",
                                )}
                            >
                                {group.label}
                                <span className="text-sm font-normal text-muted-foreground tabular-nums">
                                    {group.count}
                                </span>
                            </h2>
                            <ul
                                aria-labelledby={`flow-group-${group.kind}`}
                                className="col-span-full grid grid-cols-subgrid divide-y"
                            >
                                {group.lines.map(render)}
                            </ul>
                        </section>
                    ))
                )}
            </div>
            <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
            <AutopilotDialog
                model={models.find((model) => model.slug === autopilotFor) ?? null}
                onClose={() => setAutopilotFor(null)}
            />
            <QuickLook
                model={peekModel}
                on={on}
                onClose={() => setPeek(null)}
                returnFocus={() => (activeKey ? document.getElementById(lineId(activeKey)) : null)}
            />
        </div>
    );
}
