import { useRouter, useRouterState } from "@tanstack/react-router";
import {
    ArrowRight,
    Folder,
    FolderInput,
    FolderPlus,
    Grid2x2Plus,
    Import,
    Layers,
    Pencil,
    Table2,
    Trash2,
} from "lucide-react";
import {
    Badge,
    Button,
    DropZone,
    DropdownMenuItem,
    DropdownMenuSeparator,
    EmptyState,
    FileName,
    Link,
    SearchInput,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    Tree,
    type TreeNode,
    TreeRowMenu,
    ancestorsOf,
    filterTree,
} from "obp-ui";
import {
    type CSSProperties,
    type KeyboardEvent,
    type PointerEvent,
    type ReactNode,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import type { DatasetSummary, SourceAdded, SourceSummary } from "~/api/client";
import { type DatasetFolder, useDatasetFolders, useFolderRoots } from "~/api/dataQueries";
import { useDatasets, useSources } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Stat } from "~/components/Section";
import { DATA_FILE_TYPES } from "~/lib/dataFiles";
import { count } from "~/lib/format";
import { bytes } from "~/lib/time";
import { AddMenu, SourceChoices, useSourceBlocks } from "./AddMenu";
import {
    type AddKind,
    AlreadyAddedDialog,
    type SourceAdder,
    addSourceKind,
    useSourceAdder,
} from "./AddSource";
import { AddDatabaseDialog, AddS3Dialog, ConnectedGroup } from "./Connected";
import { CreateDataset, DatasetDetail } from "./DatasetDetail";
import { DatasetsRoot, FolderDetail, folderOf, folderRef, useMoveItem } from "./DatasetFolders";
import { FileDetail } from "./FileDetail";
import { AddFolderDialog, FoldersGroup } from "./Folders";
import { AddLakehouseDialog, LakehouseGroup } from "./Lakehouse";
import { MakeDatasetDialog, SourceTable } from "./SourceTable";
import { SourcesOverview } from "./Sources";
import { type TreeAction, TreeActionDialogs, useRemoveItem } from "./TreeActions";
import {
    DATASETS_GROUP,
    type FolderIndex,
    type ItemRef,
    SOURCES_GROUP,
    SOURCE_GROUPS,
    type SourceGroupId,
    TABLE_FORMATS,
    datasetNamed,
    datasetText,
    datasetsInside,
    folderIndex,
    groupOf,
    inGroup,
    itemHref,
    itemKey,
    parseItem,
    siblingNamed,
    sourceText,
    tableFormat,
    usesSource,
} from "./catalogue";
import { GroupIcon, SourceIcon } from "./icons";
import { useDataRefresh } from "./parts";

const WIDTH_KEY = "minibrain.data.treeWidth";
const DEFAULT_WIDTH = 288;
const MIN_WIDTH = 200;
const MAX_WIDTH = 520;
const WIDTH_STEP = 16;
const DEFAULT_ITEM: ItemRef = DATASETS_GROUP;

function sourceNode(source: SourceSummary): TreeNode {
    const id = itemKey({ kind: "source", id: source.id });
    const format = tableFormat(source.kind);
    if (format) {
        return {
            id,
            label: source.name,
            icon: <SourceIcon source={source} />,
            meta: <Badge variant="outline">{TABLE_FORMATS[format].short}</Badge>,
        };
    }
    if (source.kind !== "upload") {
        return { id, label: source.name, icon: <SourceIcon source={source} /> };
    }
    return {
        id,
        label: <FileName name={source.name} />,
        textValue: source.name,
        icon: <SourceIcon source={source} />,
    };
}

