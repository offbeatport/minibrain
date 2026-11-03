import type { ColumnDef } from "@tanstack/react-table";
import { ListOrdered, Package } from "lucide-react";
import {
    Button,
    DataGrid,
    Label,
    Link,
    Switch,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import { useState } from "react";
import {
    type CachePlanInfo,
    type CachedBaseInfo,
    estimateDownload,
    useDownloadEstimate,
    useFreeUpSpace,
    useModelCache,
    usePinBase,
} from "~/api/cacheQueries";
import type { BaseModelDetail } from "~/api/client";
import { ErrorLine, PanelSection, Stat } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { bytes, exactTime, relativeTime } from "~/lib/time";
import { ConfirmAction, type Confirmation } from "./dialogs";

function plural(value: number, noun: string): string {
    return `${count(value)} ${noun}${value === 1 ? "" : "s"}`;
}

function names(bases: CachedBaseInfo[]): string {
    return bases.map((base) => base.name).join(", ");
}

function LastUsed({ value }: { value: string }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className="whitespace-nowrap rounded-sm tabular-nums text-muted-foreground"
                >
                    <time dateTime={value}>{relativeTime(value)}</time>
                </button>
            </TooltipTrigger>
            <TooltipContent>{exactTime(value)}</TooltipContent>
        </Tooltip>
    );
}

function RemovedList({ bases }: { bases: CachedBaseInfo[] }) {
    return (
        <ul className="flex flex-col divide-y rounded-md border text-sm text-foreground">
            {bases.map((base) => (
                <li
                    key={base.key}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 px-3 py-1.5"
                >
                    <span className="font-medium">{base.name}</span>
                    <span className="tabular-nums text-muted-foreground">
                        {`${bytes(base.size_bytes)} · used ${relativeTime(base.last_used_at)}`}
                    </span>
                </li>
            ))}
        </ul>
    );
}

export function CacheImpact({ plan, name }: { plan: CachePlanInfo; name: string }) {
    return (
        <>
            <p>
                {`Base models use ${bytes(plan.used_bytes)} of the ${bytes(plan.budget_bytes)} budget; ${name} adds ${bytes(plan.incoming_bytes)}.`}
            </p>
            {plan.evict.length > 0 && (
                <>
                    <p>
                        {`When it finishes, ${plan.evict.length === 1 ? "this base is" : "these bases are"} removed to free ${bytes(plan.freed_bytes)}. Nothing uses them, and each can be downloaded again or re-imported later.`}
                    </p>
                    <RemovedList bases={plan.evict} />
                </>
            )}
            {plan.still_over && (
                <p>
                    {`Base models then use ${bytes(plan.after_bytes)}, over the budget: the others are in use, pinned or used in the last hour.`}
                </p>
            )}
        </>
    );
}

type PendingCheck = { plan: CachePlanInfo; name: string; proceed: () => unknown };

function impactConfirmation(pending: PendingCheck): Confirmation {
    const removing = pending.plan.evict.length > 0;
    return {
        title: removing ? `Free up space for ${pending.name}?` : "Go over the base model budget?",
        description: <CacheImpact plan={pending.plan} name={pending.name} />,
        confirmLabel: removing ? "Continue and free up space" : "Continue",
        run: async () => pending.proceed(),
    };
}

export function useCacheCheck() {
    const [pending, setPending] = useState<PendingCheck | null>(null);
    const check = async (size: number | null | undefined, name: string, proceed: () => unknown) => {
        const plan = size ? await estimateDownload(size).catch(() => null) : null;
        if (!plan?.over) {
            proceed();
            return;
        }
        setPending({ plan, name, proceed });
    };
    const dialog = (
        <ConfirmAction
            confirmation={pending ? impactConfirmation(pending) : null}
            onOpenChange={(open) => !open && setPending(null)}
        />
    );
    return { check, dialog };
}

