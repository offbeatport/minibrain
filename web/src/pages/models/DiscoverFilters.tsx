import { Button, Checkbox, Label, cn } from "obp-ui";
import { Fragment, type ReactNode, useState } from "react";
import type { CatalogEntry, CatalogVariantInfo, FitInfo } from "~/api/client";
import { PublisherLogo } from "~/components/PublisherLogo";
import type { ModelsSearch, ModelsSearchKey } from "~/lib/modelsSearch";
import type { RunsHere } from "./runsHere";

const READY = "ready";
const NEEDS_ACCESS = "needs-access";
const ANY = "all";
const YES = "yes";

export const FIT_ORDER: FitInfo["level"][] = ["fits", "limited", "unknown", "insufficient"];

export function bestFit(entry: CatalogEntry): CatalogVariantInfo {
    return [...entry.variants].sort(
        (a, b) => FIT_ORDER.indexOf(a.fit.level) - FIT_ORDER.indexOf(b.fit.level),
    )[0];
}

const ACCESS = [
    { value: READY, label: "Open access" },
    { value: NEEDS_ACCESS, label: "Needs access" },
];

export const TIERS = [
    { value: "S", label: "S · up to 4B" },
    { value: "M", label: "M · 7–14B" },
    { value: "L", label: "L · 24–35B" },
    { value: "XL", label: "XL · 70B+, multi-GPU" },
];

export type LicenceUse = CatalogEntry["license_use"];

const LICENCE_USES: { value: LicenceUse; label: string }[] = [
    { value: "commercial", label: "Allowed" },
    { value: "restricted", label: "With conditions" },
    { value: "non-commercial", label: "Not allowed" },
    { value: "unknown", label: "Unreviewed" },
];

export function licenceUseLabel(use: LicenceUse): string {
    return LICENCE_USES.find((item) => item.value === use)?.label ?? use;
}

type Facet = "access" | "publishers" | "tasks" | "tiers" | "uses" | "licences" | "latest";

export type Filters = Record<Facet, string[]> & { q: string; runs: RunsHere | null };

const FACET_KEYS: Record<Facet, ModelsSearchKey> = {
    access: "access",
    publishers: "provider",
    tasks: "task",
    tiers: "tier",
    uses: "use",
    licences: "licence",
    latest: "latest",
};

const FACETS = Object.keys(FACET_KEYS) as Facet[];
const PANEL_FACETS: Facet[] = ["tasks", "tiers", "uses", "licences", "publishers", "access"];

export function licenceOf(entry: CatalogEntry): string {
    return entry.license_name || entry.license;
}

const FACET_VALUES: Record<Facet, (entry: CatalogEntry) => string[]> = {
    access: (entry) => [entry.gated ? NEEDS_ACCESS : READY],
    publishers: (entry) => [entry.provider],
    tasks: (entry) => entry.capabilities,
    tiers: (entry) => [entry.tier],
    uses: (entry) => [entry.license_use],
    licences: (entry) => [licenceOf(entry)],
    latest: (entry) => (entry.superseded_by ? [] : [YES]),
};

const LABELS: Partial<Record<Facet, Record<string, string>>> = {
    access: Object.fromEntries(ACCESS.map((item) => [item.value, item.label])),
    tiers: Object.fromEntries(TIERS.map((item) => [item.value, item.label])),
    uses: Object.fromEntries(LICENCE_USES.map((item) => [item.value, item.label])),
};

function labelOf(facet: Facet, value: string): string {
    return LABELS[facet]?.[value] ?? value;
}

function list(value: string | undefined): string[] {
    return value ? value.split(",").filter(Boolean) : [];
}

function readAccess(value: string | undefined): string[] {
    return value === ANY ? [] : list(value);
}

export function readFilters(search: ModelsSearch, runsHere: RunsHere): Filters {
    return {
        q: (search.q ?? "").trim().toLowerCase(),
        access: readAccess(search.access),
        publishers: list(search.provider),
        tasks: list(search.task),
        tiers: list(search.tier),
        uses: list(search.use),
        licences: list(search.licence),
        latest: list(search.latest),
        runs: search.fits === "true" ? runsHere : null,
    };
}

function facetHit(entry: CatalogEntry, filters: Filters, facet: Facet): boolean {
    return (
        filters[facet].length === 0 ||
        FACET_VALUES[facet](entry).some((value) => filters[facet].includes(value))
    );
}

export function matches(entry: CatalogEntry, filters: Filters, skip?: Facet | "runs"): boolean {
    const text = `${entry.name} ${entry.description} ${entry.provider} ${entry.repo} ${entry.family} ${entry.architecture}`;
    if (filters.q && !text.toLowerCase().includes(filters.q)) {
        return false;
    }
    if (filters.runs && skip !== "runs" && !filters.runs(entry)) {
        return false;
    }
    return FACETS.every((facet) => facet === skip || facetHit(entry, filters, facet));
}

export function activeFilters(filters: Filters): number {
    const toggles = (filters.runs ? 1 : 0) + (latestOnly(filters) ? 1 : 0);
    return PANEL_FACETS.reduce((sum, facet) => sum + filters[facet].length, toggles);
}

const FILTERS_CLEARED: ModelsSearch = {
    access: "",
    provider: "",
    task: "",
    tier: "",
    licence: "",
    use: "",
    fits: "",
    latest: "",
};

export const CLEARED: ModelsSearch = { ...FILTERS_CLEARED, q: "" };

export function runsHerePatch(on: boolean): ModelsSearch {
    return { fits: on ? "true" : "" };
}

export function latestPatch(on: boolean): ModelsSearch {
    return { latest: on ? YES : "" };
}