function clampWidth(width: number): number {
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

function readWidth(): number {
    try {
        const stored = Number(window.localStorage.getItem(WIDTH_KEY));
        return stored ? clampWidth(stored) : DEFAULT_WIDTH;
    } catch {
        return DEFAULT_WIDTH;
    }
}

function writeWidth(width: number): void {
    try {
        window.localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
        return;
    }
}

function useTreeWidth() {
    const [width, setWidth] = useState(readWidth);
    const commit = (next: number) => {
        const clamped = clampWidth(next);
        setWidth(clamped);
        writeWidth(clamped);
    };
    const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        const move = (moved: globalThis.PointerEvent) =>
            setWidth(clampWidth(startWidth + moved.clientX - startX));
        const stop = (ended: globalThis.PointerEvent) => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
            commit(startWidth + ended.clientX - startX);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
    };
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            commit(width + (event.key === "ArrowLeft" ? -WIDTH_STEP : WIDTH_STEP));
        }
    };
    return { width, onPointerDown, onKeyDown, reset: () => commit(DEFAULT_WIDTH) };
}

function folderNodes(index: FolderIndex, parent: number | null): TreeNode[] {
    const folders = (index.folders.get(parent) ?? []).map((folder) => ({
        id: itemKey({ kind: "folder", id: folder.id }),
        label: folder.name,
        icon: <Folder />,
        meta: datasetsInside(index, folder.id).length,
        draggable: true,
        droppable: true,
        children: folderNodes(index, folder.id),
    }));
    const datasets = (index.datasets.get(parent) ?? []).map((dataset) => ({
        id: itemKey({ kind: "dataset", id: dataset.slug }),
        label: dataset.name,
        icon: <Table2 />,
        draggable: true,
    }));
    return [...folders, ...datasets];
}

function buildTree(
    sources: SourceSummary[],
    datasets: DatasetSummary[],
    index: FolderIndex,
): TreeNode[] {
    const datasetGroup: TreeNode = {
        id: itemKey(DATASETS_GROUP),
        label: "Datasets",
        icon: <Layers />,
        meta: datasets.length,
        droppable: true,
        children: folderNodes(index, null),
    };
    const sourceGroups = SOURCE_GROUPS.map((group) => {
        const members = sources.filter((source) => inGroup(source, group));
        return {
            id: itemKey({ kind: "group", id: group.id }),
            label: group.label,
            icon: <GroupIcon group={group.id} />,
            meta: members.length,
            children: members.map(sourceNode),
        };
    });
    const sourcesGroup: TreeNode = {
        id: itemKey(SOURCES_GROUP),
        label: "Sources",
        icon: <Import />,
        meta: sources.length,
        children: sourceGroups,
    };
    return [datasetGroup, sourcesGroup];
}

function searchIndex(
    sources: SourceSummary[],
    datasets: DatasetSummary[],
    folders: DatasetFolder[],
): Map<string, string> {
    const index = new Map<string, string>();
    index.set(itemKey(DATASETS_GROUP), "datasets");
    index.set(itemKey(SOURCES_GROUP), "sources");
    for (const { id, label } of SOURCE_GROUPS) {
        index.set(itemKey({ kind: "group", id }), label.toLowerCase());
    }
    for (const folder of folders) {
        index.set(itemKey({ kind: "folder", id: folder.id }), folder.name.toLowerCase());
    }
    for (const source of sources) {
        index.set(itemKey({ kind: "source", id: source.id }), sourceText(source));
    }
    for (const dataset of datasets) {
        index.set(itemKey({ kind: "dataset", id: dataset.slug }), datasetText(dataset));
    }
    return index;
}

function allBranches(nodes: TreeNode[]): string[] {
    return nodes.flatMap((node) =>
        node.children?.length ? [node.id, ...allBranches(node.children)] : [],
    );
}

