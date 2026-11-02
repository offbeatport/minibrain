import { X } from "lucide-react";
import { Button, Checkbox, Label } from "obp-ui";
import { Fragment, type ReactNode, useState } from "react";
import type { CatalogEntry, CatalogVariantInfo, FitInfo } from "~/api/client";
import { PublisherLogo } from "~/components/PublisherLogo";
import type { ModelsSearch, ModelsSearchKey } from "~/lib/modelsSearch";

const READY = "ready";
const NEEDS_ACCESS = "needs-access";
const ANY = "all";
const YES = "yes";

export const FIT_ORDER: FitInfo["level"][] = ["fits", "limited", "unknown", "insufficient"];

const FIT_OPTIONS: Record<FitInfo["level"], string> = {
    fits: "Fits",
    limited: "Limited headroom",
    insufficient: "Won't fit",
    unknown: "Not checked",
};

export function bestFit(entry: CatalogEntry): CatalogVariantInfo {
    return [...entry.variants].sort(
        (a, b) => FIT_ORDER.indexOf(a.fit.level) - FIT_ORDER.indexOf(b.fit.level),
    )[0];
}

const ACCESS = [
    { value: READY, label: "One-click download" },
    { value: NEEDS_ACCESS, label: "Needs access" },
];

const TIERS = [
    { value: "S", label: "S · up to 4B" },
    { value: "M", label: "M · 7–14B" },
    { value: "L", label: "L · 24–35B" },
    { value: "XL", label: "XL · 70B+, multi-GPU" },
];

type Facet = "access" | "publishers" | "tasks" | "tiers" | "fit" | "licences" | "train" | "latest";

export type Filters = Record<Facet, string[]> & { q: string };

const FACET_KEYS: Record<Facet, ModelsSearchKey> = {
    access: "access",
    publishers: "provider",
    tasks: "task",
    tiers: "tier",
    fit: "fit",
    licences: "licence",
    train: "train",
    latest: "latest",
};

const FACETS = Object.keys(FACET_KEYS) as Facet[];

function licenceOf(entry: CatalogEntry): string {
    return entry.license_name || entry.license;
}

const FACET_VALUES: Record<Facet, (entry: CatalogEntry) => string[]> = {
    access: (entry) => [entry.gated ? NEEDS_ACCESS : READY],
    publishers: (entry) => [entry.provider],
    tasks: (entry) => entry.capabilities,
    tiers: (entry) => [entry.tier],
    fit: (entry) => [bestFit(entry).fit.level],
    licences: (entry) => [licenceOf(entry)],
    train: (entry) => (entry.trainable ? [YES] : []),
    latest: (entry) => (entry.superseded_by ? [] : [YES]),
};

