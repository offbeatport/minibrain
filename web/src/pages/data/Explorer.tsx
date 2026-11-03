import { useRouter, useRouterState } from "@tanstack/react-router";
import {
    Cloud,
    Database,
    FileBraces,
    FileSpreadsheet,
    FileText,
    Folder,
    FolderUp,
    Import,
    Layers,
    Snowflake,
    Table2,
} from "lucide-react";
import {
    Button,
    EmptyState,
    Link,
    SearchInput,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    Tree,
    type TreeNode,
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
import type { DatasetSummary, SourceSummary } from "~/api/client";
import { type DatasetFolder, useDatasetFolders, useFolderRoots } from "~/api/dataQueries";
import { useDatasets, useSources } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Stat } from "~/components/Section";
import { count } from "~/lib/format";
import { bytes } from "~/lib/time";
import { type AddKind, AddSourceMenu } from "./AddSource";
import { AddDatabaseDialog, AddIcebergDialog, AddS3Dialog, ConnectedGroup } from "./Connected";
import { CreateDataset, DatasetDetail } from "./DatasetDetail";
import { DatasetsRoot, FolderDetail, folderOf, useMoveItem } from "./DatasetFolders";
import { FileDetail } from "./FileDetail";
import { AddFolderDialog, FoldersGroup } from "./Folders";
import { SourcesOverview } from "./Sources";
import {
    DATASETS_GROUP,
    type FolderIndex,
    type ItemRef,
    SOURCES_GROUP,
    SOURCE_KINDS,
    type SourceKind,
    datasetText,
    datasetsInside,
    folderIndex,
    itemHref,
    itemKey,
    parseItem,
    siblingNamed,
    sourceText,
    usesSource,
} from "./catalogue";
import { useDataRefresh } from "./parts";

const WIDTH_KEY = "minibrain.data.treeWidth";
const DEFAULT_WIDTH = 288;
const MIN_WIDTH = 200;
const MAX_WIDTH = 520;
const WIDTH_STEP = 16;
const DEFAULT_ITEM: ItemRef = DATASETS_GROUP;

const GROUP_ICONS: Record<SourceKind, ReactNode> = {
    upload: <FolderUp />,
    folder: <Folder />,
    s3: <Cloud />,
    database: <Database />,
    iceberg: <Snowflake />,
};

const SOURCE_ICONS: Partial<Record<SourceKind, ReactNode>> = {
    folder: <Folder />,
    s3: <Cloud />,
    database: <Database />,
    iceberg: <Snowflake />,
};

function fileIcon(filename: string): ReactNode {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
        return <FileSpreadsheet />;
    }
    if (/\.(json|jsonl|ndjson)$/.test(lower)) {
        return <FileBraces />;
    }
    return <FileText />;
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
    const sourceGroups = SOURCE_KINDS.flatMap(({ kind, label }) => {
        const members = sources.filter((source) => source.kind === kind);
        if (members.length === 0) {
            return [];
        }
        return [
            {
                id: itemKey({ kind: "group", id: kind }),
                label,
                icon: GROUP_ICONS[kind],
                meta: members.length,
                children: members.map((source) => ({
                    id: itemKey({ kind: "source", id: source.id }),
                    label: source.name,
                    icon: SOURCE_ICONS[source.kind] ?? fileIcon(source.filename),
                })),
            },
        ];
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
    for (const { kind, label } of SOURCE_KINDS) {
        index.set(itemKey({ kind: "group", id: kind }), label.toLowerCase());
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
    onUploaded,
    onAdd,
}: {
    kind: SourceKind;
    sources: SourceSummary[];
    datasets: DatasetSummary[];
    onUploaded: (source: SourceSummary) => void;
    onAdd: (kind: AddKind) => void;
}) {
    const members = sources.filter((source) => source.kind === kind);
    const ids = new Set(members.map((source) => source.id));
    const built = datasets.filter((dataset) =>
        dataset.sources.some((source) => ids.has(source.id)),
    );
    if (kind === "folder") {
        return <FoldersGroup sources={sources} datasets={datasets} onAdded={onUploaded} />;
    }
    if (kind !== "upload") {
        return (
            <ConnectedGroup
                kind={kind}
                sources={sources}
                datasets={datasets}
                onAdd={() => onAdd(kind)}
            />
        );
    }
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
            {members.length === 0 ? (
                <EmptyState
                    variant="panel"
                    title="No files yet"
                    className="mx-0 mt-0"
                    action={
                        <div className="mt-3 flex justify-center">
                            <AddSourceMenu onUploaded={onUploaded} onAdd={onAdd} />
                        </div>
                    }
                >
                    Upload a CSV, TSV, JSON Lines or Parquet file, or add one of the samples. Then
                    make a dataset from it under Datasets.
                </EmptyState>
            ) : (
                <p className="text-sm text-muted-foreground">
                    Pick a file to see its columns, rows and the datasets that read it. Each file is
                    a table in dataset SQL, under the name shown on it.
                </p>
            )}
        </div>
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
    const roots = useFolderRoots();
    const treeBox = useRef<HTMLDivElement>(null);
    const loading = sources.isLoading || datasets.isLoading || folders.isLoading;
    const sourceList = useMemo(() => sources.data ?? [], [sources.data]);
    const datasetList = useMemo(() => datasets.data ?? [], [datasets.data]);
    const folderList = useMemo(() => folders.data ?? [], [folders.data]);
    const wanted = requested ?? DEFAULT_ITEM;
    const emptyGroup =
        !loading &&
        wanted.kind === "group" &&
        wanted.id !== "datasets" &&
        wanted.id !== "sources" &&
        !sourceList.some((source) => source.kind === wanted.id);
    const selected = emptyGroup ? SOURCES_GROUP : wanted;
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
        if (emptyGroup) {
            router.history.replace(itemHref(SOURCES_GROUP));
        }
    }, [emptyGroup, router]);

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
        const folder = item.kind === "folder" ? index.byId.get(item.id) : undefined;
        return !folder || !siblingNamed(index, into, folder.name, folder.id);
    };

    const onUploaded = (source: SourceSummary) => {
        setQuery("");
        router.history.replace(itemHref({ kind: "source", id: source.id }));
        setCreatingFor(source.id);
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
                        onCreate={() => setCreatingFor("new")}
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
                <SourcesOverview
                    sources={sourceList}
                    datasets={datasetList}
                    onUploaded={onUploaded}
                    onAdd={add}
                    onSelect={select}
                />
            );
        } else if (selected.kind === "group") {
            detail = (
                <GroupDetail
                    kind={selected.id as SourceKind}
                    sources={sourceList}
                    datasets={datasetList}
                    onUploaded={onUploaded}
                    onAdd={add}
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
                        onCreate={() => setCreatingFor(selectedKey)}
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
                    actions={<AddSourceMenu onUploaded={onUploaded} onAdd={add} />}
                />
                <ErrorLine error={sources.error ?? datasets.error ?? folders.error} />
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
                        <ErrorLine error={move.error} />
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
                                    empty={
                                        <p className="p-3 text-sm text-muted-foreground">
                                            Nothing matches. Search looks in names, column names,
                                            descriptions and tags.
                                        </p>
                                    }
                                />
                                {!text && sourceList.length === 0 && (
                                    <p className="pr-3 pb-3 pl-11 text-sm text-muted-foreground">
                                        No sources yet. Use Add source to upload a file or connect a
                                        folder, bucket or database.
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
            <AddIcebergDialog
                open={adding === "iceberg"}
                onOpenChange={(open) => setAdding(open ? "iceberg" : null)}
                onAdded={onUploaded}
            />
        </div>
    );
}
