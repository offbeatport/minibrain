import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
    ChevronRight,
    CopyPlus,
    FolderOpen,
    GraduationCap,
    MoreHorizontal,
    Pencil,
    Play,
    Plug,
    Power,
    PowerOff,
    Replace,
    SquarePlus,
    Trash2,
} from "lucide-react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Link,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { Fragment, type ReactElement, type ReactNode, useState } from "react";
import type { BaseModelDetail, ModelDetail, ModelRow } from "~/api/client";
import { keys, useAllModels } from "~/api/queries";
import { CopyButton } from "~/components/CopyButton";
import { HarnessConfigs } from "~/components/HarnessConfigs";
import { PublisherLogo } from "~/components/PublisherLogo";
import { StatusText, type Tone } from "~/components/models/StatusText";
import { useCan } from "~/lib/access";
import { percent } from "~/lib/format";
import { modelPageHref, modelTrainHref, playgroundHref } from "~/lib/modelLinks";
import { modelsHref } from "~/lib/modelsSearch";
import { beingDeleted, busyTearingDown, deleteModel, rowId, setDeployed } from "~/lib/teardown";
import { DeleteModelsDialog } from "../DeleteModelsDialog";
import { DuplicateModelDialog } from "../DuplicateModelDialog";
import { SwitchBaseDialog } from "../SwitchBaseDialog";
import { ConfirmAction, type Confirmation, EditModelDialog, useModelsRefresh } from "../dialogs";
import type { Entry } from "../entries";
import { parametersText } from "./facts";

export type Fact = ReactElement | null | false;

export function Inline({ items }: { items: Fact[] }) {
    const shown = items.filter((item): item is ReactElement => Boolean(item));
    return (
        <>
            {shown.map((item, index) => (
                <Fragment key={item.key}>
                    {index > 0 && (
                        <span aria-hidden="true" className="text-faint">
                            ·
                        </span>
                    )}
                    {item}
                </Fragment>
            ))}
        </>
    );
}

export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
    return (
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm">
            {items.map((item, index) => (
                <Fragment key={`${index}-${item.label}`}>
                    {index > 0 && (
                        <ChevronRight aria-hidden="true" className="size-3.5 text-faint" />
                    )}
                    {item.href ? (
                        <Link
                            href={item.href}
                            className="text-muted-foreground hover:text-foreground hover:underline"
                        >
                            {item.label}
                        </Link>
                    ) : (
                        <span aria-current="page">{item.label}</span>
                    )}
                </Fragment>
            ))}
        </nav>
    );
}

export function modelCrumbs(row: ModelRow, more: { label: string; href?: string }[] = []) {
    return [
        { label: "Models", href: modelsHref() },
        { label: row.name, href: more.length > 0 ? modelPageHref(row.key) : undefined },
        ...more,
    ];
}