export function DownloadAgainText({
    name,
    size,
}: { name: string; size: number | null | undefined }) {
    const plan = useDownloadEstimate(size);
    return (
        <>
            <p>
                Downloads its files again from the model hub at the pinned revision. Each file must
                match the SHA-256 saved at install.
            </p>
            {plan.data?.over && <CacheImpact plan={plan.data} name={name} />}
        </>
    );
}

function UsageBar({ used, budget }: { used: number; budget: number }) {
    const share = budget > 0 ? used / budget : 0;
    const tone = share > 1 ? "bg-destructive" : share >= 0.9 ? "bg-warning" : "bg-primary";
    return (
        <span
            aria-hidden="true"
            className="block h-1 w-full max-w-md overflow-hidden rounded-sm bg-secondary"
        >
            <span
                className={cn("block h-full", tone)}
                style={{ width: `${Math.min(1, share) * 100}%` }}
            />
        </span>
    );
}

function KeptCell({ base, next }: { base: CachedBaseInfo; next: Set<string> }) {
    if (next.has(base.key)) {
        return <StatusText tone="warning">Removed at the next check</StatusText>;
    }
    if (base.evictable) {
        return <StatusText tone="neutral">Can be removed</StatusText>;
    }
    const [first, ...rest] = base.kept;
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="rounded-sm text-left">
                    <StatusText tone="success">
                        {`Kept: ${first}`}
                        {rest.length > 0 && (
                            <span className="text-muted-foreground">{` +${rest.length}`}</span>
                        )}
                    </StatusText>
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-normal">
                {base.kept.join("; ")}
            </TooltipContent>
        </Tooltip>
    );
}

function baseColumns(next: Set<string>): ColumnDef<CachedBaseInfo, unknown>[] {
    return [
        {
            header: "Base model",
            accessorKey: "name",
            enableHiding: false,
            cell: ({ row }) => (
                <Link
                    href={`/models/base/${encodeURIComponent(row.original.key)}`}
                    className="hover:underline"
                >
                    {row.original.name}
                </Link>
            ),
        },
        {
            header: "Size",
            accessorKey: "size_bytes",
            cell: ({ row }) => (
                <span className="tabular-nums">{bytes(row.original.size_bytes)}</span>
            ),
        },
        {
            header: "Last used",
            accessorKey: "last_used_at",
            cell: ({ row }) => <LastUsed value={row.original.last_used_at} />,
        },
        {
            header: "To free space",
            id: "kept",
            enableSorting: false,
            cell: ({ row }) => <KeptCell base={row.original} next={next} />,
        },
    ];
}

function freeConfirmation(plan: CachePlanInfo, run: () => Promise<unknown>): Confirmation {
    return {
        title: `Remove ${plural(plan.evict.length, "base model")}?`,
        description: (
            <>
                <p>
                    {`Frees ${bytes(plan.freed_bytes)} and brings base models to ${bytes(plan.after_bytes)} of the ${bytes(plan.budget_bytes)} budget. Their records and API keys stay; each can be downloaded again or re-imported.`}
                </p>
                <RemovedList bases={plan.evict} />
            </>
        ),
        confirmLabel: "Free up space",
        destructive: true,
        run,
    };
}

function FreedLine({ plan }: { plan: CachePlanInfo | undefined }) {
    if (!plan) {
        return null;
    }
    if (plan.evict.length === 0) {
        return <p className="text-sm text-muted-foreground">Nothing to remove.</p>;
    }
    return (
        <p className="text-sm">
            <StatusText tone="success">{`Freed ${bytes(plan.freed_bytes)}`}</StatusText>
            <span className="ml-2 text-muted-foreground">{`Removed ${names(plan.evict)}.`}</span>
        </p>
    );
}

function budgetText(enabled: boolean, used: number, budget: number): string {
    if (!enabled) {
        return "No budget is set, so nothing is removed automatically.";
    }
    if (used > budget) {
        return `Over the budget by ${bytes(used - budget)}.`;
    }
    return `${bytes(budget - used)} left in the budget.`;
}

