import { useMutation } from "@tanstack/react-query";
import { ConfirmDialog } from "obp-ui";
import { type DatasetSummary, type SourceSummary, api, succeed, unwrap } from "~/api/client";
import type { DatasetFolder } from "~/api/dataQueries";
import {
    MoveDialog,
    type MoveTarget,
    NameDialog,
    NewFolderDialog,
    RenameFolderDialog,
    folderRef,
    removalText,
} from "./DatasetFolders";
import { type FolderIndex, type ItemRef, folderPath } from "./catalogue";
import { useDataRefresh } from "./parts";

export type TreeAction =
    | { kind: "new-folder"; parentId: number | null }
    | { kind: "rename-folder"; folder: DatasetFolder }
    | { kind: "rename-dataset"; dataset: DatasetSummary }
    | { kind: "rename-source"; source: SourceSummary }
    | { kind: "move"; target: MoveTarget }
    | { kind: "delete-folder"; folder: DatasetFolder }
    | { kind: "delete-dataset"; dataset: DatasetSummary }
    | { kind: "delete-source"; source: SourceSummary };

export type Removal =
    | { kind: "folder"; folder: DatasetFolder }
    | { kind: "dataset"; dataset: DatasetSummary }
    | { kind: "source"; source: SourceSummary };

function removedRef(removal: Removal): ItemRef {
    if (removal.kind === "folder") {
        return { kind: "folder", id: removal.folder.id };
    }
    if (removal.kind === "dataset") {
        return { kind: "dataset", id: removal.dataset.slug };
    }
    return { kind: "source", id: removal.source.id };
}

function parentRef(removal: Removal): ItemRef {
    if (removal.kind === "folder") {
        return folderRef(removal.folder.parent_id);
    }
    if (removal.kind === "dataset") {
        return folderRef(removal.dataset.folder_id ?? null);
    }
    return { kind: "group", id: removal.source.kind };
}

function sameItem(a: ItemRef, b: ItemRef): boolean {
    return a.kind === b.kind && a.id === b.id;
}

export function useRemoveItem(selected: ItemRef, onSelect: (item: ItemRef) => void) {
    const refresh = useDataRefresh();
    return useMutation({
        mutationFn: (removal: Removal) => {
            if (removal.kind === "folder") {
                return succeed(
                    api.DELETE("/api/dataset-folders/{folder_id}", {
                        params: { path: { folder_id: removal.folder.id } },
                    }),
                );
            }
            if (removal.kind === "dataset") {
                return succeed(
                    api.DELETE("/api/datasets/{slug}", {
                        params: { path: { slug: removal.dataset.slug } },
                    }),
                );
            }
            return succeed(
                api.DELETE("/api/sources/{source_id}", {
                    params: { path: { source_id: removal.source.id } },
                }),
            );
        },
        onSuccess: async (_result, removal) => {
            if (sameItem(selected, removedRef(removal))) {
                onSelect(parentRef(removal));
            }
            await refresh();
        },
    });
}

function removalCopy(action: TreeAction, index: FolderIndex) {
    if (action.kind === "delete-folder") {
        return {
            title: `Delete ${action.folder.name}?`,
            description: removalText(index, action.folder),
            confirmLabel: "Delete folder",
            removal: { kind: "folder", folder: action.folder } as Removal,
        };
    }
    if (action.kind === "delete-dataset") {
        return {
            title: `Delete ${action.dataset.name}?`,
            description: "The query goes; the sources it reads stay.",
            confirmLabel: "Delete",
            removal: { kind: "dataset", dataset: action.dataset } as Removal,
        };
    }
    if (action.kind === "delete-source") {
        return {
            title: `Delete ${action.source.name}?`,
            description:
                action.source.kind === "upload"
                    ? "The stored copy and its staged table go. This cannot be undone."
                    : "minibrain stops reading it; the data stays where it is.",
            confirmLabel: "Delete",
            removal: { kind: "source", source: action.source } as Removal,
        };
    }
    return null;
}

export function TreeActionDialogs({
    action,
    index,
    onClose,
    onSelect,
    onRemove,
}: {
    action: TreeAction | null;
    index: FolderIndex;
    onClose: () => void;
    onSelect: (item: ItemRef) => void;
    onRemove: (removal: Removal) => Promise<unknown>;
}) {
    const refresh = useDataRefresh();
    const close = (open: boolean) => {
        if (!open) {
            onClose();
        }
    };
    const removal = action ? removalCopy(action, index) : null;
    const renaming = action?.kind === "rename-dataset" ? action.dataset : null;
    const renamingSource = action?.kind === "rename-source" ? action.source : null;
    return (
        <>
            <NewFolderDialog
                open={action?.kind === "new-folder"}
                parentId={action?.kind === "new-folder" ? action.parentId : null}
                index={index}
                onOpenChange={close}
                onCreated={(created) => onSelect({ kind: "folder", id: created.id })}
            />
            {action?.kind === "rename-folder" && (
                <RenameFolderDialog
                    open
                    folder={action.folder}
                    index={index}
                    onOpenChange={close}
                />
            )}
            <NameDialog
                open={renaming !== null}
                title="Rename dataset"
                description={
                    renaming
                        ? `In ${folderPath(index, renaming.folder_id ?? null)}. Models that use it keep using it.`
                        : ""
                }
                initial={renaming?.name ?? ""}
                submitLabel="Rename"
                problem={() => null}
                onOpenChange={close}
                onSubmit={async (name) => {
                    if (renaming) {
                        await unwrap(
                            api.PATCH("/api/datasets/{slug}", {
                                params: { path: { slug: renaming.slug } },
                                body: { name },
                            }),
                        );
                        await refresh();
                    }
                }}
            />
            <NameDialog
                open={renamingSource !== null}
                title="Rename source"
                description={
                    renamingSource
                        ? `Its table stays ${renamingSource.table}, so dataset SQL keeps working.`
                        : ""
                }
                initial={renamingSource?.name ?? ""}
                submitLabel="Rename"
                problem={() => null}
                onOpenChange={close}
                onSubmit={async (name) => {
                    if (renamingSource) {
                        await unwrap(
                            api.PATCH("/api/sources/{source_id}", {
                                params: { path: { source_id: renamingSource.id } },
                                body: { name },
                            }),
                        );
                        await refresh();
                    }
                }}
            />
            <MoveDialog
                target={action?.kind === "move" ? action.target : null}
                index={index}
                onOpenChange={close}
            />
            {removal && (
                <ConfirmDialog
                    open
                    onOpenChange={close}
                    title={removal.title}
                    description={removal.description}
                    confirmLabel={removal.confirmLabel}
                    destructive
                    onConfirm={() => onRemove(removal.removal).catch(() => undefined)}
                />
            )}
        </>
    );
}