function GroupDetail({
    kind,
    sources,
    datasets,
    adder,
    picked,
    onPick,
    onMake,
    onSelect,
}: {
    kind: SourceGroupId;
    sources: SourceSummary[];
    datasets: DatasetSummary[];
    adder: SourceAdder;
    picked: string[];
    onPick: (ids: string[]) => void;
    onMake: (sources: SourceSummary[]) => void;
    onSelect: (item: ItemRef) => void;
}) {
    const grouped = sources.filter((source) => groupOf(source.kind).id === kind);
    const table = grouped.length > 0 && (
        <SourceTable
            sources={grouped}
            selected={picked}
            onSelectedChange={onPick}
            onMake={onMake}
            onSelect={onSelect}
        />
    );
    if (kind !== "upload") {
        return (
            <div className="flex flex-col gap-6">
                {kind === "folder" ? (
                    <FoldersGroup sources={sources} datasets={datasets} />
                ) : kind === "lakehouse" ? (
                    <LakehouseGroup sources={sources} datasets={datasets} />
                ) : (
                    <ConnectedGroup kind={kind} sources={sources} datasets={datasets} />
                )}
                {table}
            </div>
        );
    }
    const members = grouped;
    const ids = new Set(members.map((source) => source.id));
    const built = datasets.filter((dataset) =>
        dataset.sources.some((source) => ids.has(source.id)),
    );
    return (
        <div className="flex flex-col gap-6">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 className="text-2xl font-semibold">Uploads</h2>
                    <p className="text-sm text-muted-foreground">
                        Files copied into this install, stored once and shared by every model.
                    </p>
                </div>
            </header>
            <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat label="Files" value={count(members.length)} />
                <Stat label="Datasets" value={count(built.length)} />
                <Stat
                    label="Stored"
                    value={bytes(members.reduce((sum, source) => sum + source.size, 0))}
                />
            </div>
            <DropZone
                accept={DATA_FILE_TYPES}
                disabled={adder.pending !== null}
                title={adder.pending === "upload" ? "Uploading…" : "Drop a data file here"}
                activeTitle="Drop to upload"
                description={
                    members.length === 0
                        ? "CSV, TSV, JSON, JSON Lines or Parquet. Then make a dataset from it, or start from sample data under Add."
                        : "CSV, TSV, JSON, JSON Lines or Parquet. A file already uploaded is not stored twice."
                }
                inputLabel="Data file to upload"
                onFiles={adder.drop}
            />
            {table}
        </div>
    );
}

function DeleteItem({ blocked, onSelect }: { blocked: string | null; onSelect: () => void }) {
    return (
        <DropdownMenuItem variant="destructive" disabled={blocked !== null} onSelect={onSelect}>
            <Trash2 />
            Delete
            {blocked && (
                <span className="ml-auto pl-3 text-sm text-muted-foreground">{blocked}</span>
            )}
        </DropdownMenuItem>
    );
}

function Missing({ item }: { item: ItemRef }) {
    return (
        <EmptyState
            variant="panel"
            title="Not found"
            className="mx-0 mt-0"
            action={
                <Button asChild variant="outline" size="sm" className="mt-3">
                    <Link href="/data">All data</Link>
                </Button>
            }
        >
            {`No ${item.kind === "group" ? "group" : item.kind} matches this link. It may have been deleted.`}
        </EmptyState>
    );
}

