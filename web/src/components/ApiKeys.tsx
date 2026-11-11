import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { KeyRound, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import {
    Button,
    Checkbox,
    CodeBlock,
    DataGrid,
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
    Label,
} from "obp-ui";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type KeyCreated, type KeyInfo, type ModelRef, api, succeed, unwrap } from "~/api/client";
import { keys, useAllModels, useKeys } from "~/api/queries";
import { ErrorLine, PanelSection } from "~/components/Section";
import { relativeTime } from "~/lib/time";
import { ConfirmAction, type Confirmation } from "~/pages/models/dialogs";

type Choice = ModelRef & { name: string };

const idOf = (ref: ModelRef) => `${ref.kind}:${ref.key}`;

function refOf(id: string): ModelRef {
    const [kind, ...rest] = id.split(":");
    return { kind: kind === "base" ? "base" : "custom", key: rest.join(":") };
}

function useChoices(): Choice[] {
    const { data } = useAllModels();
    return useMemo(
        () =>
            (data ?? [])
                .map((row) => ({ kind: row.kind, key: row.key, name: row.name }))
                .sort((a, b) => a.name.localeCompare(b.name)),
        [data],
    );
}

function useRefreshKeys() {
    const client = useQueryClient();
    return () =>
        Promise.all([
            client.invalidateQueries({ queryKey: keys.apiKeys }),
            client.invalidateQueries({ queryKey: keys.allModels }),
        ]);
}

function ModelChecklist({
    choices,
    picked,
    onToggle,
}: {
    choices: Choice[];
    picked: Set<string>;
    onToggle: (id: string, on: boolean) => void;
}) {
    if (choices.length === 0) {
        return <p className="text-muted-foreground">Add or download a model first.</p>;
    }
    return (
        <div className="flex max-h-72 flex-col divide-y overflow-y-auto rounded-md border">
            {choices.map((choice) => {
                const id = idOf(choice);
                return (
                    <Label key={id} className="flex items-center gap-3 px-3 py-2 font-normal">
                        <Checkbox
                            checked={picked.has(id)}
                            onCheckedChange={(value) => onToggle(id, value === true)}
                        />
                        <span className="min-w-0 flex-1 truncate">{choice.name}</span>
                        <span className="truncate font-mono text-sm text-muted-foreground">
                            {choice.key}
                        </span>
                    </Label>
                );
            })}
        </div>
    );
}

export type KeyEditing = { mode: "create"; models: ModelRef[] } | { mode: "edit"; key: KeyInfo };

function nameProblem(
    name: string,
    picked: Set<string>,
    existing: KeyInfo[],
    choices: Choice[],
): string | null {
    const wanted = name.trim().toLowerCase();
    if (!wanted) {
        return "Name the key, so you can tell its calls apart in the logs.";
    }
    const clash = existing.find(
        (key) =>
            key.name.trim().toLowerCase() === wanted &&
            key.models.some((model) => picked.has(idOf(model))),
    );
    if (!clash) {
        return null;
    }
    const model = clash.models.find((item) => picked.has(idOf(item)));
    const label = choices.find((choice) => model && idOf(choice) === idOf(model))?.name;
    return `A key called ${clash.name} already calls ${label ?? model?.name ?? "one of these models"}.`;
}

