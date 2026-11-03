import { useRouter, useRouterState } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, ExternalLink, Plus, X } from "lucide-react";
import {
    Badge,
    Button,
    type CompareColumn,
    CompareMarker,
    type CompareSection,
    CompareTable,
    EmptyState,
    InfoTip,
    Input,
    Label,
    Link,
    Skeleton,
    Switch,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { CatalogEntry, CatalogResponse } from "~/api/client";
import { useCatalog } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine, Page } from "~/components/Section";
import { StatusText, type Tone } from "~/components/models/StatusText";
import { discoverListHref } from "~/lib/modelsSearch";
import { bytes } from "~/lib/time";
import { ComparePicker } from "./ComparePicker";
import {
    type Actions,
    COMPARE_MAX,
    EntryAction,
    Fit,
    addModelHref,
    compareHref,
    discoverHref,
    parameters,
    poolPhrase,
} from "./Discover";
import { TIERS, bestFit, licenceOf, licenceUseLabel } from "./DiscoverFilters";
import { useModelsRefresh } from "./dialogs";

const DOWNLOADS = new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
});

const USE_TONES: Record<CatalogEntry["license_use"], Tone> = {
    commercial: "success",
    restricted: "warning",
    "non-commercial": "destructive",
    unknown: "neutral",
};

const SKELETON_ROWS = ["parameters", "fit", "memory", "download", "runtimes", "licence", "use"];

type Variant = CatalogEntry["variants"][number];

type Attribute = {
    id: string;
    label: string;
    key: (entry: CatalogEntry) => string;
    render?: (entry: CatalogEntry, entries: CatalogEntry[]) => ReactNode;
};

type Group = { id: string; title: string; attributes: Attribute[] };

type Focus = { id: string; target: "left" | "right" | "remove" };

function tierLabel(entry: CatalogEntry): string {
    return TIERS.find((tier) => tier.value === entry.tier)?.label ?? entry.tier;
}

function smallestAcross(
    entries: CatalogEntry[],
    value: (variant: Variant) => number,
): number | undefined {
    const minima = entries.map((entry) => Math.min(...entry.variants.map(value)));
    return new Set(minima).size > 1 ? Math.min(...minima) : undefined;
}

function VariantList({
    entry,
    value,
    best,
    bestLabel,
}: {
    entry: CatalogEntry;
    value: (variant: Variant) => number;
    best?: number;
    bestLabel: string;
}) {
    return (
        <ul className="flex flex-col gap-1">
            {entry.variants.map((variant) => (
                <li
                    key={variant.id}
                    className="flex flex-wrap items-center justify-between gap-x-2"
                >
                    <span className="min-w-0 truncate text-muted-foreground">{variant.label}</span>
                    <span className="ml-auto flex items-center gap-1.5 tabular-nums">
                        {best !== undefined && value(variant) === best && (
                            <Badge variant="accent">{bestLabel}</Badge>
                        )}
                        {bytes(value(variant))}
                    </span>
                </li>
            ))}
        </ul>
    );
}

function sizedVariants(entry: CatalogEntry, value: (variant: Variant) => number): string {
    return entry.variants.map((variant) => `${variant.label}:${bytes(value(variant))}`).join("|");
}

const needed = (variant: Variant) => variant.fit.needed_bytes;
const download = (variant: Variant) => variant.size_bytes;

