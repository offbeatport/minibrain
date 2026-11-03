import { useMutation } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import {
    ChevronDown,
    Cloud,
    Database,
    FileBraces,
    FileSpreadsheet,
    FileText,
    Folder,
    FolderUp,
    Table2,
} from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    EmptyState,
    Link,
    SearchInput,
    Tree,
    type TreeNode,
    ancestorsOf,
    filterTree,
} from "obp-ui";
import {
    type CSSProperties,
    type ChangeEvent,
    type KeyboardEvent,
    type PointerEvent,
    type ReactNode,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { type DatasetSummary, type SourceSummary, api, unwrap, uploadFile } from "~/api/client";
import { useDatasets, useSamples, useSources } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Stat } from "~/components/Section";
import { DATA_FILE_TYPES } from "~/lib/dataFiles";
import { count } from "~/lib/format";
import { bytes } from "~/lib/time";
import { DatasetDetail } from "./DatasetDetail";
import { FileDetail } from "./FileDetail";
import {
    type ItemRef,
    SOURCE_KINDS,
    type SourceKind,
    datasetText,
    itemHref,
    itemKey,
    kindLabel,
    parseItem,
    sourceText,
} from "./catalogue";
import { useDataRefresh } from "./parts";

const WIDTH_KEY = "minibrain.data.treeWidth";
const DEFAULT_WIDTH = 288;
const MIN_WIDTH = 200;
const MAX_WIDTH = 520;
const WIDTH_STEP = 16;
const DEFAULT_ITEM: ItemRef = { kind: "group", id: "upload" };