function KeyDialog({
    editing,
    onOpenChange,
    onCreated,
}: {
    editing: KeyEditing | null;
    onOpenChange: (open: boolean) => void;
    onCreated: (key: KeyCreated) => void;
}) {
    const refresh = useRefreshKeys();
    const choices = useChoices();
    const existing = useKeys();
    const [touched, setTouched] = useState(false);
    const [name, setName] = useState("");
    const [picked, setPicked] = useState<Set<string>>(new Set());
    useEffect(() => {
        if (editing?.mode === "edit") {
            setName(editing.key.name);
            setPicked(new Set(editing.key.models.map(idOf)));
        } else if (editing) {
            setName("");
            setTouched(false);
            setPicked(new Set(editing.models.map(idOf)));
        }
    }, [editing]);
    const save = useMutation({
        mutationFn: async () => {
            const models = [...picked].map(refOf);
            if (editing?.mode === "edit") {
                await unwrap(
                    api.PUT("/api/keys/{key_id}/models", {
                        params: { path: { key_id: editing.key.id } },
                        body: { models },
                    }),
                );
                return;
            }
            onCreated(await unwrap(api.POST("/api/keys", { body: { name: name.trim(), models } })));
        },
        onSuccess: async () => {
            await refresh();
            onOpenChange(false);
        },
    });
    const toggle = (id: string, on: boolean) =>
        setPicked((current) => {
            const next = new Set(current);
            if (on) {
                next.add(id);
            } else {
                next.delete(id);
            }
            return next;
        });
    const creating = editing?.mode !== "edit";
    const problem = creating ? nameProblem(name, picked, existing.data ?? [], choices) : null;
    return (
        <Dialog open={editing !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        setTouched(true);
                        if (!problem) {
                            save.mutate();
                        }
                    }}
                    noValidate
                    className="contents"
                >
                    <DialogHeader>
                        <DialogTitle>
                            {creating ? "Create key" : `Models for ${editing?.key.name}`}
                        </DialogTitle>
                        <DialogDescription>
                            {creating
                                ? "The key can call only the models you pick. The full key is shown once."
                                : "Apps using this key lose access to models you clear, within a second."}
                        </DialogDescription>
                    </DialogHeader>
                    {creating && (
                        <Field
                            id="key-name"
                            label="Name"
                            hint="Shown in the key list, the request log and Callers."
                            error={touched || name ? (problem ?? undefined) : undefined}
                        >
                            <Input
                                id="key-name"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                onBlur={() => setTouched(true)}
                                placeholder="helpdesk-app"
                                maxLength={60}
                                required
                                autoFocus
                                aria-invalid={Boolean((touched || name) && problem)}
                            />
                        </Field>
                    )}
                    <div className="flex flex-col gap-1">
                        <span className="font-medium">Models</span>
                        <ModelChecklist choices={choices} picked={picked} onToggle={toggle} />
                    </div>
                    <ErrorLine error={save.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={
                                picked.size === 0 || save.isPending || (touched && Boolean(problem))
                            }
                        >
                            {creating ? "Create key" : "Save"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function NewSecret({
    created,
    onDismiss,
    extra,
}: {
    created: KeyCreated | null;
    onDismiss: () => void;
    extra?: ReactNode;
}) {
    return (
        <Dialog open={created !== null} onOpenChange={(open) => !open && onDismiss()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>Copy your key now</DialogTitle>
                    <DialogDescription>
                        {`${created?.name ?? "The key"} is shown once. Store it where your app reads its secrets.`}
                    </DialogDescription>
                </DialogHeader>
                <CodeBlock code={created?.secret ?? ""} copyLabel="Copy the key" wrap />
                <DialogFooter>
                    {extra}
                    <Button onClick={onDismiss}>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function covers(key: KeyInfo, scope: ModelRef): boolean {
    return key.models.some((model) => model.kind === scope.kind && model.key === scope.key);
}

function revokeConfirmation(key: KeyInfo, run: () => Promise<unknown>): Confirmation {
    const names = key.models.map((model) => model.name).join(", ");
    return {
        title: `Revoke ${key.name}?`,
        description: (
            <p>{`Apps using ${key.prefix}… stop reaching ${names || "any model"} within a second. This cannot be undone.`}</p>
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
    onEdit: () => void;
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
                <DropdownMenuItem onSelect={onEdit}>
                    <Pencil />
                    Change models
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onRevoke}>
                    <Trash2 />
                    Revoke
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function columns(
    onEdit: (key: KeyInfo) => void,
    onRevoke: (key: KeyInfo) => void,
): ColumnDef<KeyInfo, unknown>[] {
    return [
        { header: "Name", id: "name", cell: ({ row }) => row.original.name },
        {
            header: "Key",
            id: "prefix",
            cell: ({ row }) => <span className="font-mono">{`${row.original.prefix}…`}</span>,
        },
        {
            header: "Models",
            id: "models",
            cell: ({ row }) => {
                const names = row.original.models.map((model) => model.name).join(", ");
                return (
                    <span className="line-clamp-2 max-w-72" title={names}>
                        {names || <span className="text-muted-foreground">None</span>}
                    </span>
                );
            },
        },
        {
            header: "Created",
            id: "created",
            cell: ({ row }) => (
                <span className="tabular-nums">{`${relativeTime(row.original.created_at)}`}</span>
            ),
        },
        {
            header: "Last used",
            id: "used",
            cell: ({ row }) =>
                row.original.last_used_at ? (
                    relativeTime(row.original.last_used_at)
                ) : (
                    <span className="text-muted-foreground">Never</span>
                ),
        },
        {
            header: "Expires",
            id: "expires",
            cell: ({ row }) =>
                row.original.expires_at ? (
                    relativeTime(row.original.expires_at)
                ) : (
                    <span className="text-muted-foreground">Never</span>
                ),
        },
        {
            header: () => <span className="sr-only">Actions</span>,
            id: "actions",
            cell: ({ row }) => (
                <KeyMenu
                    item={row.original}
                    onEdit={() => onEdit(row.original)}
                    onRevoke={() => onRevoke(row.original)}
                />
            ),
        },
    ];
}

export function ApiKeys({
    scope,
    onCreated,
    secretActions,
    description,
}: {
    scope?: ModelRef;
    onCreated?: (key: KeyCreated) => void;
    secretActions?: ReactNode;
    description?: ReactNode;
}) {
    const list = useKeys();
    const refresh = useRefreshKeys();
    const [editing, setEditing] = useState<KeyEditing | null>(null);
    const [created, setCreated] = useState<KeyCreated | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const rows = (list.data ?? []).filter((key) => !scope || covers(key, scope));
    const revoke = (key: KeyInfo) =>
        setConfirmation(
            revokeConfirmation(key, async () => {
                await succeed(
                    api.DELETE("/api/keys/{key_id}", { params: { path: { key_id: key.id } } }),
                );
                await refresh();
            }),
        );
    const table = columns((key) => setEditing({ mode: "edit", key }), revoke);
    return (
        <PanelSection
            icon={KeyRound}
            title="API keys"
            description={
                description ??
                (scope
                    ? "Keys that can call this model. One key can cover several models."
                    : undefined)
            }
            actions={
                <Button
                    onClick={() => setEditing({ mode: "create", models: scope ? [scope] : [] })}
                >
                    <KeyRound aria-hidden="true" />
                    Create key
                </Button>
            }
            bare
        >
            <div className="flex flex-col gap-3">
                <ErrorLine error={list.error} />
                <DataGrid columns={table} rows={rows} empty="No keys yet." />
            </div>
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
        </PanelSection>
    );
}