function groups(catalog: CatalogResponse, pool?: string): Group[] {
    const names = new Map(catalog.entries.map((entry) => [entry.id, entry]));
    return [
        {
            id: "hardware",
            title: "Size and hardware",
            attributes: [
                {
                    id: "parameters",
                    label: "Parameters",
                    key: (entry) => `${parameters(entry)} ${entry.tier}`,
                    render: (entry) => (
                        <div className="flex flex-col">
                            <span className="tabular-nums">{parameters(entry)}</span>
                            <span className="text-muted-foreground">{`Size ${tierLabel(entry)}`}</span>
                        </div>
                    ),
                },
                {
                    id: "fit",
                    label: `Fit on ${poolPhrase(catalog)}`,
                    key: (entry) => bestFit(entry).fit.level,
                    render: (entry) => {
                        const best = bestFit(entry);
                        return (
                            <div className="flex flex-col items-start">
                                <Fit fit={best.fit} />
                                <span className="text-muted-foreground">{`Best with ${best.label}`}</span>
                            </div>
                        );
                    },
                },
                {
                    id: "memory",
                    label: "Memory needed",
                    key: (entry) => sizedVariants(entry, needed),
                    render: (entry, entries) => (
                        <VariantList
                            entry={entry}
                            value={needed}
                            best={smallestAcross(entries, needed)}
                            bestLabel="Least"
                        />
                    ),
                },
                {
                    id: "download",
                    label: "Download size",
                    key: (entry) => sizedVariants(entry, download),
                    render: (entry, entries) => (
                        <VariantList
                            entry={entry}
                            value={download}
                            best={smallestAcross(entries, download)}
                            bestLabel="Smallest"
                        />
                    ),
                },
                {
                    id: "runtimes",
                    label: "Runs on",
                    key: (entry) =>
                        [...new Set(entry.variants.flatMap((variant) => variant.runtimes))]
                            .sort()
                            .join(", "),
                },
            ],
        },
        {
            id: "licence",
            title: "Licence and access",
            attributes: [
                {
                    id: "licence",
                    label: "Licence",
                    key: (entry) => licenceOf(entry),
                    render: (entry) =>
                        entry.license_url ? (
                            <a
                                href={entry.license_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-primary hover:underline"
                            >
                                {licenceOf(entry)}
                                <ExternalLink
                                    aria-hidden="true"
                                    className="ml-1 inline size-3.5 align-[-2px]"
                                />
                            </a>
                        ) : (
                            licenceOf(entry)
                        ),
                },
                {
                    id: "use",
                    label: "Commercial use",
                    key: (entry) => licenceUseLabel(entry.license_use),
                    render: (entry) => (
                        <span className="inline-flex items-center gap-1.5">
                            <StatusText tone={USE_TONES[entry.license_use]}>
                                {licenceUseLabel(entry.license_use)}
                            </StatusText>
                            {entry.license_summary && (
                                <InfoTip label={`Licence terms for ${entry.name}`}>
                                    {entry.license_summary}
                                </InfoTip>
                            )}
                        </span>
                    ),
                },
                {
                    id: "access",
                    label: "Access",
                    key: (entry) =>
                        entry.gated ? "Needs access from the publisher" : "Open access",
                },
            ],
        },
        {
            id: "capabilities",
            title: "Capabilities",
            attributes: [
                {
                    id: "tasks",
                    label: "Tasks",
                    key: (entry) => [...entry.capabilities].sort().join(", "),
                    render: (entry) => entry.capabilities.join(", "),
                },
                {
                    id: "architecture",
                    label: "Architecture",
                    key: (entry) => `${entry.architecture}${entry.moe ? " MoE" : ""}`,
                    render: (entry) => (
                        <span className="font-mono">{`${entry.architecture}${entry.moe ? " · MoE" : ""}`}</span>
                    ),
                },
                {
                    id: "generation",
                    label: "Generation",
                    key: (entry) =>
                        `${entry.generation} ${entry.superseded_by ? "superseded" : "latest"}`,
                    render: (entry) => {
                        const newer = entry.superseded_by
                            ? names.get(entry.superseded_by)
                            : undefined;
                        return (
                            <div className="flex flex-col">
                                <span>{entry.generation || "–"}</span>
                                {entry.superseded_by ? (
                                    <span className="text-muted-foreground">
                                        Newer version:{" "}
                                        {newer ? (
                                            <Link href={discoverHref(newer, pool)}>
                                                {newer.name}
                                            </Link>
                                        ) : (
                                            entry.superseded_by
                                        )}
                                    </span>
                                ) : (
                                    <span className="text-muted-foreground">
                                        Latest in the catalogue
                                    </span>
                                )}
                            </div>
                        );
                    },
                },
            ],
        },
        {
            id: "popularity",
            title: "Popularity",
            attributes: [
                {
                    id: "downloads",
                    label: "Downloads",
                    key: (entry) => DOWNLOADS.format(entry.popularity),
                    render: (entry) => (
                        <span className="tabular-nums">{`${DOWNLOADS.format(entry.popularity)} on Hugging Face`}</span>
                    ),
                },
            ],
        },
    ];
}

function readCompare(search: unknown): { ids: string[]; only: boolean; pool?: string } {
    const source = (search ?? {}) as Record<string, unknown>;
    const text = (value: unknown) =>
        value === undefined || value === null ? "" : String(value).trim();
    const ids = [
        ...new Set(
            text(source.ids)
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean),
        ),
    ];
    return {
        ids,
        only: text(source.only) === "differences",
        pool: text(source.pool) || undefined,
    };
}