const LABELS: Partial<Record<Facet, Record<string, string>>> = {
    access: Object.fromEntries(ACCESS.map((item) => [item.value, item.label])),
    tiers: Object.fromEntries(TIERS.map((item) => [item.value, item.label])),
    fit: FIT_OPTIONS,
    train: { [YES]: "Can fine-tune" },
    latest: { [YES]: "Latest generation only" },
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

function readFit(search: ModelsSearch): string[] {
    if (search.fit) {
        return list(search.fit);
    }
    return search.fits === "true" ? ["fits", "limited"] : [];
}

export function readFilters(search: ModelsSearch, fitsKnown: boolean): Filters {
    return {
        q: (search.q ?? "").trim().toLowerCase(),
        access: readAccess(search.access),
        publishers: list(search.provider),
        tasks: list(search.task),
        tiers: list(search.tier),
        fit: fitsKnown ? readFit(search) : [],
        licences: list(search.licence),
        train: list(search.train),
        latest: list(search.latest),
    };
}

export function matches(entry: CatalogEntry, filters: Filters, skip?: Facet): boolean {
    const text = `${entry.name} ${entry.description} ${entry.provider} ${entry.repo} ${entry.family} ${entry.architecture}`;
    if (filters.q && !text.toLowerCase().includes(filters.q)) {
        return false;
    }
    return FACETS.every(
        (facet) =>
            facet === skip ||
            filters[facet].length === 0 ||
            FACET_VALUES[facet](entry).some((value) => filters[facet].includes(value)),
    );
}

type Chip = { facet: Facet; value: string; label: string };

export function chipsOf(filters: Filters): Chip[] {
    const chips: Chip[] = [];
    for (const facet of FACETS) {
        for (const value of filters[facet]) {
            chips.push({ facet, value, label: labelOf(facet, value) });
        }
    }
    return chips;
}

export function activeFilters(filters: Filters): number {
    return chipsOf(filters).length;
}

const FILTERS_CLEARED: ModelsSearch = {
    access: "",
    provider: "",
    task: "",
    tier: "",
    fits: "",
    fit: "",
    licence: "",
    train: "",
    latest: "",
};

export const CLEARED: ModelsSearch = { ...FILTERS_CLEARED, q: "" };

function encode(facet: Facet, values: string[]): ModelsSearch {
    const patch: ModelsSearch = { [FACET_KEYS[facet]]: values.join(",") };
    if (facet === "fit") {
        patch.fits = "";
    }
    return patch;
}

function removal(chip: Chip, filters: Filters): ModelsSearch {
    return encode(
        chip.facet,
        filters[chip.facet].filter((value) => value !== chip.value),
    );
}

export function FilterChips({
    filters,
    update,
}: {
    filters: Filters;
    update: (patch: ModelsSearch) => void;
}) {
    const chips = chipsOf(filters);
    if (chips.length === 0) {
        return null;
    }
    return (
        <div className="flex flex-wrap items-center gap-2">
            {chips.map((chip) => (
                <span
                    key={`${chip.facet}:${chip.value}`}
                    className="inline-flex h-7 items-center gap-1 rounded-md border bg-card pr-1 pl-2 text-sm"
                >
                    {chip.label}
                    <button
                        type="button"
                        aria-label={`Remove filter ${chip.label}`}
                        className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
                        onClick={() => update(removal(chip, filters))}
                    >
                        <X className="size-3.5" />
                    </button>
                </span>
            ))}
            <Button variant="ghost" size="sm" onClick={() => update(FILTERS_CLEARED)}>
                Clear all
            </Button>
        </div>
    );
}

const SHOWN = 5;

type OptionItem = { key: string; checked: boolean; node: ReactNode };

function OptionList({ items }: { items: OptionItem[] }) {
    const [expanded, setExpanded] = useState(false);
    const hidden = items.filter((item, index) => index >= SHOWN && !item.checked).length;
    const shown = expanded ? items : items.filter((item, index) => index < SHOWN || item.checked);
    return (
        <>
            {shown.map((item) => (
                <Fragment key={item.key}>{item.node}</Fragment>
            ))}
            {hidden > 0 && (
                <button
                    type="button"
                    onClick={() => setExpanded(!expanded)}
                    className="w-fit rounded-sm text-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                    {expanded ? "Show less" : `Show ${hidden} more`}
                </button>
            )}
        </>
    );
}

function Group({ title, children }: { title: ReactNode; children: ReactNode }) {
    return (
        <fieldset className="flex flex-col gap-2 px-3 py-3">
            <legend className="float-left mb-1 text-sm font-semibold">{title}</legend>
            {children}
        </fieldset>
    );
}

function Option({
    checked,
    onChange,
    count,
    disabled,
    children,
}: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    count?: number;
    disabled?: boolean;
    children: ReactNode;
}) {
    return (
        <Label className="flex min-w-0 items-start gap-2 font-normal leading-snug">
            <Checkbox
                checked={checked}
                disabled={disabled}
                onCheckedChange={(next) => onChange(next === true)}
                className="mt-px"
            />
            <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
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
    fitsKnown,
    fitsHint,
    pool,
}: {
    entries: CatalogEntry[];
    filters: Filters;
    update: (patch: ModelsSearch) => void;
    fitsKnown: boolean;
    fitsHint: string;
    pool: ReactNode;
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
    return (
        <div className="flex flex-col divide-y rounded-md border bg-card">
            <div className="flex h-10 items-center justify-between px-3">
                <span className="text-sm font-semibold">Filters</span>
                {activeFilters(filters) > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => update(FILTERS_CLEARED)}>
                        Clear
                    </Button>
                )}
            </div>
            <Group title="Hardware fit">
                {pool}
                <p className="text-sm text-muted-foreground">{fitsHint}</p>
                {fitsKnown &&
                    FIT_ORDER.filter((level) => level !== "unknown").map((level) =>
                        option("fit", level),
                    )}
            </Group>
            <Group title="Use">
                {option("train", YES)}
                {option("latest", YES)}
            </Group>
            <Group title="Download">{ACCESS.map((item) => option("access", item.value))}</Group>
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
            <Group title="Licence">
                <OptionList
                    items={items("licences", distinct("licences"), (licence) => (
                        <span className="line-clamp-2 break-words">{licence}</span>
                    ))}
                />
            </Group>
        </div>
    );
}
