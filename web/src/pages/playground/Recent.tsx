import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import {
    Button,
    ConfirmDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Field,
    Input,
    SearchInput,
    Skeleton,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
    useToast,
} from "obp-ui";
import { type FormEvent, useEffect, useState } from "react";
import { useChats, useDeleteChat, useSaveChat } from "~/api/playgroundQueries";
import { ErrorLine } from "~/components/Section";
import type { ChatSummary } from "~/lib/playground";
import { relativeTime } from "~/lib/time";

const PLACEHOLDERS = ["first", "second", "third", "fourth"];

function matches(chat: ChatSummary, filter: string): boolean {
    const wanted = filter.trim().toLowerCase();
    return !wanted || `${chat.title} ${chat.model}`.toLowerCase().includes(wanted);
}

function RenameDialog({ chat, onClose }: { chat: ChatSummary | null; onClose: () => void }) {
    const save = useSaveChat();
    const [title, setTitle] = useState("");
    useEffect(() => {
        setTitle(chat?.title ?? "");
        save.reset();
    }, [chat, save.reset]);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (chat && title.trim()) {
            save.mutate({ id: chat.id, title: title.trim() }, { onSuccess: onClose });
        }
    };
    return (
        <Dialog open={chat !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-md">
                <form onSubmit={submit} className="flex flex-col gap-6">
                    <DialogHeader>
                        <DialogTitle>Rename chat</DialogTitle>
                        <DialogDescription>
                            The name shows in your Recent list; only you see it.
                        </DialogDescription>
                    </DialogHeader>
                    <Field id="chat-title" label="Name">
                        <Input
                            id="chat-title"
                            value={title}
                            maxLength={120}
                            onChange={(event) => setTitle(event.target.value)}
                            autoFocus
                        />
                    </Field>
                    <ErrorLine error={save.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={save.isPending || !title.trim()}>
                            Rename
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function ChatActions({
    chat,
    onRename,
    onDelete,
}: {
    chat: ChatSummary;
    onRename: () => void;
    onDelete: () => void;
}) {
    const label = `Actions for ${chat.title}`;
    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-xs" aria-label={label}>
                            <MoreHorizontal aria-hidden="true" />
                        </Button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>Actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-40">
                <DropdownMenuItem onSelect={onRename}>
                    <Pencil />
                    Rename
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                    <Trash2 />
                    Delete
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function ChatRow({
    chat,
    current,
    onOpen,
    onRename,
    onDelete,
}: {
    chat: ChatSummary;
    current: boolean;
    onOpen: () => void;
    onRename: () => void;
    onDelete: () => void;
}) {
    return (
        <li
            className={cn(
                "flex items-center gap-1 rounded-md pr-1",
                current ? "bg-accent text-accent-foreground" : "hover:bg-secondary",
            )}
        >
            <button
                type="button"
                onClick={onOpen}
                aria-current={current ? "true" : undefined}
                className="flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
                <span className="truncate text-sm">{chat.title}</span>
                <span className="truncate text-sm text-muted-foreground">
                    {`${relativeTime(chat.updated_at)} · `}
                    <span className="font-mono">{chat.model}</span>
                </span>
            </button>
            <ChatActions chat={chat} onRename={onRename} onDelete={onDelete} />
        </li>
    );
}

export function Recent({
    current,
    note,
    onOpen,
    onNew,
    onDeleted,
    busy,
    titled = true,
}: {
    current: number | null;
    note: string | null;
    onOpen: (id: number) => void;
    onNew: () => void;
    onDeleted: (id: number) => void;
    busy: boolean;
    titled?: boolean;
}) {
    const toast = useToast();
    const chats = useChats();
    const remove = useDeleteChat();
    const [filter, setFilter] = useState("");
    const [renaming, setRenaming] = useState<ChatSummary | null>(null);
    const [deleting, setDeleting] = useState<ChatSummary | null>(null);
    const items = chats.data ?? [];
    const shown = items.filter((chat) => matches(chat, filter));
    return (
        <div className="flex min-h-0 flex-col">
            <div className="flex flex-col gap-3 border-b px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                    {titled && <h2 className="text-base font-semibold">Recent</h2>}
                    <Button size="sm" variant="outline" onClick={onNew} disabled={busy}>
                        New chat
                    </Button>
                </div>
                {items.length > 0 && (
                    <SearchInput
                        value={filter}
                        onValueChange={setFilter}
                        placeholder="Filter chats"
                        aria-label="Filter chats"
                    />
                )}
                {note && <p className="text-sm text-muted-foreground">{note}</p>}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {chats.isLoading && (
                    <div className="flex flex-col gap-2 p-2">
                        {PLACEHOLDERS.map((name) => (
                            <Skeleton key={name} className="h-10 w-full" />
                        ))}
                    </div>
                )}
                {chats.data && items.length === 0 && (
                    <p className="p-2 text-sm text-muted-foreground">
                        Your chats appear here as you send them, for you alone.
                    </p>
                )}
                {items.length > 0 && shown.length === 0 && (
                    <p className="p-2 text-sm text-muted-foreground">
                        No chat matches {filter.trim()}.
                    </p>
                )}
                {shown.length > 0 && (
                    <ul className="flex flex-col gap-0.5" aria-label="Recent chats">
                        {shown.map((chat) => (
                            <ChatRow
                                key={chat.id}
                                chat={chat}
                                current={chat.id === current}
                                onOpen={() => onOpen(chat.id)}
                                onRename={() => setRenaming(chat)}
                                onDelete={() => setDeleting(chat)}
                            />
                        ))}
                    </ul>
                )}
                <ErrorLine error={chats.error ?? remove.error} />
            </div>
            <RenameDialog chat={renaming} onClose={() => setRenaming(null)} />
            <ConfirmDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                title={`Delete ${deleting?.title ?? "this chat"}?`}
                description="The conversation and its settings are deleted for good."
                confirmLabel="Delete"
                destructive
                onConfirm={() =>
                    deleting &&
                    remove
                        .mutateAsync(deleting.id)
                        .then(() => {
                            onDeleted(deleting.id);
                            toast({ title: "Chat deleted", tone: "success" });
                        })
                        .catch(() => undefined)
                }
            />
        </div>
    );
}