function Back({ ids }: { ids: string[] }) {
    return (
        <Link
            href={discoverListHref({ selected: ids.join(",") })}
            className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
            <ChevronLeft className="size-4" />
            Discover
        </Link>
    );
}

function IconAction({
    label,
    tip,
    focus,
    disabled,
    onClick,
    children,
}: {
    label: string;
    tip: string;
    focus: Focus["target"];
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={label}
                    data-focus={focus}
                    disabled={disabled}
                    onClick={onClick}
                >
                    {children}
                </Button>
            </TooltipTrigger>
            <TooltipContent>{tip}</TooltipContent>
        </Tooltip>
    );
}

function ModelHeader({
    entry,
    index,
    count,
    on,
    pool,
    onMove,
    onRemove,
}: {
    entry: CatalogEntry;
    index: number;
    count: number;
    on: Actions;
    pool?: string;
    onMove: (by: -1 | 1) => void;
    onRemove: () => void;
}) {
    return (
        <div className="group/model flex h-full flex-col justify-between gap-2">
            <div className="flex items-start gap-2">
                <PublisherLogo publisher={entry.provider} name={entry.name} size="sm" />
                <div className="flex min-w-0 flex-1 flex-col">
                    <Link
                        href={discoverHref(entry, pool)}
                        className="line-clamp-2 font-semibold break-words text-foreground hover:underline"
                    >
                        {entry.name}
                    </Link>
                    <span className="truncate text-muted-foreground">{entry.provider}</span>
                </div>
                <IconAction
                    label={`Remove ${entry.name} from the comparison`}
                    tip="Remove from the comparison"
                    focus="remove"
                    onClick={onRemove}
                >
                    <X />
                </IconAction>
            </div>
            <div className="flex items-center justify-between gap-2">
                <EntryAction entry={entry} on={on} />
                {count > 1 && (
                    <div className="flex opacity-0 group-focus-within/model:opacity-100 group-hover/model:opacity-100 [@media(hover:none)]:opacity-100">
                        <IconAction
                            label={`Move ${entry.name} left`}
                            tip="Move left"
                            focus="left"
                            disabled={index === 0}
                            onClick={() => onMove(-1)}
                        >
                            <ChevronLeft />
                        </IconAction>
                        <IconAction
                            label={`Move ${entry.name} right`}
                            tip="Move right"
                            focus="right"
                            disabled={index === count - 1}
                            onClick={() => onMove(1)}
                        >
                            <ChevronRight />
                        </IconAction>
                    </div>
                )}
            </div>
        </div>
    );
}

function DifferencesToggle({
    only,
    enabled,
    differing,
    total,
    onOnly,
}: {
    only: boolean;
    enabled: boolean;
    differing: number;
    total: number;
    onOnly: (only: boolean) => void;
}) {
    return (
        <div className="flex flex-col gap-1.5">
            <Label className="flex items-center gap-2 font-normal">
                <Switch
                    size="sm"
                    checked={only && enabled}
                    disabled={!enabled}
                    onCheckedChange={onOnly}
                />
                Only differences
            </Label>
            {enabled ? (
                <span className="flex items-center gap-2 text-muted-foreground tabular-nums">
                    <CompareMarker />
                    {`${differing} of ${total} differ`}
                </span>
            ) : (
                <span className="text-muted-foreground">Add a model to see differences</span>
            )}
        </div>
    );
}

function AddToCompare({
    count,
    variant,
    onAdd,
}: {
    count: number;
    variant?: "default" | "outline";
    onAdd: () => void;
}) {
    return (
        <Button variant={variant} disabled={count >= COMPARE_MAX} onClick={onAdd}>
            <Plus />
            Add model to compare
        </Button>
    );
}

type Copy = "idle" | "copied" | "failed";

function CopyFallback({ href }: { href: string }) {
    const field = useRef<HTMLInputElement>(null);
    useEffect(() => {
        field.current?.focus();
        field.current?.select();
    }, []);
    return (
        <div className="flex max-w-2xl flex-col gap-1.5">
            <p className="text-sm text-muted-foreground">
                The browser blocked copying. Copy the selected link instead.
            </p>
            <Input
                ref={field}
                readOnly
                value={href}
                aria-label="Link to this comparison"
                onFocus={(event) => event.currentTarget.select()}
                className="font-mono"
            />
        </div>
    );
}