export function latestOnly(filters: Filters): boolean {
    return filters.latest.includes(YES);
}

function encode(facet: Facet, values: string[]): ModelsSearch {
    return { [FACET_KEYS[facet]]: values.join(",") };
}

const SHOWN = 5;

type OptionItem = { key: string; checked: boolean; node: ReactNode };

function OptionList({ items, limit = SHOWN }: { items: OptionItem[]; limit?: number }) {
    const [expanded, setExpanded] = useState(false);
    const hidden = items.filter((item, index) => index >= limit && !item.checked).length;
    const shown = expanded ? items : items.filter((item, index) => index < limit || item.checked);
    return (
        <>
            {shown.map((item) => (
                <Fragment key={item.key}>{item.node}</Fragment>
            ))}
            {hidden > 0 && (
                <button
                    type="button"
                    onClick={() => setExpanded(!expanded)}
                    className="mt-1 w-fit rounded-sm text-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                    {expanded ? "Show less" : `Show ${hidden} more`}
                </button>
            )}
        </>
    );
}

function Group({ title, children }: { title: ReactNode; children: ReactNode }) {
    return (
        <fieldset className="flex flex-col px-4 py-4">
            <legend className="float-left mb-2 text-sm font-semibold">{title}</legend>
            {children}
        </fieldset>
    );
}

export function Option({
    checked,
    onChange,
    count,
    disabled,
    children,
}: {
    checked: boolean | "indeterminate";
    onChange: (checked: boolean) => void;
    count?: number;
    disabled?: boolean;
    children: ReactNode;
}) {
    return (
        <Label
            className={cn(
                "-mx-1.5 flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1 font-normal leading-snug",
                disabled ? "text-muted-foreground" : "cursor-pointer hover:bg-secondary",
            )}
        >
            <Checkbox
                checked={checked}
                disabled={disabled}
                onCheckedChange={(next) => onChange(next === true)}
                className="mt-px"
            />
            <span className="flex min-w-0 flex-1 items-center gap-1">{children}</span>
            {count !== undefined && (
                <span className="text-sm text-muted-foreground tabular-nums">{count}</span>
            )}
        </Label>
    );
}

export function FilterPanel({
    entries,
    filters,
    update,
    toggles,
}: {
    entries: CatalogEntry[];
    filters: Filters;
    update: (patch: ModelsSearch) => void;
    toggles: ReactNode;
}) {
    const count = (facet: Facet, value: string) =>
        entries.filter(
            (entry) => matches(entry, filters, facet) && FACET_VALUES[facet](entry).includes(value),
        ).length;
    const toggle = (facet: Facet, value: string, checked: boolean) => {
        const next = checked
            ? [...filters[facet], value]
            : filters[facet].filter((item) => item !== value);
        update(encode(facet, next));
    };
    const option = (facet: Facet, value: string, label: ReactNode = labelOf(facet, value)) => (
        <Option
            key={value}
            checked={filters[facet].includes(value)}
            onChange={(checked) => toggle(facet, value, checked)}
            count={count(facet, value)}
        >
            {label}
        </Option>
    );
    const items = (facet: Facet, values: string[], label?: (value: string) => ReactNode) =>
        values.map((value) => ({
            key: value,
            checked: filters[facet].includes(value),
            node: option(facet, value, label ? label(value) : undefined),
        }));
    const distinct = (facet: Facet) =>
        [...new Set(entries.flatMap((entry) => FACET_VALUES[facet](entry)))].sort();
    const popularity = (facet: Facet) => {
        const tally = new Map<string, number>();
        for (const value of entries.flatMap((entry) => FACET_VALUES[facet](entry))) {
            tally.set(value, (tally.get(value) ?? 0) + 1);
        }
        return tally;
    };
    const byPopularity = (facet: Facet) => {
        const tally = popularity(facet);
        return [...tally.keys()].sort(
            (left, right) =>
                (tally.get(right) ?? 0) - (tally.get(left) ?? 0) || left.localeCompare(right),
        );
    };
    const active = activeFilters(filters);
    return (
        <div className="flex flex-col divide-y rounded-md border bg-card">
            <div className="flex h-12 items-center gap-2 px-4">
                <span className="text-sm font-semibold">Filters</span>
                {active > 0 && (
                    <>
                        <span className="text-sm text-muted-foreground tabular-nums">
                            {`${active} active`}
                        </span>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="ml-auto"
                            onClick={() => update(FILTERS_CLEARED)}
                        >
                            Clear all
                        </Button>
                    </>
                )}
            </div>
            <div className="flex flex-col px-4 py-4">{toggles}</div>
            <Group title="Task">
                <OptionList items={items("tasks", distinct("tasks"))} />
            </Group>
            <Group title="Size">
                <OptionList
                    items={items(
                        "tiers",
                        TIERS.map((tier) => tier.value),
                    )}
                />
            </Group>
            <Group title="Publisher">
                <OptionList
                    items={items("publishers", distinct("publishers"), (publisher) => (
                        <>
                            <PublisherLogo publisher={publisher} name={publisher} size="sm" />
                            <span className="line-clamp-2 break-words">{publisher}</span>
                        </>
                    ))}
                />
            </Group>
            <Group title="Commercial use">
                {LICENCE_USES.filter(
                    (use) => use.value !== "unknown" || popularity("uses").has("unknown"),
                ).map((use) => option("uses", use.value))}
            </Group>
            <Group title="Licence">
                <OptionList
                    limit={2}
                    items={items("licences", byPopularity("licences"), (licence) => (
                        <span className="line-clamp-2 break-words">{licence}</span>
                    ))}
                />
            </Group>
            <Group title="Access">{ACCESS.map((item) => option("access", item.value))}</Group>
        </div>
    );
}
