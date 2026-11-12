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
    addModelHref,
    compareHref,
    contextText,
    discoverHref,
    parameters,
    releasedText,
} from "./Discover";
import { TIERS, licenceOf, licenceUseLabel } from "./DiscoverFilters";
import { useModelsRefresh } from "./dialogs";
import { FormatHelp, formatName, formatUse, schemes } from "./formats";
import { TRAIN_MEMORY_INFO, leastTrainMemory } from "./runsHere";

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

const SKELETON_ROWS = ["parameters", "formats", "memory", "download", "runtimes", "licence", "use"];

type Variant = CatalogEntry["variants"][number];

type Attribute = {
    id: string;
    label: string;
    info?: ReactNode;
    key: (entry: CatalogEntry) => string;
    render?: (entry: CatalogEntry, entries: CatalogEntry[]) => ReactNode;
    amount?: (entry: CatalogEntry) => number;
    formatDelta?: (amount: number) => string;
    better?: "lower" | "higher";
};

type Group = { id: string; title: string; attributes: Attribute[] };

type Focus = { id: string; target: "left" | "right" | "remove" | "baseline"; after: string };

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
                    <span className="min-w-0 truncate text-muted-foreground">
                        {formatName(variant)}
                    </span>
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

function FormatList({ entry }: { entry: CatalogEntry }) {
    return (
        <ul className="flex flex-col gap-1">
            {entry.variants.map((variant) => (
                <li
                    key={variant.id}
                    className="flex flex-wrap items-center justify-between gap-x-2"
                >
                    <span className="min-w-0 truncate">{formatName(variant)}</span>
                    <span className="ml-auto text-muted-foreground">{formatUse(variant)}</span>
                </li>
            ))}
        </ul>
    );
}

function sizedVariants(entry: CatalogEntry, value: (variant: Variant) => number): string {
    return entry.variants
        .map((variant) => `${formatName(variant)}:${bytes(value(variant))}`)
        .join("|");
}

const needed = (variant: Variant) => variant.fit.needed_bytes;

function TrainFigure({ entry }: { entry: CatalogEntry }) {
    const least = leastTrainMemory(entry);
    if (least === null) {
        return <span className="text-muted-foreground">Serve only</span>;
    }
    const here = entry.variants.some((variant) => variant.train_fit.level === "fits");
    return (
        <div className="flex flex-col">
            <span className="tabular-nums">{bytes(least)}</span>
            {here && <span className="text-muted-foreground">Trains on your hardware</span>}
        </div>
    );
}
const download = (variant: Variant) => variant.size_bytes;
const smallest = (value: (variant: Variant) => number) => (entry: CatalogEntry) =>
    Math.min(...entry.variants.map(value));

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
                    amount: (entry) => entry.params_b,
                    formatDelta: (amount) => `${amount.toFixed(1)}B`,
                    render: (entry) => (
                        <div className="flex flex-col">
                            <span className="tabular-nums">{parameters(entry)}</span>
                            <span className="text-muted-foreground">{`Size ${tierLabel(entry)}`}</span>
                        </div>
                    ),
                },
                {
                    id: "formats",
                    label: "Formats",
                    info: <FormatHelp />,
                    key: (entry) => schemes(entry).join(" · "),
                    render: (entry) => <FormatList entry={entry} />,
                },
                {
                    id: "memory",
                    label: "Memory to run",
                    key: (entry) => sizedVariants(entry, needed),
                    amount: smallest(needed),
                    formatDelta: bytes,
                    better: "lower",
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
                    id: "train",
                    label: "Memory to train (QLoRA)",
                    info: TRAIN_MEMORY_INFO,
                    key: (entry) => bytes(leastTrainMemory(entry)),
                    amount: (entry) => leastTrainMemory(entry) ?? Number.POSITIVE_INFINITY,
                    formatDelta: bytes,
                    better: "lower",
                    render: (entry) => <TrainFigure entry={entry} />,
                },
                {
                    id: "download",
                    label: "Download size",
                    key: (entry) => sizedVariants(entry, download),
                    amount: smallest(download),
                    formatDelta: bytes,
                    better: "lower",
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
                    id: "context",
                    label: "Context",
                    key: (entry) => String(entry.context_tokens ?? ""),
                    amount: (entry) => entry.context_tokens ?? 0,
                    formatDelta: (amount) => `${Math.round(amount / 1024)}K tokens`,
                    better: "higher",
                    render: (entry) => (
                        <span className="tabular-nums">
                            {contextText(entry) ? `${contextText(entry)} tokens` : "Unknown"}
                        </span>
                    ),
                },
                {
                    id: "released",
                    label: "Released",
                    key: (entry) => entry.released ?? "",
                    render: (entry) => releasedText(entry) ?? "Unknown",
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
                    amount: (entry) => entry.popularity,
                    formatDelta: (amount) => DOWNLOADS.format(amount),
                    render: (entry) => (
                        <span className="tabular-nums">{`${DOWNLOADS.format(entry.popularity)} on Hugging Face`}</span>
                    ),
                },
            ],
        },
    ];
}