function CompareSkeleton({ ids }: { ids: string[] }) {
    const columns = ids.length > 0 ? ids.slice(0, COMPARE_MAX) : ["first", "second"];
    const cells = (height: string) =>
        columns.map((id) => <Skeleton key={id} className={`${height} min-w-0 flex-1`} />);
    return (
        <div aria-busy="true" className="flex flex-col rounded-md border">
            <span className="sr-only">Loading the comparison</span>
            <div className="flex gap-6 border-b p-3">
                <Skeleton className="h-14 w-32 shrink-0" />
                {cells("h-14")}
            </div>
            {SKELETON_ROWS.map((row) => (
                <div key={row} className="flex gap-6 border-b px-3 py-2.5 last:border-b-0">
                    <Skeleton className="h-4 w-32 shrink-0" />
                    {cells("h-4")}
                </div>
            ))}
        </div>
    );
}

function useFocusAfterChange(order: string) {
    const [pending, setPending] = useState<Focus | null>(null);
    useEffect(() => {
        if (!pending || !order.split(",").includes(pending.id)) {
            return;
        }
        const cell = document.querySelector(
            `[data-slot="compare-table-header"] [data-column="${CSS.escape(pending.id)}"]`,
        );
        const button =
            cell?.querySelector<HTMLButtonElement>(
                `[data-focus="${pending.target}"]:not(:disabled)`,
            ) ?? cell?.querySelector<HTMLButtonElement>("[data-focus]:not(:disabled)");
        button?.focus();
        setPending(null);
    }, [pending, order]);
    return setPending;
}