export function Tip({ tip, children }: { tip: ReactNode; children: ReactNode }) {
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

export function CompactHeader({
    icon,
    title,
    facts,
    subtitle,
    actions,
}: {
    icon?: ReactNode;
    title: ReactNode;
    facts?: Fact[];
    subtitle?: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <header className="flex flex-wrap items-center gap-4 py-4">
            {icon}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
                    <h1 className="text-2xl leading-tight font-normal">{title}</h1>
                    {facts && (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
                            <Inline items={facts} />
                        </div>
                    )}
                </div>
                {subtitle && <p className="text-muted-foreground">{subtitle}</p>}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
    );
}

const DEPLOYMENT: Record<ModelRow["deployment"]["state"], { tone: Tone; label: string }> = {
    running: { tone: "success", label: "Deployed" },
    starting: { tone: "info", label: "Starting" },
    unhealthy: { tone: "destructive", label: "Unhealthy" },
    stopping: { tone: "info", label: "Stopping" },
    stop_failed: { tone: "destructive", label: "Stop failed" },
    not_deployed: { tone: "neutral", label: "Not deployed" },
};

export function isDeployed(row: ModelRow): boolean {
    return row.deployment.state !== "not_deployed";
}

export function nextVersion(row: ModelRow): number {
    return Math.max(0, ...(row.versions ?? []).map((version) => version.number + 1));
}

function trimmed(text: string): string {
    return text.trim().replace(/\.$/, "");
}

export function baseNameOf(rows: ModelRow[] | undefined, key: string | null | undefined): string {
    return rows?.find((item) => item.key === key)?.name ?? key ?? "";
}

function liveText(row: ModelRow): string | null {
    if (row.kind !== "custom" || row.current_version === null || !isDeployed(row)) {
        return null;
    }
    const score = row.score === null || row.score === undefined ? "" : ` ${percent(row.score)}`;
    return `v${row.current_version} live${score}`;
}

function subtitleOf(row: ModelRow, base: BaseModelDetail | undefined, baseName: string): string {
    if (row.kind === "custom") {
        return [row.description ? trimmed(row.description) : null, `On ${baseName}`]
            .filter(Boolean)
            .join(" · ");
    }
    return [
        row.description ? trimmed(row.description) : null,
        base?.publisher ?? row.publisher,
        base?.parameters ? `${parametersText(base.parameters)} parameters` : null,
        base?.license_name ?? base?.license,
    ]
        .filter(Boolean)
        .join(" · ");
}

export function ModelAvatar({ row, size = "md" }: { row: ModelRow; size?: "sm" | "md" | "lg" }) {
    return (
        <PublisherLogo
            publisher={row.kind === "base" ? row.publisher : null}
            name={row.name}
            size={size}
        />
    );
}

export function ModelHeader({
    row,
    detail,
    base,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    base: BaseModelDetail | undefined;
}) {
    const models = useAllModels();
    const status = DEPLOYMENT[row.deployment.state];
    const live = liveText(row);
    const baseName = baseNameOf(models.data, row.base_model);
    return (
        <CompactHeader
            icon={<ModelAvatar row={row} size="lg" />}
            title={row.name}
            facts={[
                <Badge key="kind" variant="outline">
                    {row.kind === "custom" ? "Custom" : "Base"}
                </Badge>,
                <StatusText key="deployed" tone={status.tone}>
                    {status.label}
                </StatusText>,
                live ? <span key="live">{live}</span> : null,
            ]}
            subtitle={subtitleOf(row, base, baseName)}
            actions={<HeaderActions row={row} detail={detail} base={base} />}
        />
    );
}

function PlaygroundButton({ row }: { row: ModelRow }) {
    if (!row.can_test) {
        return (
            <Tip
                tip={
                    row.kind === "custom"
                        ? "Nothing to try yet: make a version first."
                        : "Its weights are not ready on this install."
                }
            >
                <Button variant="outline" disabled>
                    <Play />
                    Playground
                </Button>
            </Tip>
        );
    }
    return (
        <Button variant="outline" asChild>
            <Link href={playgroundHref(row.key)}>
                <Play />
                Playground
            </Link>
        </Button>
    );
}

function HeaderActions({
    row,
    detail,
    base,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    base: BaseModelDetail | undefined;
}) {
    const can = useCan();
    const [connecting, setConnecting] = useState(false);
    return (
        <>
            <PlaygroundButton row={row} />
            <Button variant="outline" onClick={() => setConnecting(true)}>
                <Plug />
                Connect
            </Button>
            {can.build && <ModelMenu row={row} detail={detail} base={base} />}
            <ConnectDialog row={row} open={connecting} onOpenChange={setConnecting} />
        </>
    );
}

function BlockedItem({
    icon,
    label,
    blocked,
    onSelect,
}: {
    icon: ReactNode;
    label: string;
    blocked: string | null;
    onSelect: () => void;
}) {
    return (
        <DropdownMenuItem
            disabled={Boolean(blocked)}
            className={blocked ? "items-start [&>svg]:mt-0.5" : undefined}
            onSelect={onSelect}
        >
            {icon}
            <span className="flex flex-col">
                <span>{label}</span>
                {blocked && (
                    <span className="text-sm whitespace-normal text-muted-foreground">
                        {blocked}
                    </span>
                )}
            </span>
        </DropdownMenuItem>
    );
}

export function trainBlock(row: ModelRow, detail: ModelDetail | undefined): string | null {
    const serveOnly = detail?.serve_only ?? row.serve_only;
    if (serveOnly) {
        return serveOnly.reason;
    }
    if (detail && !detail.dataset_version) {
        return "Add training data first: training needs examples.";
    }
    if (beingDeleted(row)) {
        return "It is being deleted.";
    }
    return null;
}

function deployBlock(row: ModelRow, base: BaseModelDetail | undefined): string | null {
    if (busyTearingDown(row)) {
        return row.teardown?.label ?? "Busy";
    }
    if (row.kind === "base" && base && base.availability.state !== "available") {
        return "Its weights are not ready yet.";
    }
    if (row.health) {
        return row.health.label;
    }
    return null;
}

export function deployConfirmation(
    row: ModelRow,
    deployed: boolean,
    after: () => Promise<unknown>,
): Confirmation {
    const answeredBy =
        row.kind === "custom" && row.current_version !== null
            ? `, answered by v${row.current_version}`
            : "";
    return {
        title: deployed ? `Undeploy ${row.name}?` : `Deploy ${row.name}?`,
        description: deployed ? (
            <p>{`Apps calling ${row.key} get errors at once. Its ${row.kind === "base" ? "files" : "versions"} and keys stay.`}</p>
        ) : (
            <p>
                It becomes callable as <span className="font-mono">{row.key}</span>
                {answeredBy}.
            </p>
        ),
        confirmLabel: deployed ? `Undeploy ${row.name}` : `Deploy ${row.name}`,
        destructive: deployed,
        run: () => setDeployed(row, !deployed).then(after),
    };
}

function ModelMenu({
    row,
    detail,
    base,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    base: BaseModelDetail | undefined;
}) {
    const router = useRouter();
    const can = useCan();
    const refresh = useModelsRefresh();
    const client = useQueryClient();
    const models = useAllModels();
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [editing, setEditing] = useState(false);
    const [duplicating, setDuplicating] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [deleting, setDeleting] = useState<Entry[] | null>(null);
    const custom = row.kind === "custom";
    const deployed = isDeployed(row);
    const reload = async () => {
        await refresh();
        await client.invalidateQueries({ queryKey: keys.modelPage(row.key) });
    };
    const moveTo = (detail?.serve_only ?? row.serve_only)?.switch_to ?? null;
    const canDelete = custom || can.admin;
    const canRename = custom || can.admin;
    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="outline"
                        size="icon"
                        aria-label={`More actions for ${row.name}`}
                    >
                        <MoreHorizontal />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuGroup>
                        {deployed ? (
                            <BlockedItem
                                icon={<PowerOff />}
                                label="Undeploy"
                                blocked={
                                    busyTearingDown(row) ? (row.teardown?.label ?? null) : null
                                }
                                onSelect={() =>
                                    setConfirmation(deployConfirmation(row, true, reload))
                                }
                            />
                        ) : (
                            <BlockedItem
                                icon={<Power />}
                                label="Deploy"
                                blocked={deployBlock(row, base)}
                                onSelect={() =>
                                    setConfirmation(deployConfirmation(row, false, reload))
                                }
                            />
                        )}
                        {custom && (
                            <BlockedItem
                                icon={<GraduationCap />}
                                label={`Train v${nextVersion(row)}`}
                                blocked={trainBlock(row, detail)}
                                onSelect={() => router.history.push(modelTrainHref(row.key))}
                            />
                        )}
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                        {canRename && (
                            <DropdownMenuItem
                                disabled={beingDeleted(row)}
                                onSelect={() => setEditing(true)}
                            >
                                <Pencil />
                                Rename
                            </DropdownMenuItem>
                        )}
                        {custom ? (
                            <>
                                <DropdownMenuItem
                                    disabled={beingDeleted(row)}
                                    onSelect={() => setDuplicating(true)}
                                >
                                    <CopyPlus />
                                    Duplicate
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    disabled={beingDeleted(row)}
                                    onSelect={() => setSwitching(true)}
                                >
                                    <Replace />
                                    {moveTo ? `Move to ${moveTo.name}` : "Switch base"}
                                </DropdownMenuItem>
                            </>
                        ) : (
                            <>
                                <DropdownMenuItem
                                    onSelect={() =>
                                        router.history.push(
                                            `/models/new?base=${encodeURIComponent(row.key)}`,
                                        )
                                    }
                                >
                                    <SquarePlus />
                                    Add a model on it
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    onSelect={() =>
                                        router.history.push(modelPageHref(row.key, "files"))
                                    }
                                >
                                    <FolderOpen />
                                    View files
                                </DropdownMenuItem>
                            </>
                        )}
                    </DropdownMenuGroup>
                    {canDelete && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                variant="destructive"
                                disabled={beingDeleted(row)}
                                onSelect={() =>
                                    setDeleting([{ key: rowId(row), model: row, version: null }])
                                }
                            >
                                <Trash2 />
                                Delete model
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
            <EditModelDialog
                row={editing ? row : null}
                onOpenChange={(open) => !open && setEditing(false)}
            />
            {custom && (
                <>
                    <DuplicateModelDialog
                        row={duplicating ? row : null}
                        onOpenChange={(open) => !open && setDuplicating(false)}
                    />
                    <SwitchBaseDialog
                        row={switching ? row : null}
                        preferred={moveTo?.key ?? null}
                        onOpenChange={(open) => !open && setSwitching(false)}
                    />
                </>
            )}
            <DeleteModelsDialog
                chosen={deleting}
                rows={models.data ?? []}
                onOpenChange={(open) => !open && setDeleting(null)}
                onDelete={async (cascade, cancelJobs) => {
                    await deleteModel(row, { cascade, undeploy: true, cancelJobs });
                    await refresh();
                    router.history.push(modelsHref());
                }}
            />
        </>
    );
}

function Copyable({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex min-w-0 flex-col gap-label">
            <span className="text-sm text-muted-foreground">{label}</span>
            <span className="flex h-8 min-w-0 items-center gap-1 rounded-md border bg-muted pr-0.5 pl-3">
                <span className="flex-1 truncate font-mono text-sm">{value}</span>
                <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} />
            </span>
        </div>
    );
}