function readCompare(search: unknown): {
    ids: string[];
    only: boolean;
    pool?: string;
    baseline?: string;
} {
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
        baseline: text(source.baseline) || undefined,
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

function BaselineControl({
    entry,
    baseline,
    onBaseline,
}: {
    entry: CatalogEntry;
    baseline: boolean;
    onBaseline: (on: boolean) => void;
}) {
    if (!baseline) {
        return (
            <Button
                variant="link"
                className="mt-1.5 h-auto p-0"
                aria-label={`Set as baseline, ${entry.name}`}
                data-focus="baseline"
                onClick={() => onBaseline(true)}
            >
                Set as baseline
            </Button>
        );
    }
    return (
        <span className="mt-1.5 flex items-center gap-2">
            <Badge variant="accent">Baseline</Badge>
            <Button
                variant="link"
                className="h-auto p-0"
                aria-label={`Clear baseline, ${entry.name}`}
                data-focus="baseline"
                onClick={() => onBaseline(false)}
            >
                Clear
            </Button>
        </span>
    );
}

function ModelHeader({
    entry,
    index,
    count,
    on,
    pool,
    baseline,
    onMove,
    onRemove,
    onBaseline,
}: {
    entry: CatalogEntry;
    index: number;
    count: number;
    on: Actions;
    pool?: string;
    baseline: boolean;
    onMove: (by: -1 | 1) => void;
    onRemove: () => void;
    onBaseline: (on: boolean) => void;
}) {
    return (
        <div className="group/model flex h-full flex-col justify-between gap-2">
            <div className="flex items-start gap-2">
                <PublisherLogo publisher={entry.provider} name={entry.name} size="sm" />
                <div className="flex min-w-0 flex-1 flex-col items-start">
                    <Link
                        href={discoverHref(entry, pool)}
                        className="line-clamp-2 font-semibold break-words text-foreground hover:underline"
                    >
                        {entry.name}
                    </Link>
                    <span className="max-w-full truncate text-muted-foreground">
                        {entry.provider}
                    </span>
                    {count > 1 && (
                        <BaselineControl
                            entry={entry}
                            baseline={baseline}
                            onBaseline={onBaseline}
                        />
                    )}
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

function useFocusAfterChange(ids: string[], version: string) {
    const [pending, setPending] = useState<Focus | null>(null);
    useEffect(() => {
        if (!pending || pending.after === version) {
            return;
        }
        if (!ids.includes(pending.id)) {
            setPending(null);
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
    }, [pending, ids, version]);
    return setPending;
}

export function DiscoverComparePage() {
    const router = useRouter();
    const refresh = useModelsRefresh();
    const raw = useRouterState({ select: (state) => state.location.search });
    const { ids, only, pool, baseline } = useMemo(() => readCompare(raw), [raw]);
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
    const pinned = baseline && shown.includes(baseline) ? baseline : undefined;
    const version = `${shown.join(",")}|${pinned ?? ""}`;
    const focusLater = useFocusAfterChange(shown, version);
    useEffect(() => {
        if (copy !== "copied") {
            return;
        }
        const timer = window.setTimeout(() => setCopy("idle"), 2000);
        return () => window.clearTimeout(timer);
    }, [copy]);
    const go = (next: string[], nextOnly: boolean, nextBaseline = pinned ?? null) =>
        router.history.replace(
            nextBaseline && next.includes(nextBaseline)
                ? `${compareHref(next, pool, nextOnly)}&baseline=${encodeURIComponent(nextBaseline)}`
                : compareHref(next, pool, nextOnly),
        );
    const comparing = entries.length > 1;
    const filtering = only && comparing;
    const all: CompareSection[] = data
        ? groups(data, pool).map((group) => ({
              id: group.id,
              title: group.title,
              rows: group.attributes.map((attribute) => ({
                  id: attribute.id,
                  label: attribute.info ? (
                      <span className="inline-flex items-center gap-1.5">
                          {attribute.label}
                          <InfoTip label="What the formats mean">{attribute.info}</InfoTip>
                      </span>
                  ) : (
                      attribute.label
                  ),
                  differs: comparing && new Set(entries.map(attribute.key)).size > 1,
                  cells: entries.map((entry) =>
                      attribute.render ? attribute.render(entry, entries) : attribute.key(entry),
                  ),
                  values: entries.map((entry) => attribute.amount?.(entry) ?? attribute.key(entry)),
                  formatDelta: attribute.formatDelta,
                  better: attribute.better,
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
        focusLater({ id: shown[index], target: by < 0 ? "left" : "right", after: version });
        go(next, only);
    };
    const remove = (index: number) => {
        const neighbour = shown[index + 1] ?? shown[index - 1];
        if (neighbour) {
            focusLater({ id: neighbour, target: "remove", after: version });
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
        label: entry.name,
        header: (
            <ModelHeader
                entry={entry}
                index={index}
                count={entries.length}
                on={on}
                pool={pool}
                baseline={entry.id === pinned}
                onMove={(by) => move(index, by)}
                onRemove={() => remove(index)}
                onBaseline={(next) => {
                    focusLater({ id: entry.id, target: "baseline", after: version });
                    go(shown, only, next ? entry.id : null);
                }}
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
                        ? `${entries.length} models side by side.`
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
                <StatusText tone="warning" className="whitespace-normal">
                    {`Not in the catalogue, so left out: ${missing.join(", ")}.`}
                </StatusText>
            )}
            {extra.length > 0 && (
                <StatusText tone="warning" className="whitespace-normal">
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
                    <p>{`Add at least one more model to compare with ${entries[0].name}.`}</p>
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
                        baseline={pinned}
                        onReorder={(next) => go(next, only)}
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
                        <p className="text-muted-foreground">
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
                    onPick={(entry) => go([...shown, entry.id], only)}
                />
            )}
        </Page>
    );
}