export function DiscoverComparePage() {
    const router = useRouter();
    const refresh = useModelsRefresh();
    const raw = useRouterState({ select: (state) => state.location.search });
    const { ids, only, pool } = useMemo(() => readCompare(raw), [raw]);
    const catalog = useCatalog(pool);
    const data = catalog.data;
    const [picking, setPicking] = useState(false);
    const [copy, setCopy] = useState<Copy>("idle");
    const on: Actions = useMemo(
        () => ({
            download: (entry) => router.history.push(addModelHref(entry)),
            requirements: (entry) => router.history.push(discoverHref(entry, pool)),
            open: (path) => router.history.push(path),
            refresh,
            online: data?.online !== false,
            tokenConfigured: Boolean(data?.token_configured),
        }),
        [router, refresh, data?.online, data?.token_configured, pool],
    );
    const byId = new Map((data?.entries ?? []).map((entry) => [entry.id, entry]));
    const missing = data ? ids.filter((id) => !byId.has(id)) : [];
    const known = ids.filter((id) => byId.has(id));
    const shown = known.slice(0, COMPARE_MAX);
    const extra = known.slice(COMPARE_MAX);
    const entries = shown.flatMap((id) => byId.get(id) ?? []);
    const focusLater = useFocusAfterChange(shown.join(","));
    useEffect(() => {
        if (copy !== "copied") {
            return;
        }
        const timer = window.setTimeout(() => setCopy("idle"), 2000);
        return () => window.clearTimeout(timer);
    }, [copy]);
    const go = (next: string[], nextOnly: boolean) =>
        router.history.replace(compareHref(next, pool, nextOnly));
    const comparing = entries.length > 1;
    const filtering = only && comparing;
    const all: CompareSection[] = data
        ? groups(data, pool).map((group) => ({
              id: group.id,
              title: group.title,
              rows: group.attributes.map((attribute) => ({
                  id: attribute.id,
                  label: attribute.label,
                  differs: comparing && new Set(entries.map(attribute.key)).size > 1,
                  cells: entries.map((entry) =>
                      attribute.render ? attribute.render(entry, entries) : attribute.key(entry),
                  ),
              })),
          }))
        : [];
    const rows = all.flatMap((section) => section.rows);
    const differing = rows.filter((row) => row.differs).length;
    const sections = filtering
        ? all.map((section) => ({
              ...section,
              rows: section.rows.filter((row) => row.differs),
          }))
        : all;
    const move = (index: number, by: -1 | 1) => {
        const next = [...shown];
        [next[index], next[index + by]] = [next[index + by], next[index]];
        focusLater({ id: shown[index], target: by < 0 ? "left" : "right" });
        go(next, only);
    };
    const remove = (index: number) => {
        const neighbour = shown[index + 1] ?? shown[index - 1];
        if (neighbour) {
            focusLater({ id: neighbour, target: "remove" });
        }
        go(
            shown.filter((_, position) => position !== index),
            only,
        );
    };
    const copyLink = () => {
        if (!navigator.clipboard) {
            setCopy("failed");
            return;
        }
        navigator.clipboard.writeText(window.location.href).then(
            () => setCopy("copied"),
            () => setCopy("failed"),
        );
    };
    const columns: CompareColumn[] = entries.map((entry, index) => ({
        id: entry.id,
        header: (
            <ModelHeader
                entry={entry}
                index={index}
                count={entries.length}
                on={on}
                pool={pool}
                onMove={(by) => move(index, by)}
                onRemove={() => remove(index)}
            />
        ),
    }));
    return (
        <Page wide>
            <Back ids={shown} />
            <PageHeader
                title="Compare models"
                caption={
                    data && comparing
                        ? `${entries.length} models side by side. Fit is estimated for ${poolPhrase(data)}.`
                        : "Catalogue models side by side."
                }
                actions={
                    data && entries.length > 0 ? (
                        <div className="flex flex-col items-end gap-1">
                            <div className="flex flex-wrap justify-end gap-2">
                                <Button variant="outline" onClick={copyLink}>
                                    {copy === "copied" ? "Link copied" : "Copy link"}
                                </Button>
                                {comparing && (
                                    <AddToCompare
                                        count={entries.length}
                                        variant="outline"
                                        onAdd={() => setPicking(true)}
                                    />
                                )}
                            </div>
                            {entries.length >= COMPARE_MAX && (
                                <span className="text-sm text-muted-foreground">
                                    {`Up to ${COMPARE_MAX} models. Remove one to add another.`}
                                </span>
                            )}
                        </div>
                    ) : undefined
                }
            />
            <output className="sr-only">{copy === "copied" ? "Link copied" : ""}</output>
            {copy === "failed" && <CopyFallback href={window.location.href} />}
            {catalog.error && (
                <div className="flex flex-wrap items-center gap-3">
                    <ErrorLine error={catalog.error} />
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={catalog.isFetching}
                        onClick={() => catalog.refetch()}
                    >
                        Retry
                    </Button>
                </div>
            )}
            {catalog.isLoading && <CompareSkeleton ids={ids} />}
            {missing.length > 0 && (
                <StatusText tone="warning" className="text-sm whitespace-normal">
                    {`Not in the catalogue, so left out: ${missing.join(", ")}.`}
                </StatusText>
            )}
            {extra.length > 0 && (
                <StatusText tone="warning" className="text-sm whitespace-normal">
                    {`Compare shows up to ${COMPARE_MAX} models; left out: ${extra
                        .map((id) => byId.get(id)?.name ?? id)
                        .join(", ")}.`}
                </StatusText>
            )}
            {data && entries.length === 0 && (
                <EmptyState
                    variant="panel"
                    title={
                        ids.length === 0
                            ? "No models to compare yet"
                            : "None of these models are in the catalogue"
                    }
                    action={
                        <div className="mt-4 flex flex-wrap justify-center gap-2">
                            <AddToCompare count={0} onAdd={() => setPicking(true)} />
                            <Button asChild variant="outline">
                                <Link href={discoverListHref({})}>Browse Discover</Link>
                            </Button>
                        </div>
                    }
                >
                    {`Add 2 to ${COMPARE_MAX} catalogue models to see them side by side, or select them on Discover and press Compare.`}
                </EmptyState>
            )}
            {data && entries.length === 1 && (
                <div className="flex max-w-3xl flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2">
                    <p className="text-sm">
                        {`Add at least one more model to compare with ${entries[0].name}.`}
                    </p>
                    <AddToCompare count={1} onAdd={() => setPicking(true)} />
                </div>
            )}
            {data && entries.length > 0 && (
                <>
                    <CompareTable
                        label="Model comparison"
                        className={comparing ? undefined : "max-w-3xl"}
                        columns={columns}
                        sections={sections}
                        corner={
                            <DifferencesToggle
                                only={only}
                                enabled={comparing}
                                differing={differing}
                                total={rows.length}
                                onOnly={(next) => go(shown, next)}
                            />
                        }
                    />
                    {filtering && differing === 0 && (
                        <p className="text-sm text-muted-foreground">
                            These models match on every attribute. Turn off Only differences to see
                            them.
                        </p>
                    )}
                </>
            )}
            {data && (
                <ComparePicker
                    open={picking}
                    onOpenChange={setPicking}
                    entries={data.entries}
                    compared={shown}
                    poolPhrase={poolPhrase(data)}
                    onPick={(entry) => go([...shown, entry.id], only)}
                />
            )}
        </Page>
    );
}