export function ConnectDialog({
    row,
    open,
    onOpenChange,
    keyValue = null,
}: {
    row: ModelRow;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    keyValue?: string | null;
}) {
    const baseUrl = `${window.location.origin}/v1`;
    const pinned = row.kind === "custom" ? (row.current_version ?? row.ready_version) : null;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{`Connect to ${row.name}`}</DialogTitle>
                    <DialogDescription>
                        {row.kind === "custom"
                            ? `OpenAI-compatible. ${row.key} answers with the live version; ${row.key}@N calls one version, live or not.`
                            : `OpenAI-compatible. Call it as ${row.key}.`}
                    </DialogDescription>
                </DialogHeader>
                {!isDeployed(row) && (
                    <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2">
                        {`${row.name} is not deployed, so these calls are refused until you deploy it.`}
                    </p>
                )}
                <div className="grid gap-field sm:grid-cols-[3fr_2fr_2fr]">
                    <Copyable label="Base URL" value={baseUrl} />
                    <Copyable label="Model" value={row.key} />
                    {pinned !== null && pinned !== undefined && (
                        <Copyable label="One version" value={`${row.key}@${pinned}`} />
                    )}
                </div>
                <HarnessConfigs baseUrl={baseUrl} model={row.key} keyValue={keyValue} />
                <DialogFooter>
                    <Button variant="outline" asChild>
                        <Link
                            href={modelPageHref(row.key, "api")}
                            onClick={() => onOpenChange(false)}
                        >
                            API keys
                        </Link>
                    </Button>
                    <Button onClick={() => onOpenChange(false)}>Done</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
