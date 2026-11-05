import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Folder, FolderInput, Layers, Table2, Trash2, X } from "lucide-react";
import {
    Button,
    ConfirmDialog,
    DataGrid,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    FieldGroup,
    Input,
    Link,
    Tree,
    type TreeNode,
} from "obp-ui";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { type DatasetSummary, api, succeed, unwrap } from "~/api/client";
import { type DatasetFolder, dataKeys } from "~/api/dataQueries";
import { keys } from "~/api/queries";
import { ErrorLine, Stat } from "~/components/Section";
import { count } from "~/lib/format";
import { relativeTime } from "~/lib/time";
import {
    DATASETS_GROUP,
    type FolderIndex,
    type ItemRef,
    datasetNamed,
    datasetsInside,
    folderPath,
    folderTrail,
    insideFolder,
    itemHref,
    itemKey,
    parseItem,
    plural,
    siblingNamed,
} from "./catalogue";
import { ItemHeader, useDataRefresh } from "./parts";

export type Movable = { kind: "dataset"; id: string } | { kind: "folder"; id: number };

export type MoveTarget = { item: Movable; name: string; from: number | null };

type ContentRow = {
    key: string;
    item: ItemRef;
    name: string;
    folder: boolean;
    detail: string;
    models: number;
    updated: string | null;
};

export function folderRef(id: number | null): ItemRef {
    return id === null ? DATASETS_GROUP : { kind: "folder", id };
}

export function folderOf(item: ItemRef | null): number | null | undefined {
    if (item?.kind === "folder") {
        return item.id;
    }
    return item?.kind === "group" && item.id === "datasets" ? null : undefined;
}

export function useMoveItem() {
    const client = useQueryClient();
    const settle = () =>
        Promise.all([
            client.invalidateQueries({ queryKey: keys.datasets }),
            client.invalidateQueries({ queryKey: dataKeys.datasetFolders }),
        ]);
    return useMutation({
        mutationFn: async ({ item, into }: { item: Movable; into: number | null }) => {
            if (item.kind === "dataset") {
                await unwrap(
                    api.PUT("/api/datasets/{slug}/folder", {
                        params: { path: { slug: item.id } },
                        body: { folder_id: into },
                    }),
                );
            } else {
                await unwrap(
                    api.PUT("/api/dataset-folders/{folder_id}/parent", {
                        params: { path: { folder_id: item.id } },
                        body: { parent_id: into },
                    }),
                );
            }
        },
        onMutate: async ({ item, into }) => {
            await Promise.all([
                client.cancelQueries({ queryKey: keys.datasets, exact: true }),
                client.cancelQueries({ queryKey: dataKeys.datasetFolders }),
            ]);
            const before = {
                datasets: client.getQueryData<DatasetSummary[]>(keys.datasets),
                folders: client.getQueryData<DatasetFolder[]>(dataKeys.datasetFolders),
            };
            if (item.kind === "dataset") {
                client.setQueryData<DatasetSummary[]>(keys.datasets, (rows) =>
                    rows?.map((row) => (row.slug === item.id ? { ...row, folder_id: into } : row)),
                );
            } else {
                client.setQueryData<DatasetFolder[]>(dataKeys.datasetFolders, (rows) =>
                    rows?.map((row) => (row.id === item.id ? { ...row, parent_id: into } : row)),
                );
            }
            return before;
        },
        onError: (_error, _move, before) => {
            client.setQueryData(keys.datasets, before?.datasets);
            client.setQueryData(dataKeys.datasetFolders, before?.folders);
        },
        onSettled: settle,
    });
}

export function moveProblem(index: FolderIndex, target: MoveTarget, into: number | null) {
    if (target.item.kind === "dataset") {
        const taken = datasetNamed(index.datasets.get(into) ?? [], target.name, target.item.id);
        return taken
            ? `${folderPath(index, into)} already has a dataset called ${taken.name}`
            : null;
    }
    const taken = siblingNamed(index, into, target.name, target.item.id);
    return taken ? `${folderPath(index, into)} already has a folder called ${taken.name}` : null;
}

