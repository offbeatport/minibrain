import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { KeyRound, MoreHorizontal, Users } from "lucide-react";
import {
    Badge,
    Button,
    DataGrid,
    DataGridDetail,
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
    FieldGroup,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    SettingsGroup,
    SettingsRow,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { type FormEvent, useEffect, useState } from "react";
import {
    type AccountInfo,
    type PasswordLink,
    type Role,
    authKeys,
    useAccounts,
    usePerson,
    useSession,
} from "~/api/authQueries";
import { api, unwrap } from "~/api/client";
import { CopyButton } from "~/components/CopyButton";
import { ErrorLine, PanelSection, PanelSections } from "~/components/Section";
import { SettingsLayout } from "~/components/SettingsLayout";
import { ROLE_LABELS, SOURCE_LABELS } from "~/lib/access";
import { relativeTime } from "~/lib/time";
import { AdminForm } from "~/pages/auth/AuthPages";

type RoleChoice = Role | "none";

const ROLE_CHOICES: { value: RoleChoice; label: string; description: string }[] = [
    { value: "viewer", label: "Viewer", description: "Sees models, scores and deployments" },
    { value: "builder", label: "Builder", description: "Also works with data, trains and deploys" },
    { value: "admin", label: "Admin", description: "Also runs security, accounts and settings" },
    { value: "none", label: "No role", description: "Signs in but sees nothing" },
];

function useRefreshAccounts() {
    const client = useQueryClient();
    return () => client.invalidateQueries({ queryKey: authKeys.accounts });
}

function RoleSelect({
    id,
    value,
    onChange,
    allowNone,
}: {
    id: string;
    value: RoleChoice;
    onChange: (value: RoleChoice) => void;
    allowNone: boolean;
}) {
    return (
        <Select value={value} onValueChange={(next) => onChange(next as RoleChoice)}>
            <SelectTrigger id={id} className="w-full">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {ROLE_CHOICES.filter((choice) => allowNone || choice.value !== "none").map(
                    (choice) => (
                        <SelectItem key={choice.value} value={choice.value}>
                            {choice.label}
                        </SelectItem>
                    ),
                )}
            </SelectContent>
        </Select>
    );
}

function roleHint(value: RoleChoice): string {
    return ROLE_CHOICES.find((choice) => choice.value === value)?.description ?? "";
}

function AddPersonDialog({
    open,
    onOpenChange,
    onLink,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onLink: (link: PasswordLink) => void;
}) {
    const refresh = useRefreshAccounts();
    const [email, setEmail] = useState("");
    const [name, setName] = useState("");
    const [role, setRole] = useState<RoleChoice>("builder");
    useEffect(() => {
        if (open) {
            setEmail("");
            setName("");
            setRole("builder");
        }
    }, [open]);
    const add = useMutation({
        mutationFn: () =>
            unwrap(
                api.POST("/api/accounts", {
                    body: { email, name, role: role === "none" ? "viewer" : role },
                }),
            ),
        onSuccess: async (link) => {
            await refresh();
            onLink(link);
            onOpenChange(false);
        },
    });
    const submit = (event: FormEvent) => {
        event.preventDefault();
        add.mutate();
    };
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <form onSubmit={submit} className="contents">
                    <DialogHeader>
                        <DialogTitle>Add person</DialogTitle>
                        <DialogDescription>
                            They get a link to choose their own password. You see the link once.
                        </DialogDescription>
                    </DialogHeader>
                    <FieldGroup>
                        <Field id="person-email" label="Email">
                            <Input
                                id="person-email"
                                type="email"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                required
                                autoFocus
                            />
                        </Field>
                        <Field id="person-name" label="Name">
                            <Input
                                id="person-name"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </Field>
                        <Field id="person-role" label="Role" hint={roleHint(role)}>
                            <RoleSelect
                                id="person-role"
                                value={role}
                                onChange={setRole}
                                allowNone={false}
                            />
                        </Field>
                    </FieldGroup>
                    <ErrorLine error={add.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={add.isPending}>
                            Add person
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function EditPersonDialog({
    person,
    onOpenChange,
}: {
    person: AccountInfo | null;
    onOpenChange: (open: boolean) => void;
}) {
    const refresh = useRefreshAccounts();
    const [name, setName] = useState("");
    const [role, setRole] = useState<RoleChoice>("viewer");
    useEffect(() => {
        if (person) {
            setName(person.name);
            setRole(person.role ?? "none");
        }
    }, [person]);
    const save = useMutation({
        mutationFn: () =>
            unwrap(
                api.PATCH("/api/accounts/{account_id}", {
                    params: { path: { account_id: person?.id ?? 0 } },
                    body: person?.role_locked ? { name } : { name, role },
                }),
            ),
        onSuccess: async () => {
            await refresh();
            onOpenChange(false);
        },
    });
    const submit = (event: FormEvent) => {
        event.preventDefault();
        save.mutate();
    };
    return (
        <Dialog open={person !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <form onSubmit={submit} className="contents">
                    <DialogHeader>
                        <DialogTitle>{`Edit ${person?.email ?? person?.name ?? ""}`}</DialogTitle>
                        <DialogDescription>
                            A new role applies to their next request.
                        </DialogDescription>
                    </DialogHeader>
                    <FieldGroup>
                        <Field id="edit-name" label="Name">
                            <Input
                                id="edit-name"
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </Field>
                        <Field
                            id="edit-role"
                            label="Role"
                            hint={
                                person?.role_locked
                                    ? "Set by their identity provider groups in minibrain.yaml."
                                    : roleHint(role)
                            }
                        >
                            {person?.role_locked ? (
                                <Input
                                    id="edit-role"
                                    value={person.role ? ROLE_LABELS[person.role] : "No role"}
                                    readOnly
                                    disabled
                                />
                            ) : (
                                <RoleSelect
                                    id="edit-role"
                                    value={role}
                                    onChange={setRole}
                                    allowNone
                                />
                            )}
                        </Field>
                    </FieldGroup>
                    <ErrorLine error={save.error} />
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={save.isPending}>
                            Save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function LinkNotice({ link, onDismiss }: { link: PasswordLink; onDismiss: () => void }) {
    const url = `${window.location.origin}${link.path}`;
    const who = link.account.email ?? link.account.name;
    return (
        <div className="flex flex-col gap-2 rounded-md border border-success/40 bg-success-soft p-3 text-sm">
            <div className="font-semibold">
                {`Send this link to ${who}. It sets their password, works once and expires ${relativeTime(link.expires_at)}. It is not shown again.`}
            </div>
            <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all font-mono">{url}</code>
                <CopyButton value={url} label="Copy link" />
                <Button size="xs" variant="ghost" onClick={onDismiss}>
                    Done
                </Button>
            </div>
        </div>
    );
}

function StatusBadge({ person }: { person: AccountInfo }) {
    if (person.disabled) {
        return <Badge variant="neutral">Off</Badge>;
    }
    if (person.link_pending && !person.password_set) {
        return <Badge variant="info">Invited</Badge>;
    }
    if (person.role == null) {
        return <Badge variant="warning">No role</Badge>;
    }
    return <Badge variant="success">Active</Badge>;
}

function PersonMenu({
    person,
    me,
    onEdit,
    onLink,
    onToggle,
}: {
    person: AccountInfo;
    me: boolean;
    onEdit: () => void;
    onLink: () => void;
    onToggle: () => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Actions for ${person.email ?? person.name}`}
                >
                    <MoreHorizontal />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={onEdit}>Edit name and role</DropdownMenuItem>
                {person.source === "local" && !person.disabled && (
                    <DropdownMenuItem onSelect={onLink}>New password link</DropdownMenuItem>
                )}
                {!me && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            variant={person.disabled ? "default" : "destructive"}
                            onSelect={onToggle}
                        >
                            {person.disabled ? "Turn on" : "Turn off and sign out"}
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function RoleCell({ person }: { person: AccountInfo }) {
    const label = person.role ? (
        ROLE_LABELS[person.role]
    ) : (
        <span className="text-muted-foreground">None</span>
    );
    if (!person.role_locked) {
        return label;
    }
    return (
        <span className="flex items-center gap-2">
            {label}
            <Tooltip>
                <TooltipTrigger asChild>
                    <button type="button" className="rounded-sm">
                        <Badge variant="neutral">From groups</Badge>
                    </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs whitespace-normal">
                    {`Groups ${person.groups.join(", ")} map to this role in minibrain.yaml.`}
                </TooltipContent>
            </Tooltip>
        </span>
    );
}

function columns(): ColumnDef<AccountInfo, unknown>[] {
    return [
        {
            header: "Person",
            id: "name",
            accessorFn: (row) => row.name.toLowerCase(),
            cell: ({ row }) => (
                <span className="flex min-w-0 flex-col">
                    <span className="truncate">{row.original.name}</span>
                    {row.original.email && row.original.email !== row.original.name && (
                        <DataGridDetail className="truncate">{row.original.email}</DataGridDetail>
                    )}
                </span>
            ),
        },
        {
            header: "Role",
            id: "role",
            accessorFn: (row) => row.role ?? "",
            cell: ({ row }) => <RoleCell person={row.original} />,
        },
        {
            header: "Signs in with",
            id: "source",
            accessorFn: (row) => SOURCE_LABELS[row.source] ?? row.source,
        },
        {
            header: "Last sign-in",
            id: "last",
            accessorFn: (row) => row.last_sign_in_at ?? "",
            cell: ({ row }) =>
                row.original.last_sign_in_at ? (
                    relativeTime(row.original.last_sign_in_at)
                ) : (
                    <span className="text-muted-foreground">Never</span>
                ),
        },
        {
            header: "Status",
            id: "status",
            accessorFn: (row) => (row.disabled ? "off" : "on"),
            cell: ({ row }) => <StatusBadge person={row.original} />,
        },
    ];
}

function People() {
    const refresh = useRefreshAccounts();
    const me = usePerson();
    const list = useAccounts(true);
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState<AccountInfo | null>(null);
    const [link, setLink] = useState<PasswordLink | null>(null);
    const newLink = useMutation({
        mutationFn: (person: AccountInfo) =>
            unwrap(
                api.POST("/api/accounts/{account_id}/password-link", {
                    params: { path: { account_id: person.id } },
                }),
            ),
        onSuccess: async (created) => {
            setLink(created);
            await refresh();
        },
    });
    const toggle = useMutation({
        mutationFn: (person: AccountInfo) =>
            unwrap(
                api.PATCH("/api/accounts/{account_id}", {
                    params: { path: { account_id: person.id } },
                    body: { disabled: !person.disabled },
                }),
            ),
        onSuccess: refresh,
    });
    return (
        <PanelSection
            icon={Users}
            title="People"
            description="Everyone who can sign in. Turning someone off signs them out at once."
            actions={
                <Button variant="outline" onClick={() => setAdding(true)}>
                    Add person
                </Button>
            }
            bare
        >
            <div className="flex flex-col gap-3">
                {link && <LinkNotice link={link} onDismiss={() => setLink(null)} />}
                <ErrorLine error={list.error ?? newLink.error ?? toggle.error} />
                <DataGrid
                    columns={columns()}
                    rows={list.data?.people ?? []}
                    getRowId={(row) => String(row.id)}
                    loading={list.isPending}
                    empty="No accounts yet."
                    rowActions={(row) => (
                        <PersonMenu
                            person={row}
                            me={row.id === me?.id}
                            onEdit={() => setEditing(row)}
                            onLink={() => newLink.mutate(row)}
                            onToggle={() => toggle.mutate(row)}
                        />
                    )}
                />
            </div>
            <AddPersonDialog open={adding} onOpenChange={setAdding} onLink={setLink} />
            <EditPersonDialog person={editing} onOpenChange={(open) => !open && setEditing(null)} />
        </PanelSection>
    );
}

function SignInSources() {
    const session = useSession();
    const list = useAccounts(true);
    const methods = session.data?.methods;
    const info = list.data;
    const defaultRole =
        info && info.default_role !== "none" ? ROLE_LABELS[info.default_role] : "No role";
    return (
        <PanelSection
            icon={KeyRound}
            title="Sign-in and roles"
            description="Set in minibrain.yaml on the server, so they cannot be changed here."
        >
            <SettingsGroup>
                <SettingsRow
                    label="Passwords"
                    description="People an admin adds here sign in with a password they choose."
                    control={<Badge variant="success">On</Badge>}
                />
                <SettingsRow
                    label="Reverse proxy"
                    description={
                        info?.proxy_addresses.length
                            ? `Trusts user, email and groups headers from ${info.proxy_addresses.join(", ")} only.`
                            : "Add auth.proxy.addresses to sign people in from your proxy's headers."
                    }
                    control={
                        <Badge variant={methods?.proxy ? "success" : "neutral"}>
                            {methods?.proxy ? "On" : "Off"}
                        </Badge>
                    }
                />
                <SettingsRow
                    label="Role for people with no mapped group"
                    description={
                        info?.default_role_locked
                            ? "Set by auth.default_role in minibrain.yaml."
                            : "Change it under Security."
                    }
                    control={<span className="text-sm">{defaultRole}</span>}
                />
            </SettingsGroup>
            {info && info.mapping.length > 0 ? (
                <div className="mt-4 overflow-x-auto rounded-md border">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Group</TableHead>
                                <TableHead>Role</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {info.mapping.map((item) => (
                                <TableRow key={item.group}>
                                    <TableCell className="font-mono">{item.group}</TableCell>
                                    <TableCell>{ROLE_LABELS[item.role]}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            ) : (
                <p className="mt-4 text-sm text-muted-foreground">
                    No groups are mapped. auth.roles in minibrain.yaml maps identity provider groups
                    to roles.
                </p>
            )}
        </PanelSection>
    );
}

function AccountsOff() {
    return (
        <PanelSection
            icon={Users}
            title="Accounts are off"
            description="minibrain runs as one local user while it listens on this machine only. Create an admin account to turn accounts on; after that, everyone signs in."
        >
            <div className="max-w-md">
                <AdminForm submitLabel="Create admin and turn on accounts" />
            </div>
        </PanelSection>
    );
}

export function AccountsSettingsPage() {
    const session = useSession();
    const accounts = session.data?.accounts ?? false;
    return (
        <SettingsLayout title="Accounts">
            <PanelSections>
                {accounts ? <People /> : <AccountsOff />}
                {accounts && <SignInSources />}
            </PanelSections>
        </SettingsLayout>
    );
}