export function DataExplorer() {
    const router = useRouter();
    const requested = useRouterState({
        select: (state) => parseItem((state.location.search as { item?: unknown }).item),
    });
    const sources = useSources();
    const datasets = useDatasets();
    const folders = useDatasetFolders();
    const refresh = useDataRefresh();
    const move = useMoveItem();
    const width = useTreeWidth();
    const [query, setQuery] = useState("");
    const [collapsed, setCollapsed] = useState<string[]>([]);
    const [creatingFor, setCreatingFor] = useState<number | string | null>(null);
    const [adding, setAdding] = useState<AddKind | null>(null);
    const [already, setAlready] = useState<SourceSummary | null>(null);
    const [picked, setPicked] = useState<{ scope: string; ids: string[] }>({
        scope: "",
        ids: [],
    });
    const [making, setMaking] = useState<SourceSummary[] | null>(null);
    const roots = useFolderRoots();
    const treeBox = useRef<HTMLDivElement>(null);
    const loading = sources.isLoading || datasets.isLoading || folders.isLoading;
    const sourceList = useMemo(() => sources.data ?? [], [sources.data]);
    const datasetList = useMemo(() => datasets.data ?? [], [datasets.data]);
    const folderList = useMemo(() => folders.data ?? [], [folders.data]);
    const selected = requested ?? DEFAULT_ITEM;
    const selectedKey = itemKey(selected);
    const index = useMemo(() => folderIndex(folderList, datasetList), [folderList, datasetList]);
    const nodes = useMemo(
        () => buildTree(sourceList, datasetList, index),
        [sourceList, datasetList, index],
    );
    const haystacks = useMemo(
        () => searchIndex(sourceList, datasetList, folderList),
        [sourceList, datasetList, folderList],
    );
    const branches = useMemo(() => allBranches(nodes), [nodes]);
    const text = query.trim().toLowerCase();
    const filtered = useMemo(
        () =>
            text
                ? filterTree(nodes, (node) => haystacks.get(node.id)?.includes(text) ?? false)
                : null,
        [nodes, haystacks, text],
    );
    const expanded = branches.filter((id) => !collapsed.includes(id));
    const matches = text
        ? [...haystacks.entries()].filter(
              ([id, value]) => !id.startsWith("group:") && value.includes(text),
          ).length
        : 0;

    useEffect(() => {
        const above = ancestorsOf(nodes, selectedKey);
        setCollapsed((current) =>
            above.some((id) => current.includes(id))
                ? current.filter((id) => !above.includes(id))
                : current,
        );
    }, [nodes, selectedKey]);

    const select = (item: ItemRef) => {
        if (itemKey(item) !== selectedKey) {
            setCreatingFor(null);
        }
        router.history.replace(itemHref(item));
    };

    const onSelectKey = (key: string) => {
        const item = parseItem(key);
        if (item) {
            select(item);
        }
    };

    const add = (kind: AddKind) => setAdding(kind);

    const onMove = (id: string, targetId: string) => {
        const item = parseItem(id);
        const into = folderOf(parseItem(targetId));
        if (into !== undefined && (item?.kind === "dataset" || item?.kind === "folder")) {
            move.mutate({ item, into });
        }
    };

    const canDrop = (node: TreeNode, target: TreeNode) => {
        const item = parseItem(node.id);
        const into = folderOf(parseItem(target.id));
        if (into === undefined || (item?.kind !== "dataset" && item?.kind !== "folder")) {
            return false;
        }
        if (item.kind === "dataset") {
            const dataset = datasetList.find((row) => row.slug === item.id);
            return !dataset || !datasetNamed(index.datasets.get(into) ?? [], dataset.name, item.id);
        }
        const folder = index.byId.get(item.id);
        return !folder || !siblingNamed(index, into, folder.name, folder.id);
    };

    const onUploaded = (source: SourceAdded) => {
        if (source.outcome === "existing") {
            setAlready(source);
            return;
        }
        setQuery("");
        router.history.replace(itemHref({ kind: "source", id: source.id }));
        setCreatingFor(source.outcome === "created" ? source.id : null);
    };

    const adder = useSourceAdder(onUploaded);
    const addKind = addSourceKind(adder, add);
    const blocks = useSourceBlocks();
    const pickedIds = picked.scope === selectedKey ? picked.ids : [];
    const pickedSources = sourceList.filter((source) => pickedIds.includes(String(source.id)));
    const [action, setAction] = useState<TreeAction | null>(null);
    const remove = useRemoveItem(selected, select);

    const focusTreeRow = () => {
        window.requestAnimationFrame(() =>
            treeBox.current?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')?.focus(),
        );
    };

    const createIn = (item: ItemRef, key: number | string) => {
        select(item);
        setCreatingFor(key);
    };

    const currentFolder = (): number | null => {
        const id =
            selected.kind === "folder"
                ? selected.id
                : selected.kind === "dataset"
                  ? (datasetList.find((row) => row.slug === selected.id)?.folder_id ?? null)
                  : null;
        return id !== null && index.byId.has(id) ? id : null;
    };

    const newDataset = () => {
        if (selected.kind === "source" && sourceList.some((row) => row.id === selected.id)) {
            setCreatingFor(selected.id);
            return;
        }
        const folder = currentFolder();
        const into = folderRef(folder);
        createIn(into, folder === null ? "new" : itemKey(into));
    };

    const fromSources = () => {
        if (pickedSources.length > 0) {
            setMaking(pickedSources);
            return;
        }
        select({ kind: "group", id: "upload" });
    };

    const menuFor = (node: TreeNode): ReactNode => {
        const item = parseItem(node.id);
        if (!item) {
            return null;
        }
        const name = node.textValue ?? (typeof node.label === "string" ? node.label : node.id);
        const label = `Actions for ${name}`;
        const open = (
            <DropdownMenuItem onSelect={() => select(item)}>
                <ArrowRight />
                Open
            </DropdownMenuItem>
        );
        if (item.kind === "group" && item.id === "datasets") {
            return (
                <TreeRowMenu label={label}>
                    <DropdownMenuItem onSelect={() => createIn(DATASETS_GROUP, "new")}>
                        <Grid2x2Plus />
                        New dataset
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onSelect={() => setAction({ kind: "new-folder", parentId: null })}
                    >
                        <FolderPlus />
                        New folder
                    </DropdownMenuItem>
                </TreeRowMenu>
            );
        }
        if (item.kind === "group") {
            return (
                <TreeRowMenu label={label}>
                    <SourceChoices
                        groups={item.id === "sources" ? undefined : [item.id as SourceGroupId]}
                        blocks={blocks}
                        onPick={addKind}
                    />
                </TreeRowMenu>
            );
        }
        if (item.kind === "folder") {
            const folder = index.byId.get(item.id);
            if (!folder) {
                return null;
            }
            return (
                <TreeRowMenu label={label}>
                    <DropdownMenuItem onSelect={() => createIn(item, itemKey(item))}>
                        <Grid2x2Plus />
                        New dataset
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onSelect={() => setAction({ kind: "new-folder", parentId: folder.id })}
                    >
                        <FolderPlus />
                        New folder
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setAction({ kind: "rename-folder", folder })}>
                        <Pencil />
                        Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onSelect={() =>
                            setAction({
                                kind: "move",
                                target: { item, name: folder.name, from: folder.parent_id },
                            })
                        }
                    >
                        <FolderInput />
                        Move to…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setAction({ kind: "delete-folder", folder })}
                    >
                        <Trash2 />
                        Delete
                    </DropdownMenuItem>
                </TreeRowMenu>
            );
        }
        if (item.kind === "dataset") {
            const dataset = datasetList.find((row) => row.slug === item.id);
            if (!dataset) {
                return null;
            }
            return (
                <TreeRowMenu label={label}>
                    {open}
                    <DropdownMenuItem
                        onSelect={() => setAction({ kind: "rename-dataset", dataset })}
                    >
                        <Pencil />
                        Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onSelect={() =>
                            setAction({
                                kind: "move",
                                target: {
                                    item,
                                    name: dataset.name,
                                    from: dataset.folder_id ?? null,
                                },
                            })
                        }
                    >
                        <FolderInput />
                        Move to…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DeleteItem
                        blocked={null}
                        onSelect={() => setAction({ kind: "delete-dataset", dataset })}
                    />
                </TreeRowMenu>
            );
        }
        const source = sourceList.find((row) => row.id === item.id);
        if (!source) {
            return null;
        }
        const readers = datasetList.filter((dataset) => usesSource(dataset, source.id)).length;
        return (
            <TreeRowMenu label={label}>
                {open}
                <DropdownMenuItem onSelect={() => createIn(item, source.id)}>
                    <Grid2x2Plus />
                    New dataset
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setAction({ kind: "rename-source", source })}>
                    <Pencil />
                    Rename
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DeleteItem
                    blocked={readers > 0 ? "Used by datasets" : null}
                    onSelect={() => setAction({ kind: "delete-source", source })}
                />
            </TreeRowMenu>
        );
    };

    const focusTree = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "ArrowDown") {
            const stop = treeBox.current?.querySelector<HTMLElement>(
                '[role="treeitem"][tabindex="0"]',
            );
            if (stop) {
                event.preventDefault();
                stop.focus();
            }
        }
    };

    const created = async (dataset: DatasetSummary) => {
        await refresh();
        setCreatingFor(null);
        select({ kind: "dataset", id: dataset.slug });
    };

    let detail: ReactNode = null;
    if (!loading) {
        if (selected.kind === "group" && selected.id === "datasets") {
            detail = (
                <div className="flex flex-col gap-6">
                    <DatasetsRoot
                        datasets={datasetList}
                        index={index}
                        creating={creatingFor === "new"}
                        onSelect={select}
                    />
                    {creatingFor === "new" && (
                        <CreateDataset
                            sources={sourceList}
                            onCancel={() => setCreatingFor(null)}
                            onCreated={created}
                        />
                    )}
                </div>
            );
        } else if (selected.kind === "group" && selected.id === "sources") {
            detail = (
                <SourcesOverview sources={sourceList} datasets={datasetList} onSelect={select} />
            );
        } else if (selected.kind === "group") {
            detail = (
                <GroupDetail
                    kind={selected.id as SourceGroupId}
                    sources={sourceList}
                    datasets={datasetList}
                    adder={adder}
                    picked={pickedIds}
                    onPick={(ids) => setPicked({ scope: selectedKey, ids })}
                    onMake={setMaking}
                    onSelect={select}
                />
            );
        } else if (selected.kind === "source") {
            const source = sourceList.find((item) => item.id === selected.id);
            detail = source ? (
                <FileDetail
                    key={selectedKey}
                    source={source}
                    sources={sourceList}
                    datasets={datasetList.filter((dataset) => usesSource(dataset, source.id))}
                    creating={creatingFor === source.id}
                    onCreating={(on) => setCreatingFor(on ? source.id : null)}
                    onSelect={select}
                />
            ) : (
                <Missing item={selected} />
            );
        } else if (selected.kind === "folder") {
            const folder = index.byId.get(selected.id);
            detail = folder ? (
                <div className="flex flex-col gap-6">
                    <FolderDetail
                        key={selectedKey}
                        folder={folder}
                        index={index}
                        creating={creatingFor === selectedKey}
                        onSelect={select}
                    />
                    {creatingFor === selectedKey && (
                        <CreateDataset
                            sources={sourceList}
                            folderId={folder.id}
                            onCancel={() => setCreatingFor(null)}
                            onCreated={created}
                        />
                    )}
                </div>
            ) : (
                <Missing item={selected} />
            );
        } else {
            const dataset = datasetList.find((item) => item.slug === selected.id);
            detail = dataset ? (
                <DatasetDetail
                    key={selectedKey}
                    dataset={dataset}
                    sources={sourceList}
                    index={index}
                    onSelect={select}
                />
            ) : (
                <Missing item={selected} />
            );
        }
    }

    return (
        <div className="@container flex min-h-0 flex-1 flex-col">
            <div className="px-6 pt-8">
                <PageHeader
                    title="Data"
                    caption="Datasets, the sources their queries read and the models that train on them."
                    actions={
                        <AddMenu
                            adder={adder}
                            picked={pickedSources.length}
                            onAdd={add}
                            onNewDataset={newDataset}
                            onNewFolder={() =>
                                setAction({ kind: "new-folder", parentId: currentFolder() })
                            }
                            onFromSources={fromSources}
                        />
                    }
                />
                <ErrorLine
                    error={sources.error ?? datasets.error ?? folders.error ?? adder.error}
                />
                {adder.picker}
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto border-t @3xl:flex-row @3xl:overflow-hidden">
                <aside
                    aria-label="Data catalogue"
                    className="relative flex max-h-80 shrink-0 flex-col border-b @3xl:max-h-none @3xl:w-(--tree-width) @3xl:border-r @3xl:border-b-0"
                    style={{ "--tree-width": `${width.width}px` } as CSSProperties}
                >
                    <div className="flex flex-col gap-1 border-b p-2">
                        <SearchInput
                            aria-label="Search data"
                            placeholder="Search names, columns, tags"
                            value={query}
                            onValueChange={setQuery}
                            onKeyDown={focusTree}
                        />
                        {text && (
                            <p
                                className="px-1 text-sm text-muted-foreground tabular-nums"
                                aria-live="polite"
                            >
                                {matches === 0
                                    ? "No matches"
                                    : `${count(matches)} match${matches === 1 ? "" : "es"}`}
                            </p>
                        )}
                        <ErrorLine error={move.error ?? remove.error} />
                    </div>
                    <div ref={treeBox} className="min-h-0 flex-1 overflow-y-auto">
                        {loading ? (
                            <p className="p-3 text-sm text-muted-foreground">Loading…</p>
                        ) : (
                            <>
                                <Tree
                                    aria-label="Datasets and sources"
                                    nodes={filtered?.nodes ?? nodes}
                                    selectedId={selectedKey}
                                    onSelect={onSelectKey}
                                    expandedIds={
                                        filtered ? [...expanded, ...filtered.expandedIds] : expanded
                                    }
                                    onExpandedChange={(next) =>
                                        setCollapsed(branches.filter((id) => !next.includes(id)))
                                    }
                                    onMove={onMove}
                                    canDrop={canDrop}
                                    rowActions={menuFor}
                                    empty={
                                        <p className="p-3 text-sm text-muted-foreground">
                                            Nothing matches. Search looks in names, column names,
                                            descriptions and tags.
                                        </p>
                                    }
                                />
                                {!text && sourceList.length === 0 && (
                                    <p className="pr-3 pb-3 pl-11 text-sm text-muted-foreground">
                                        No sources yet. Use Add to upload a file, read a folder,
                                        bucket or database, or try sample data.
                                    </p>
                                )}
                            </>
                        )}
                    </div>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <button
                                type="button"
                                aria-label="Resize the list"
                                onPointerDown={width.onPointerDown}
                                onKeyDown={width.onKeyDown}
                                onDoubleClick={width.reset}
                                className="absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize touch-none outline-none select-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 hover:after:bg-primary focus-visible:after:bg-primary @3xl:block"
                            />
                        </TooltipTrigger>
                        <TooltipContent side="right">
                            Drag to resize, double-click to reset
                        </TooltipContent>
                    </Tooltip>
                </aside>
                <section
                    aria-label="Details"
                    className="min-w-0 flex-1 px-6 py-6 @3xl:overflow-y-auto"
                >
                    {detail}
                </section>
            </div>
            <AlreadyAddedDialog
                source={already}
                onOpenChange={(open) => !open && setAlready(null)}
                onOpen={(source) => {
                    setQuery("");
                    select({ kind: "source", id: source.id });
                }}
            />
            <MakeDatasetDialog
                sources={making}
                onOpenChange={(open) => !open && setMaking(null)}
                onCreated={async (dataset) => {
                    setPicked({ scope: "", ids: [] });
                    await created(dataset);
                }}
            />
            <TreeActionDialogs
                action={action}
                index={index}
                sources={sourceList}
                onClose={() => {
                    setAction(null);
                    focusTreeRow();
                }}
                onSelect={select}
                onRemove={(removal) => remove.mutateAsync(removal)}
            />
            <AddFolderDialog
                open={adding === "folder"}
                roots={roots.data?.roots ?? []}
                onOpenChange={(open) => setAdding(open ? "folder" : null)}
                onAdded={onUploaded}
            />
            <AddS3Dialog
                open={adding === "s3"}
                onOpenChange={(open) => setAdding(open ? "s3" : null)}
                onAdded={onUploaded}
            />
            <AddDatabaseDialog
                open={adding === "database"}
                onOpenChange={(open) => setAdding(open ? "database" : null)}
                onAdded={onUploaded}
            />
            <AddLakehouseDialog
                open={adding === "lakehouse"}
                roots={roots.data?.roots ?? []}
                onOpenChange={(open) => setAdding(open ? "lakehouse" : null)}
                onAdded={onUploaded}
            />
        </div>
    );
}
