import { useRouter, useRouterState } from "@tanstack/react-router";
import { ChevronLeft, X } from "lucide-react";
import {
    Button,
    Label,
    Link,
    Skeleton,
    Switch,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import { type ReactNode, useMemo } from "react";
import type { CatalogEntry, CatalogResponse } from "~/api/client";
import { useCatalog } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { ErrorLine, Page } from "~/components/Section";
import { StatusText } from "~/components/models/StatusText";
import { discoverListHref } from "~/lib/modelsSearch";
import { bytes } from "~/lib/time";
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

const LABEL_WIDTH = 176;
const MODEL_WIDTH = 232;

type Attribute = {
    id: string;
    label: string;
    key: (entry: CatalogEntry) => string;
    render?: (entry: CatalogEntry) => ReactNode;
};

function tierLabel(entry: CatalogEntry): string {
    return TIERS.find((tier) => tier.value === entry.tier)?.label ?? entry.tier;
}

function VariantList({
    entry,
    value,
}: {
    entry: CatalogEntry;
    value: (variant: CatalogEntry["variants"][number]) => string;
}) {
    return (
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
            {entry.variants.map((variant) => (
                <div key={variant.id} className="contents">
                    <dt className="truncate text-muted-foreground">{variant.label}</dt>
                    <dd className="text-right tabular-nums">{value(variant)}</dd>
                </div>
            ))}
        </dl>
    );
}

function attributes(catalog: CatalogResponse, pool?: string): Attribute[] {
    const names = new Map(catalog.entries.map((entry) => [entry.id, entry]));
    const variants = (
        entry: CatalogEntry,
        value: (variant: CatalogEntry["variants"][number]) => string,
    ) => entry.variants.map((variant) => `${variant.label}:${value(variant)}`).join("|");
    return [
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
            key: (entry) => variants(entry, (variant) => bytes(variant.fit.needed_bytes)),
            render: (entry) => (
                <VariantList entry={entry} value={(variant) => bytes(variant.fit.needed_bytes)} />
            ),
        },
        {
            id: "download",
            label: "Download size",
            key: (entry) => variants(entry, (variant) => bytes(variant.size_bytes)),
            render: (entry) => (
                <VariantList entry={entry} value={(variant) => bytes(variant.size_bytes)} />
            ),
        },
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
                    </a>
                ) : (
                    licenceOf(entry)
                ),
        },
        {
            id: "use",
            label: "Licence group",
            key: (entry) => licenceUseLabel(entry.license_use),
        },
        {
            id: "tasks",
            label: "Tasks",
            key: (entry) => [...entry.capabilities].sort().join(", "),
            render: (entry) => entry.capabilities.join(", "),
        },
        {
            id: "generation",
            label: "Generation",
            key: (entry) => `${entry.generation} ${entry.superseded_by ? "superseded" : "latest"}`,
            render: (entry) => {
                const newer = entry.superseded_by ? names.get(entry.superseded_by) : undefined;
                return (
                    <div className="flex flex-col">
                        <span>{entry.generation || "–"}</span>
                        {entry.superseded_by ? (
                            <span className="text-muted-foreground">
                                Newer version:{" "}
                                {newer ? (
                                    <Link href={discoverHref(newer, pool)}>{newer.name}</Link>
                                ) : (
                                    entry.superseded_by
                                )}
                            </span>
                        ) : (
                            <span className="text-muted-foreground">Latest in the catalogue</span>
                        )}
                    </div>
                );
            },
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
            id: "runtimes",
            label: "Runs on",
            key: (entry) =>
                [...new Set(entry.variants.flatMap((variant) => variant.runtimes))]
                    .sort()
                    .join(", "),
        },
        {
            id: "access",
            label: "Access",
            key: (entry) =>
                entry.gated ? "Needs access from the publisher" : "One-click download",
        },
        {
            id: "downloads",
            label: "Downloads",
            key: (entry) => DOWNLOADS.format(entry.popularity),
            render: (entry) => (
                <span className="tabular-nums">{`${DOWNLOADS.format(entry.popularity)} on Hugging Face`}</span>
            ),
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

function ModelHeader({
    entry,
    on,
    onRemove,
    pool,
}: {
    entry: CatalogEntry;
    on: Actions;
    onRemove: () => void;
    pool?: string;
}) {
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-start gap-2">
                <PublisherLogo publisher={entry.provider} name={entry.name} size="sm" />
                <div className="flex min-w-0 flex-1 flex-col">
                    <Link
                        href={discoverHref(entry, pool)}
                        className="font-semibold text-foreground hover:underline"
                    >
                        {entry.name}
                    </Link>
                    <span className="font-normal text-muted-foreground">{entry.provider}</span>
                </div>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Remove ${entry.name} from the comparison`}
                            onClick={onRemove}
                        >
                            <X />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Remove from the comparison</TooltipContent>
                </Tooltip>
            </div>
            <div className="flex font-normal">
                <EntryAction entry={entry} on={on} />
            </div>
        </div>
    );
}

function NotEnough({ ids }: { ids: string[] }) {
    return (
        <div className="flex flex-col items-start gap-3 rounded-md border px-4 py-4">
            <p className="text-base">
                {ids.length === 0
                    ? "No models to compare."
                    : "Compare needs at least 2 models from the catalogue."}
            </p>
            <p className="text-sm text-muted-foreground">
                Select 2 to {COMPARE_MAX} models on Discover with their checkboxes, then press
                Compare.
            </p>
            <Button asChild variant="outline">
                <Link href={discoverListHref({ selected: ids.join(",") })}>Back to Discover</Link>
            </Button>
        </div>
    );
}

function CompareTable({
    entries,
    rows,
    on,
    pool,
    onRemove,
}: {
    entries: CatalogEntry[];
    rows: (Attribute & { differs: boolean })[];
    on: Actions;
    pool?: string;
    onRemove: (entry: CatalogEntry) => void;
}) {
    return (
        <div className="rounded-md border">
            <Table
                className="table-fixed"
                style={{ minWidth: LABEL_WIDTH + entries.length * MODEL_WIDTH }}
            >
                <colgroup>
                    <col style={{ width: LABEL_WIDTH }} />
                    {entries.map((entry) => (
                        <col key={entry.id} />
                    ))}
                </colgroup>
                <TableHeader>
                    <TableRow className="hover:bg-transparent">
                        <TableHead className="sticky left-0 z-[1] align-bottom">
                            <span className="sr-only">Attribute</span>
                        </TableHead>
                        {entries.map((entry) => (
                            <TableHead
                                key={entry.id}
                                scope="col"
                                className="h-auto py-3 align-top whitespace-normal text-foreground"
                            >
                                <ModelHeader
                                    entry={entry}
                                    on={on}
                                    pool={pool}
                                    onRemove={() => onRemove(entry)}
                                />
                            </TableHead>
                        ))}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((row) => (
                        <TableRow
                            key={row.id}
                            data-differs={row.differs || undefined}
                            className="group/attr hover:bg-transparent"
                        >
                            <TableHead
                                scope="row"
                                className={cn(
                                    "sticky left-0 z-[1] h-auto border-l-2 py-2 align-top font-normal whitespace-normal",
                                    row.differs
                                        ? "border-l-primary text-foreground"
                                        : "border-l-transparent",
                                )}
                            >
                                {row.label}
                                {row.differs && <span className="sr-only"> (differs)</span>}
                            </TableHead>
                            {entries.map((entry) => (
                                <TableCell
                                    key={entry.id}
                                    className={cn(
                                        "py-2 align-top whitespace-normal",
                                        row.differs && "bg-accent/40 dark:bg-accent",
                                    )}
                                >
                                    {row.render ? row.render(entry) : row.key(entry)}
                                </TableCell>
                            ))}
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

export function DiscoverComparePage() {
    const router = useRouter();
    const refresh = useModelsRefresh();
    const raw = useRouterState({ select: (state) => state.location.search });
    const { ids, only, pool } = useMemo(() => readCompare(raw), [raw]);
    const catalog = useCatalog(pool);
    const data = catalog.data;
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
    const missing = ids.filter((id) => !byId.has(id));
    const known = ids.filter((id) => byId.has(id));
    const shown = known.slice(0, COMPARE_MAX);
    const extra = known.slice(COMPARE_MAX);
    const entries = shown.flatMap((id) => byId.get(id) ?? []);
    const go = (next: string[], nextOnly: boolean) =>
        router.history.replace(compareHref(next, pool, nextOnly));
    const rows = data
        ? attributes(data, pool).map((attribute) => ({
              ...attribute,
              differs: new Set(entries.map(attribute.key)).size > 1,
          }))
        : [];
    const differing = rows.filter((row) => row.differs).length;
    const visibleRows = only ? rows.filter((row) => row.differs) : rows;
    return (
        <Page wide>
            <Back ids={known} />
            <PageHeader
                title="Compare models"
                caption={
                    data && entries.length >= 2
                        ? `${entries.length} models side by side. Fit is estimated for ${poolPhrase(data)}.`
                        : "Models from the catalogue side by side."
                }
            />
            <ErrorLine error={catalog.error} />
            {catalog.isLoading && (
                <div className="flex flex-col gap-3">
                    <Skeleton className="h-8 w-64" />
                    <Skeleton className="h-96 w-full" />
                </div>
            )}
            {data && missing.length > 0 && (
                <StatusText tone="warning" className="text-sm whitespace-normal">
                    {`Not in the catalogue, so left out: ${missing.join(", ")}.`}
                </StatusText>
            )}
            {data && extra.length > 0 && (
                <StatusText tone="warning" className="text-sm whitespace-normal">
                    {`Compare shows up to ${COMPARE_MAX} models; left out: ${extra
                        .map((id) => byId.get(id)?.name ?? id)
                        .join(", ")}.`}
                </StatusText>
            )}
            {data && entries.length < 2 && <NotEnough ids={known} />}
            {data && entries.length >= 2 && (
                <>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <Label className="flex h-8 items-center gap-2 font-normal">
                            <Switch
                                checked={only}
                                onCheckedChange={(checked) => go(ids, checked)}
                            />
                            Only differences
                        </Label>
                        <span className="text-sm text-muted-foreground tabular-nums">
                            {`${differing} of ${rows.length} attributes differ; they are marked and tinted.`}
                        </span>
                    </div>
                    {visibleRows.length > 0 ? (
                        <CompareTable
                            entries={entries}
                            rows={visibleRows}
                            on={on}
                            pool={pool}
                            onRemove={(entry) =>
                                go(
                                    ids.filter((id) => id !== entry.id),
                                    only,
                                )
                            }
                        />
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            These models match on every attribute.
                        </p>
                    )}
                </>
            )}
        </Page>
    );
}