const GROUP_ICONS: Record<SourceKind, ReactNode> = {
    upload: <FolderUp />,
    folder: <Folder />,
    s3: <Cloud />,
    database: <Database />,
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

function buildTree(sources: SourceSummary[], datasets: DatasetSummary[]): TreeNode[] {
    const bySource = new Map<number, DatasetSummary[]>();
    for (const dataset of datasets) {
        bySource.set(dataset.source_id, [...(bySource.get(dataset.source_id) ?? []), dataset]);
    }
    return SOURCE_KINDS.map(({ kind, label }) => {
        const members = sources.filter((source) => source.kind === kind);
        return {
            id: itemKey({ kind: "group", id: kind }),
            label,
            icon: GROUP_ICONS[kind],
            meta: members.length,
            children: members.map((source) => ({
                id: itemKey({ kind: "source", id: source.id }),
                label: source.name,
                icon: fileIcon(source.filename),
                children: (bySource.get(source.id) ?? []).map((dataset) => ({
                    id: itemKey({ kind: "dataset", id: dataset.slug }),
                    label: dataset.name,
                    icon: <Table2 />,
                })),
            })),
        };
    });
}

function searchIndex(sources: SourceSummary[], datasets: DatasetSummary[]): Map<string, string> {
    const index = new Map<string, string>();
    for (const { kind, label } of SOURCE_KINDS) {
        index.set(itemKey({ kind: "group", id: kind }), label.toLowerCase());
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

function UploadButton({
    label = "Upload file",
    variant,
    onUploaded,
}: {
    label?: string;
    variant?: "default" | "outline";
    onUploaded: (source: SourceSummary) => void;
}) {
    const refresh = useDataRefresh();
    const upload = useMutation({
        mutationFn: uploadFile,
        onSuccess: async (source) => {
            await refresh();
            onUploaded(source);
        },
    });
    const choose = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            upload.mutate(file);
        }
        event.target.value = "";
    };
    return (
        <div className="flex flex-col items-end gap-1">
            <Button asChild variant={variant}>
                <label className="cursor-pointer">
                    {upload.isPending ? "Uploading…" : label}
                    <input
                        type="file"
                        className="sr-only"
                        accept={DATA_FILE_TYPES}
                        onChange={choose}
                        disabled={upload.isPending}
                    />
                </label>
            </Button>
            <ErrorLine error={upload.error} />
        </div>
    );
}

function SampleMenu({ onUploaded }: { onUploaded: (source: SourceSummary) => void }) {
    const samples = useSamples();
    const refresh = useDataRefresh();
    const add = useMutation({
        mutationFn: (file: string) =>
            unwrap(api.POST("/api/samples/{file}", { params: { path: { file } } })),
        onSuccess: async (source) => {
            await refresh();
            onUploaded(source);
        },
    });
    return (
        <div className="flex flex-col items-end gap-1">
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="outline" disabled={add.isPending}>
                        {add.isPending ? "Adding…" : "Add sample data"}
                        <ChevronDown />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-80">
                    {(samples.data ?? []).map((sample) => (
                        <DropdownMenuItem
                            key={sample.file}
                            onSelect={() => add.mutate(sample.file)}
                            className="flex-col items-start gap-0.5"
                        >
                            <span className="font-medium">{sample.name}</span>
                            <span className="text-sm text-muted-foreground tabular-nums">
                                {`${sample.format} · ${count(sample.rows)} rows · ${count(sample.labels)} labels`}
                            </span>
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
            <ErrorLine error={add.error ?? samples.error} />
        </div>
    );
}

function DataActions({ onUploaded }: { onUploaded: (source: SourceSummary) => void }) {
    return (
        <div className="flex flex-wrap items-start gap-2">
            <SampleMenu onUploaded={onUploaded} />
            <UploadButton onUploaded={onUploaded} />
        </div>
    );
}

function GroupDetail({
    kind,
    sources,
    datasets,
    onUploaded,
}: {
    kind: SourceKind;
    sources: SourceSummary[];
    datasets: DatasetSummary[];
    onUploaded: (source: SourceSummary) => void;
}) {
    const members = sources.filter((source) => source.kind === kind);
    const ids = new Set(members.map((source) => source.id));
    const built = datasets.filter((dataset) => ids.has(dataset.source_id));
    if (kind !== "upload") {
        return (
            <div className="flex flex-col gap-4">
                <h2 className="text-2xl font-semibold">{kindLabel(kind)}</h2>
                <EmptyState variant="panel" title="Not available yet" className="mx-0 mt-0">
                    {`Reading ${kind === "database" ? "a database" : kind === "s3" ? "an S3 bucket" : "a folder"} in place comes later. Upload a CSV, TSV, JSON Lines or Parquet file for now.`}
                </EmptyState>
            </div>
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
                            <DataActions onUploaded={onUploaded} />
                        </div>
                    }
                >
                    Upload a CSV, TSV, JSON Lines or Parquet file, or add one of the samples. Then
                    pick the column a model reads and the column it answers with to make a dataset.
                </EmptyState>
            ) : (
                <p className="text-sm text-muted-foreground">
                    Pick a file to see its columns and rows, or a dataset to see its mapping and
                    label balance.
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
            {`No ${item.kind === "dataset" ? "dataset" : "file"} matches this link. It may have been deleted.`}
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
    const width = useTreeWidth();
    const [query, setQuery] = useState("");
    const [collapsed, setCollapsed] = useState<string[]>([]);
    const [creatingFor, setCreatingFor] = useState<number | null>(null);
    const treeBox = useRef<HTMLDivElement>(null);
    const selected = requested ?? DEFAULT_ITEM;
    const selectedKey = itemKey(selected);
    const sourceList = useMemo(() => sources.data ?? [], [sources.data]);
    const datasetList = useMemo(() => datasets.data ?? [], [datasets.data]);
    const nodes = useMemo(() => buildTree(sourceList, datasetList), [sourceList, datasetList]);
    const index = useMemo(() => searchIndex(sourceList, datasetList), [sourceList, datasetList]);
    const branches = useMemo(() => allBranches(nodes), [nodes]);
    const text = query.trim().toLowerCase();
    const filtered = useMemo(
        () =>
            text ? filterTree(nodes, (node) => index.get(node.id)?.includes(text) ?? false) : null,
        [nodes, index, text],
    );
    const expanded = branches.filter((id) => !collapsed.includes(id));
    const matches = text
        ? [...index.entries()].filter(
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

    const loading = sources.isLoading || datasets.isLoading;
    let detail: ReactNode = null;
    if (!loading) {
        if (selected.kind === "group") {
            detail = (
                <GroupDetail
                    kind={selected.id}
                    sources={sourceList}
                    datasets={datasetList}
                    onUploaded={onUploaded}
                />
            );
        } else if (selected.kind === "source") {
            const source = sourceList.find((item) => item.id === selected.id);
            detail = source ? (
                <FileDetail
                    key={selectedKey}
                    source={source}
                    datasets={datasetList.filter((dataset) => dataset.source_id === source.id)}
                    creating={creatingFor === source.id}
                    onCreating={(on) => setCreatingFor(on ? source.id : null)}
                    onSelect={select}
                />
            ) : (
                <Missing item={selected} />
            );
        } else {
            const dataset = datasetList.find((item) => item.slug === selected.id);
            detail = dataset ? (
                <DatasetDetail
                    key={selectedKey}
                    dataset={dataset}
                    source={sourceList.find((source) => source.id === dataset.source_id)}
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
                    caption="Files, the datasets built from them and the models that train on them."
                    actions={<DataActions onUploaded={onUploaded} />}
                />
                <ErrorLine error={sources.error ?? datasets.error} />
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
                    </div>
                    <div ref={treeBox} className="min-h-0 flex-1 overflow-y-auto">
                        {loading ? (
                            <p className="p-3 text-sm text-muted-foreground">Loading…</p>
                        ) : (
                            <Tree
                                aria-label="Sources and datasets"
                                nodes={filtered?.nodes ?? nodes}
                                selectedId={selectedKey}
                                onSelect={onSelectKey}
                                expandedIds={
                                    filtered ? [...expanded, ...filtered.expandedIds] : expanded
                                }
                                onExpandedChange={(next) =>
                                    setCollapsed(branches.filter((id) => !next.includes(id)))
                                }
                                empty={
                                    <p className="p-3 text-sm text-muted-foreground">
                                        Nothing matches. Search looks in names, column names,
                                        descriptions and tags.
                                    </p>
                                }
                            />
                        )}
                    </div>
                    <button
                        type="button"
                        aria-label="Resize the list"
                        title="Drag to resize, double-click to reset"
                        onPointerDown={width.onPointerDown}
                        onKeyDown={width.onKeyDown}
                        onDoubleClick={width.reset}
                        className="absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize touch-none outline-none select-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 hover:after:bg-primary focus-visible:after:bg-primary @3xl:block"
                    />
                </aside>
                <section
                    aria-label="Details"
                    className="min-w-0 flex-1 px-6 py-6 @3xl:overflow-y-auto"
                >
                    {detail}
                </section>
            </div>
        </div>
    );
}
