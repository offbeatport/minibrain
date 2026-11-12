import type { ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    DataGrid,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import { usePerson } from "~/api/authQueries";
import { type KeyCreated, type KeyInfo, type ModelRef, api, succeed } from "~/api/client";
import { useCan } from "~/lib/access";
import { exactTime, relativeTime } from "~/lib/time";
import { ConfirmAction, type Confirmation } from "~/pages/models/dialogs";
import { KeyDialog, type KeyEditing, useRefreshKeys } from "./KeyDialog";
import { NewSecret } from "./NewSecret";
import { type Choice, ScopeCell, useChoiceIndex } from "./scope";

export const KEY_STATUS: Record<
    KeyInfo["status"],
    { label: string; variant: "success" | "warning" | "destructive" }
> = {
    active: { label: "Active", variant: "success" },
    no_access: { label: "No access", variant: "warning" },
    expired: { label: "Expired", variant: "destructive" },
};

function revokeConfirmation(key: KeyInfo, run: () => Promise<unknown>): Confirmation {
    const reach = key.all_models
        ? "every model"
        : key.models.map((model) => model.name).join(", ") || "any model";
    return {
        title: `Revoke ${key.name}?`,
        description: (
            <p>{`Apps using ${key.prefix}… stop reaching ${reach} within a second. This cannot be undone.`}</p>
        ),
        confirmLabel: "Revoke key",
        destructive: true,
        run,
    };
}

function KeyMenu({
    item,
    onEdit,
    onRevoke,
}: {
    item: KeyInfo;
    onEdit?: () => void;
    onRevoke: () => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={`Actions for key ${item.name}`}>
                    <MoreHorizontal />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
                {onEdit && (
                    <>
                        <DropdownMenuItem onSelect={onEdit}>
                            <Pencil />
                            Edit scope
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                    </>
                )}
                <DropdownMenuItem variant="destructive" onSelect={onRevoke}>
                    <Trash2 />
                    Revoke
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function Moment({ value, empty }: { value: string | null | undefined; empty: string }) {
    if (!value) {
        return <span className="text-muted-foreground">{empty}</span>;
    }
    return (
        <time dateTime={value} title={exactTime(value)} className="tabular-nums">
            {relativeTime(value)}
        </time>
    );
}

function columns(index: Map<string, Choice>, me: string | null): ColumnDef<KeyInfo, unknown>[] {
    return [
        {
            header: "Name",
            id: "name",
            accessorFn: (key) => key.name,
            size: 220,
            cell: ({ row }) => (
                <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-medium">{row.original.name}</span>
                    <span className="shrink-0 font-mono text-sm text-muted-foreground">
                        {`${row.original.prefix}…`}
                    </span>
                </span>
            ),
        },
        {
            header: "Scope",
            id: "scope",
            enableSorting: false,
            size: 300,
            cell: ({ row }) => <ScopeCell item={row.original} index={index} />,
        },
        {
            header: "Created by",
            id: "created_by",
            accessorFn: (key) => key.created_by ?? "",
            size: 180,
            cell: ({ row }) => {
                const by = row.original.created_by;
                if (!by) {
                    return <span className="text-muted-foreground">Unknown</span>;
                }
                return <span className="truncate">{by === me ? "You" : by}</span>;
            },
        },
        {
            header: "Created",
            id: "created",
            accessorFn: (key) => key.created_at,
            size: 120,
            cell: ({ row }) => <Moment value={row.original.created_at} empty="" />,
        },
        {
            header: "Last used",
            id: "used",
            accessorFn: (key) => key.last_used_at ?? "",
            size: 120,
            cell: ({ row }) => <Moment value={row.original.last_used_at} empty="Never" />,
        },
        {
            header: "Expires",
            id: "expires",
            accessorFn: (key) => key.expires_at ?? "~",
            size: 120,
            cell: ({ row }) => <Moment value={row.original.expires_at} empty="Never" />,
        },
        {
            header: "Status",
            id: "status",
            accessorFn: (key) => key.status,
            size: 136,
            cell: ({ row }) => {
                const status = KEY_STATUS[row.original.status];
                return <Badge variant={status.variant}>{status.label}</Badge>;
            },
        },
    ];
}

export function KeysTable({
    rows,
    loading,
    empty,
    storageKey,
    onEdit,
    onRevoke,
}: {
    rows: KeyInfo[];
    loading: boolean;
    empty: ReactNode;
    storageKey: string;
    onEdit: (key: KeyInfo) => void;
    onRevoke: (key: KeyInfo) => void;
}) {
    const index = useChoiceIndex();
    const person = usePerson();
    const can = useCan();
    const me = person ? (person.email ?? person.name) : null;
    return (
        <DataGrid
            columns={columns(index, me)}
            rows={rows}
            getRowId={(key) => String(key.id)}
            loading={loading}
            storageKey={storageKey}
            empty={empty}
            minWidth="min-w-[1080px]"
            rowActions={(key) => (
                <KeyMenu
                    item={key}
                    onEdit={key.all_models && !can.admin ? undefined : () => onEdit(key)}
                    onRevoke={() => onRevoke(key)}
                />
            )}
        />
    );
}

export function useKeyManager(onCreated?: (key: KeyCreated) => void, secretActions?: ReactNode) {
    const refresh = useRefreshKeys();
    const [editing, setEditing] = useState<KeyEditing | null>(null);
    const [created, setCreated] = useState<KeyCreated | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const revoke = (key: KeyInfo) =>
        setConfirmation(
            revokeConfirmation(key, async () => {
                await succeed(
                    api.DELETE("/api/keys/{key_id}", { params: { path: { key_id: key.id } } }),
                );
                await refresh();
            }),
        );
    const dialogs = (
        <>
            <NewSecret created={created} onDismiss={() => setCreated(null)} extra={secretActions} />
            <KeyDialog
                editing={editing}
                onOpenChange={(open) => !open && setEditing(null)}
                onCreated={(key) => {
                    setCreated(key);
                    onCreated?.(key);
                }}
            />
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
        </>
    );
    return {
        create: (models: ModelRef[] = []) => setEditing({ mode: "create", models }),
        edit: (key: KeyInfo) => setEditing({ mode: "edit", key }),
        revoke,
        dialogs,
    };
}