export function PathLinks({ index, folderId }: { index: FolderIndex; folderId: number | null }) {
    const steps = [
        { label: "Datasets", item: DATASETS_GROUP },
        ...folderTrail(index, folderId).map((folder) => ({
            label: folder.name,
            item: { kind: "folder", id: folder.id } as ItemRef,
        })),
    ];
    return (
        <>
            {steps.map((step, position) => (
                <Fragment key={itemKey(step.item)}>
                    {position > 0 && " / "}
                    <Link href={itemHref(step.item)} className="text-primary">
                        {step.label}
                    </Link>
                </Fragment>
            ))}
        </>
    );
}

export function NameDialog({
    open,
    title,
    description,
    initial,
    submitLabel,
    problem,
    onOpenChange,
    onSubmit,
}: {
    open: boolean;
    title: string;
    description: string;
    initial: string;
    submitLabel: string;
    problem: (name: string) => string | null;
    onOpenChange: (open: boolean) => void;
    onSubmit: (name: string) => Promise<unknown>;
}) {
    const [name, setName] = useState(initial);
    const save = useMutation({
        mutationFn: () => onSubmit(name.trim()),
        onSuccess: () => onOpenChange(false),
    });
    const reset = save.reset;
    useEffect(() => {
        if (open) {
            setName(initial);
            reset();
        }
    }, [open, initial, reset]);
    const clash = name.trim() ? problem(name) : null;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <form
                    className="contents"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (!clash) {
                            save.mutate();
                        }
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                        <DialogDescription>{description}</DialogDescription>
                    </DialogHeader>
                    <FieldGroup>
                        <Field id="dataset-folder-name" label="Name">
                            <Input
                                id="dataset-folder-name"
                                value={name}
                                maxLength={120}
                                autoFocus
                                aria-invalid={clash ? true : undefined}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </Field>
                    </FieldGroup>
                    <ErrorLine error={clash ?? save.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!name.trim() || !!clash || save.isPending}>
                            {submitLabel}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function NewFolderDialog({
    open,
    parentId,
    index,
    onOpenChange,
    onCreated,
}: {
    open: boolean;
    parentId: number | null;
    index: FolderIndex;
    onOpenChange: (open: boolean) => void;
    onCreated: (folder: DatasetFolder) => void;
}) {
    const refresh = useDataRefresh();
    return (
        <NameDialog
            open={open}
            title="New folder"
            description={`In ${folderPath(index, parentId)}. Folders only organise datasets; they change nothing a model trains on.`}
            initial=""
            submitLabel="Create folder"
            problem={(name) => {
                const taken = siblingNamed(index, parentId, name);
                return taken ? `There is already a folder called ${taken.name} here` : null;
            }}
            onOpenChange={onOpenChange}
            onSubmit={async (name) => {
                const folder = await unwrap(
                    api.POST("/api/dataset-folders", { body: { name, parent_id: parentId } }),
                );
                await refresh();
                onCreated(folder);
            }}
        />
    );
}

export function RenameFolderDialog({
    open,
    folder,
    index,
    onOpenChange,
}: {
    open: boolean;
    folder: DatasetFolder;
    index: FolderIndex;
    onOpenChange: (open: boolean) => void;
}) {
    const refresh = useDataRefresh();
    return (
        <NameDialog
            open={open}
            title="Rename folder"
            description={`In ${folderPath(index, folder.parent_id)}.`}
            initial={folder.name}
            submitLabel="Rename"
            problem={(name) => {
                const taken = siblingNamed(index, folder.parent_id, name, folder.id);
                return taken ? `There is already a folder called ${taken.name} here` : null;
            }}
            onOpenChange={onOpenChange}
            onSubmit={async (name) => {
                await unwrap(
                    api.PATCH("/api/dataset-folders/{folder_id}", {
                        params: { path: { folder_id: folder.id } },
                        body: { name },
                    }),
                );
                await refresh();
            }}
        />
    );
}

function folderChoices(
    index: FolderIndex,
    parent: number | null,
    blocked: Set<number>,
    current: number | null,
): TreeNode[] {
    return (index.folders.get(parent) ?? [])
        .filter((folder) => !blocked.has(folder.id))
        .map((folder) => ({
            id: itemKey({ kind: "folder", id: folder.id }),
            label: folder.name,
            icon: <Folder />,
            meta: folder.id === current ? "Current" : undefined,
            children: folderChoices(index, folder.id, blocked, current),
        }));
}

function branchIds(nodes: TreeNode[]): string[] {
    return nodes.flatMap((node) => [node.id, ...branchIds(node.children ?? [])]);
}

export function MoveDialog({
    targets,
    index,
    onOpenChange,
    onMoved,
}: {
    targets: MoveTarget[] | null;
    index: FolderIndex;
    onOpenChange: (open: boolean) => void;
    onMoved?: () => void;
}) {
    const move = useMoveItem();
    const [chosen, setChosen] = useState<string | null>(null);
    const moveAll = useMutation({
        mutationFn: async (into: number | null) => {
            for (const target of targets ?? []) {
                if (target.from !== into) {
                    await move.mutateAsync({ item: target.item, into });
                }
            }
        },
        onSuccess: () => {
            onMoved?.();
            onOpenChange(false);
        },
    });
    const reset = moveAll.reset;
    const first = targets?.[0] ?? null;
    const from = first?.from ?? null;
    const together = (targets ?? []).every((target) => target.from === from);
    const opened = targets
        ? targets.map((target) => `${target.item.kind}:${target.item.id}`).join(",")
        : null;
    useEffect(() => {
        if (opened !== null) {
            setChosen(itemKey(folderRef(from)));
            reset();
        }
    }, [opened, from, reset]);
    const folders = (targets ?? []).flatMap((target) =>
        target.item.kind === "folder" ? [target.item.id] : [],
    );
    const blocked = new Set(folders.flatMap((id) => insideFolder(index, id)));
    const nodes: TreeNode[] = [
        {
            id: itemKey(DATASETS_GROUP),
            label: "Datasets",
            icon: <Layers />,
            meta: together && from === null ? "Current" : undefined,
            children: folderChoices(index, null, blocked, from),
        },
    ];
    const into = folderOf(parseItem(chosen));
    const problem =
        into === undefined
            ? null
            : ((targets ?? [])
                  .map((target) => moveProblem(index, target, into))
                  .find((found) => found !== null) ?? null);
    const unchanged = into === undefined || (targets ?? []).every((target) => target.from === into);
    const many = (targets?.length ?? 0) > 1;
    return (
        <Dialog open={targets !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <form
                    className="contents"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (targets && into !== undefined && !unchanged && !problem) {
                            moveAll.mutate(into);
                        }
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>
                            {many
                                ? `Move ${plural(targets?.length ?? 0, "item")}`
                                : `Move ${first?.name ?? ""}`}
                        </DialogTitle>
                        <DialogDescription>
                            {`Pick the folder ${many ? "they go" : "it goes"} into.${folders.length > 0 ? " Everything inside a folder moves along." : ""}`}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="max-h-72 overflow-y-auto rounded-lg border">
                        <Tree
                            aria-label="Folders"
                            nodes={nodes}
                            selectedId={chosen}
                            onSelect={setChosen}
                            defaultExpandedIds={branchIds(nodes)}
                        />
                    </div>
                    <ErrorLine error={problem ?? moveAll.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={unchanged || !!problem || moveAll.isPending}
                        >
                            Move
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

const CONTENT_COLUMNS: ColumnDef<ContentRow, unknown>[] = [
    {
        id: "name",
        header: "Name",
        accessorKey: "name",
        cell: ({ row }) => (
            <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden="true" className="shrink-0 text-muted-foreground [&>svg]:size-4">
                    {row.original.folder ? <Folder /> : <Table2 />}
                </span>
                <Link href={itemHref(row.original.item)} className="truncate">
                    {row.original.name}
                </Link>
            </span>
        ),
    },
    {
        id: "contents",
        header: "Contents",
        accessorKey: "detail",
        cell: ({ row }) => <span className="tabular-nums">{row.original.detail}</span>,
    },
    {
        id: "models",
        header: "Models",
        accessorKey: "models",
        cell: ({ row }) => <span className="tabular-nums">{count(row.original.models)}</span>,
    },
    {
        id: "updated",
        header: "Updated",
        accessorKey: "updated",
        cell: ({ row }) => (row.original.updated ? relativeTime(row.original.updated) : "–"),
    },
];

function contentRows(index: FolderIndex, folderId: number | null): ContentRow[] {
    const folders = (index.folders.get(folderId) ?? []).map((folder) => {
        const inside = datasetsInside(index, folder.id);
        return {
            key: itemKey({ kind: "folder", id: folder.id }),
            item: { kind: "folder", id: folder.id } as ItemRef,
            name: folder.name,
            folder: true,
            detail: plural(inside.length, "dataset"),
            models: new Set(inside.flatMap((dataset) => dataset.models)).size,
            updated: null,
        };
    });
    const datasets = (index.datasets.get(folderId) ?? []).map((dataset) => ({
        key: itemKey({ kind: "dataset", id: dataset.slug }),
        item: { kind: "dataset", id: dataset.slug } as ItemRef,
        name: dataset.name,
        folder: false,
        detail: dataset.rows === null ? "–" : plural(dataset.rows, "row"),
        models: dataset.models.length,
        updated: dataset.updated_at,
    }));
    return [...folders, ...datasets];
}

function contentsLabel(rows: ContentRow[]): string {
    const folders = rows.filter((row) => row.folder).length;
    const datasets = rows.length - folders;
    return [datasets ? plural(datasets, "dataset") : "", folders ? plural(folders, "folder") : ""]
        .filter(Boolean)
        .join(" and ");
}

function removalNote(row: ContentRow): string {
    if (row.folder) {
        return `${row.detail} inside, moved up`;
    }
    return row.models > 0
        ? `Used by ${plural(row.models, "model")}; their trained versions stay`
        : row.detail;
}

function DeleteContentsDialog({
    rows,
    onOpenChange,
    onDeleted,
}: {
    rows: ContentRow[] | null;
    onOpenChange: (open: boolean) => void;
    onDeleted: () => void;
}) {
    const refresh = useDataRefresh();
    const chosen = rows ?? [];
    const remove = useMutation({
        mutationFn: async () => {
            for (const row of [...chosen].sort((a, b) => Number(a.folder) - Number(b.folder))) {
                if (row.item.kind === "folder") {
                    await succeed(
                        api.DELETE("/api/dataset-folders/{folder_id}", {
                            params: { path: { folder_id: Number(row.item.id) } },
                        }),
                    );
                } else {
                    await succeed(
                        api.DELETE("/api/datasets/{slug}", {
                            params: { path: { slug: String(row.item.id) } },
                        }),
                    );
                }
            }
        },
        onSuccess: () => {
            onDeleted();
            onOpenChange(false);
        },
        onSettled: refresh,
    });
    const folders = chosen.some((row) => row.folder);
    return (
        <Dialog open={rows !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{`Delete ${contentsLabel(chosen)}?`}</DialogTitle>
                    <DialogDescription>
                        {`Datasets go with their checks and the versions no model uses.${folders ? " A deleted folder's contents move up a level; nothing inside is deleted." : ""} This cannot be undone.`}
                    </DialogDescription>
                </DialogHeader>
                <ul className="flex max-h-64 flex-col divide-y overflow-y-auto rounded-lg border">
                    {chosen.map((row) => (
                        <li key={row.key} className="flex items-center gap-3 px-3 py-2.5">
                            <span
                                aria-hidden="true"
                                className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground [&>svg]:size-4"
                            >
                                {row.folder ? <Folder /> : <Table2 />}
                            </span>
                            <span className="flex min-w-0 flex-col">
                                <span className="truncate font-medium">{row.name}</span>
                                <span className="truncate text-sm text-muted-foreground">
                                    {removalNote(row)}
                                </span>
                            </span>
                        </li>
                    ))}
                </ul>
                <ErrorLine error={remove.error} />
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate()}
                    >
                        {remove.isPending ? "Deleting…" : `Delete ${contentsLabel(chosen)}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export function FolderContents({
    index,
    folderId,
    empty,
    onSelect,
}: {
    index: FolderIndex;
    folderId: number | null;
    empty: ReactNode;
    onSelect: (item: ItemRef) => void;
}) {
    const rows = contentRows(index, folderId);
    const [selected, setSelected] = useState<string[]>([]);
    const [moving, setMoving] = useState<MoveTarget[] | null>(null);
    const [deleting, setDeleting] = useState<ContentRow[] | null>(null);
    const [scope, setScope] = useState(folderId);
    if (scope !== folderId) {
        setScope(folderId);
        setSelected([]);
    }
    const chosen = rows.filter((row) => selected.includes(row.key));
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
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                                setMoving(
                                    chosen.map((row) => ({
                                        item: row.item as Movable,
                                        name: row.name,
                                        from: folderId,
                                    })),
                                )
                            }
                        >
                            <FolderInput />
                            Move to…
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => setDeleting(chosen)}>
                            <Trash2 />
                            Delete
                        </Button>
                    </div>
                </div>
            )}
            <DataGrid
                columns={CONTENT_COLUMNS}
                rows={rows}
                getRowId={(row) => row.key}
                sortable={false}
                onOpen={(row) => onSelect(row.item)}
                rowLabel={(row) => `${row.folder ? "Folder" : "Dataset"} ${row.name}`}
                selectedIds={selected}
                onSelectedIdsChange={setSelected}
                empty={empty}
            />
            <MoveDialog
                targets={moving}
                index={index}
                onOpenChange={(open) => !open && setMoving(null)}
                onMoved={clear}
            />
            <DeleteContentsDialog
                rows={deleting}
                onOpenChange={(open) => !open && setDeleting(null)}
                onDeleted={clear}
            />
        </div>
    );
}

export function removalText(index: FolderIndex, folder: DatasetFolder): string {
    const folders = index.folders.get(folder.id) ?? [];
    const datasets = index.datasets.get(folder.id) ?? [];
    if (folders.length + datasets.length === 0) {
        return "The folder is empty. Nothing else changes.";
    }
    const parts = [
        folders.length ? plural(folders.length, "folder") : "",
        datasets.length ? plural(datasets.length, "dataset") : "",
    ].filter(Boolean);
    const above = index.datasets.get(folder.parent_id) ?? [];
    const clash =
        folders.some((child) => siblingNamed(index, folder.parent_id, child.name, folder.id)) ||
        datasets.some((dataset) => datasetNamed(above, dataset.name, dataset.slug));
    const parent = folder.parent_id === null ? "Datasets" : folderPath(index, folder.parent_id);
    return `Its ${parts.join(" and ")} move up to ${parent}; nothing inside is deleted.${clash ? " One whose name is taken there gets a number added." : ""}`;
}

export function FolderDetail({
    folder,
    index,
    creating,
    onCreate,
    onSelect,
}: {
    folder: DatasetFolder;
    index: FolderIndex;
    creating: boolean;
    onCreate: () => void;
    onSelect: (item: ItemRef) => void;
}) {
    const refresh = useDataRefresh();
    const [dialog, setDialog] = useState<"new" | "rename" | null>(null);
    const [moving, setMoving] = useState<MoveTarget | null>(null);
    const subfolders = index.folders.get(folder.id) ?? [];
    const direct = index.datasets.get(folder.id) ?? [];
    const inside = datasetsInside(index, folder.id);
    const models = new Set(inside.flatMap((dataset) => dataset.models));
    const remove = useMutation({
        mutationFn: () =>
            succeed(
                api.DELETE("/api/dataset-folders/{folder_id}", {
                    params: { path: { folder_id: folder.id } },
                }),
            ),
        onSuccess: async () => {
            onSelect(folderRef(folder.parent_id));
            await refresh();
        },
    });
    return (
        <div className="flex flex-col gap-6">
            <ItemHeader
                title={folder.name}
                detail={
                    <>
                        {"Folder in "}
                        <PathLinks index={index} folderId={folder.parent_id} />
                    </>
                }
                actions={
                    <>
                        <Button onClick={onCreate} disabled={creating}>
                            New dataset
                        </Button>
                        <Button variant="outline" onClick={() => setDialog("new")}>
                            New folder
                        </Button>
                        <Button variant="outline" onClick={() => setDialog("rename")}>
                            Rename
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() =>
                                setMoving({
                                    item: { kind: "folder", id: folder.id },
                                    name: folder.name,
                                    from: folder.parent_id,
                                })
                            }
                        >
                            Move to…
                        </Button>
                        <ConfirmDialog
                            trigger={<Button variant="outline">Delete</Button>}
                            title={`Delete ${folder.name}?`}
                            description={removalText(index, folder)}
                            confirmLabel="Delete folder"
                            destructive
                            onConfirm={() => remove.mutateAsync().catch(() => undefined)}
                        />
                    </>
                }
            />
            <ErrorLine error={remove.error} />
            <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat label="Folders" value={count(subfolders.length)} />
                <Stat label="Datasets" value={count(direct.length)} />
                <Stat label="Datasets at all levels" value={count(inside.length)} />
                <Stat label="Models using them" value={count(models.size)} />
            </div>
            {!creating && (
                <FolderContents
                    index={index}
                    folderId={folder.id}
                    onSelect={onSelect}
                    empty={
                        <p className="text-muted-foreground">
                            Empty. Drag datasets or folders onto it in the list, or use Move to… on
                            one.
                        </p>
                    }
                />
            )}
            <NewFolderDialog
                open={dialog === "new"}
                parentId={folder.id}
                index={index}
                onOpenChange={(open) => setDialog(open ? "new" : null)}
                onCreated={(created) => onSelect({ kind: "folder", id: created.id })}
            />
            <RenameFolderDialog
                open={dialog === "rename"}
                folder={folder}
                index={index}
                onOpenChange={(open) => setDialog(open ? "rename" : null)}
            />
            <MoveDialog
                targets={moving ? [moving] : null}
                index={index}
                onOpenChange={(open) => !open && setMoving(null)}
            />
        </div>
    );
}

export function DatasetsRoot({
    datasets,
    index,
    creating,
    onCreate,
    onSelect,
}: {
    datasets: DatasetSummary[];
    index: FolderIndex;
    creating: boolean;
    onCreate: () => void;
    onSelect: (item: ItemRef) => void;
}) {
    const [naming, setNaming] = useState(false);
    const models = new Set(datasets.flatMap((dataset) => dataset.models));
    const sql = datasets.filter((dataset) => dataset.mode === "sql").length;
    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 className="text-2xl font-semibold">Datasets</h2>
                    <p className="text-sm text-muted-foreground">
                        Saved queries that turn one or more sources into input and label rows.
                        Models train on a saved version of one.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={onCreate} disabled={creating}>
                        New dataset
                    </Button>
                    <Button variant="outline" onClick={() => setNaming(true)}>
                        New folder
                    </Button>
                </div>
            </div>
            <div className="flex flex-wrap gap-x-8 gap-y-3">
                <Stat label="Datasets" value={count(datasets.length)} />
                <Stat label="Folders" value={count(index.byId.size)} />
                <Stat label="Written in SQL" value={count(sql)} />
                <Stat label="Models using them" value={count(models.size)} />
            </div>
            {!creating && (
                <FolderContents
                    index={index}
                    folderId={null}
                    onSelect={onSelect}
                    empty={
                        <p className="text-muted-foreground">
                            No datasets yet. Add a file under Sources, then pick its input and label
                            columns, or write SQL across several sources.
                        </p>
                    }
                />
            )}
            <NewFolderDialog
                open={naming}
                parentId={null}
                index={index}
                onOpenChange={setNaming}
                onCreated={(created) => onSelect({ kind: "folder", id: created.id })}
            />
        </div>
    );
}