export function ModelCacheSection() {
    const cache = useModelCache();
    const free = useFreeUpSpace();
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const data = cache.data;
    const next = new Set((data?.plan.evict ?? []).map((base) => base.key));
    const removable = (data?.bases ?? []).filter((base) => base.evictable);
    const canFree = Boolean(data?.enabled && data.plan.evict.length > 0);
    return (
        <>
            <PanelSection
                icon={Package}
                title="Base model cache"
                description="Downloaded and imported bases; over the budget, the least recently used go first."
                actions={
                    canFree &&
                    data && (
                        <Button
                            variant="outline"
                            disabled={free.isPending}
                            onClick={() =>
                                setConfirmation(
                                    freeConfirmation(data.plan, () => free.mutateAsync()),
                                )
                            }
                        >
                            Free up space now
                        </Button>
                    )
                }
            >
                <div className="flex flex-col gap-4">
                    <div className="flex flex-wrap gap-x-8 gap-y-4">
                        <Stat label="Base models" value={bytes(data?.used_bytes)} />
                        <Stat
                            label="Budget"
                            value={data?.enabled ? bytes(data.budget_bytes) : "Off"}
                        />
                        <Stat
                            label="Can be removed"
                            value={`${bytes(data?.evictable_bytes ?? 0)} in ${plural(removable.length, "base")}`}
                        />
                        {data?.enabled && (
                            <Stat
                                label="Removed at the next check"
                                value={bytes(data.plan.freed_bytes)}
                            />
                        )}
                    </div>
                    {data?.enabled && (
                        <UsageBar used={data.used_bytes} budget={data.budget_bytes} />
                    )}
                    <p className="text-sm text-muted-foreground">
                        {data
                            ? `${budgetText(data.enabled, data.used_bytes, data.budget_bytes)} `
                            : ""}
                        Checked after each download and every hour. Bases a model, version,
                        deployment, job or engine uses, pinned ones and ones used in the last hour
                        stay.{" "}
                        <Link href="/settings/storage" className="text-primary hover:underline">
                            {data?.enabled ? "Change budget" : "Set a budget"}
                        </Link>
                    </p>
                    <FreedLine plan={free.data} />
                    <ErrorLine error={cache.error ?? free.error} />
                </div>
            </PanelSection>
            <PanelSection
                bare
                icon={ListOrdered}
                title="Base models on disk"
                description="Least recently used first, the order they are removed in. Bases pointed to a folder outside the model folder are not counted."
            >
                <DataGrid
                    columns={baseColumns(next)}
                    rows={data?.bases ?? []}
                    loading={cache.isLoading}
                    empty="No downloaded or imported base models."
                />
            </PanelSection>
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
        </>
    );
}

function pinText(model: BaseModelDetail): string {
    if (model.pinned) {
        return "Kept on disk: never removed to free space.";
    }
    return "Can be removed to free space when nothing uses it.";
}

export function KeepOnDisk({ model }: { model: BaseModelDetail }) {
    const pin = usePinBase();
    if (model.availability.state === "evicted") {
        return (
            <span className="text-muted-foreground">
                {model.evicted_at
                    ? `Removed to free space ${relativeTime(model.evicted_at)}`
                    : "Removed to free space"}
            </span>
        );
    }
    if (model.relocated) {
        return (
            <span className="text-muted-foreground">Outside the model folder; never removed.</span>
        );
    }
    return (
        <span className="flex flex-col gap-1">
            <span className="flex items-center gap-2">
                <Switch
                    id="keep-on-disk"
                    checked={model.pinned ?? false}
                    readOnly={pin.isPending}
                    onCheckedChange={(pinned) => pin.mutate({ key: model.key, pinned })}
                />
                <Label htmlFor="keep-on-disk" className="font-normal">
                    Keep on disk
                </Label>
                <span className="text-muted-foreground">{pinText(model)}</span>
            </span>
            <ErrorLine error={pin.error} />
        </span>
    );
}
