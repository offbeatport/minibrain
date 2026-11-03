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

export function bestFit(entry: CatalogEntry): CatalogVariantInfo {
    return [...entry.variants].sort(
        (a, b) => FIT_ORDER.indexOf(a.fit.level) - FIT_ORDER.indexOf(b.fit.level),
    )[0];
}

const ACCESS = [
    { value: READY, label: "One-click download" },
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
    { value: "commercial", label: "Commercial use allowed" },
    { value: "restricted", label: "Commercial use with conditions" },
    { value: "non-commercial", label: "Non-commercial only" },
    { value: "unknown", label: "Check the terms" },
];

export function licenceUseLabel(use: LicenceUse): string {
    return LICENCE_USES.find((item) => item.value === use)?.label ?? use;
}

type Facet = "access" | "publishers" | "tasks" | "tiers" | "fit" | "uses" | "licences" | "latest";

export type Filters = Record<Facet, string[]> & { q: string };

const FACET_KEYS: Record<Facet, ModelsSearchKey> = {
    access: "access",
    publishers: "provider",
    tasks: "task",
    tiers: "tier",
    fit: "fit",
    uses: "use",
    licences: "licence",
    latest: "latest",
};

const FACETS = Object.keys(FACET_KEYS) as Facet[];
const LICENCE_FACETS: Facet[] = ["uses", "licences"];
const PANEL_FACETS: Facet[] = ["tasks", "tiers", "uses", "licences", "publishers", "access"];

export function licenceOf(entry: CatalogEntry): string {
    return entry.license_name || entry.license;
}

const FACET_VALUES: Record<Facet, (entry: CatalogEntry) => string[]> = {
    access: (entry) => [entry.gated ? NEEDS_ACCESS : READY],
    publishers: (entry) => [entry.provider],
    tasks: (entry) => entry.capabilities,
    tiers: (entry) => [entry.tier],
    fit: (entry) => [bestFit(entry).fit.level],
    uses: (entry) => [entry.license_use],
    licences: (entry) => [licenceOf(entry)],
    latest: (entry) => (entry.superseded_by ? [] : [YES]),
};

const LABELS: Partial<Record<Facet, Record<string, string>>> = {
    access: Object.fromEntries(ACCESS.map((item) => [item.value, item.label])),
    tiers: Object.fromEntries(TIERS.map((item) => [item.value, item.label])),
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
        uses: list(search.use),
        licences: list(search.licence),
        latest: list(search.latest),
    };
}

function facetHit(entry: CatalogEntry, filters: Filters, facet: Facet): boolean {
    return (
        filters[facet].length === 0 ||
        FACET_VALUES[facet](entry).some((value) => filters[facet].includes(value))
    );
}

function licenceHit(entry: CatalogEntry, filters: Filters): boolean {
    if (filters.uses.length === 0 && filters.licences.length === 0) {
        return true;
    }
    return filters.uses.includes(entry.license_use) || filters.licences.includes(licenceOf(entry));
}

export function matches(entry: CatalogEntry, filters: Filters, skip?: Facet): boolean {
    const text = `${entry.name} ${entry.description} ${entry.provider} ${entry.repo} ${entry.family} ${entry.architecture}`;
    if (filters.q && !text.toLowerCase().includes(filters.q)) {
        return false;
    }
    const skipLicence = skip !== undefined && LICENCE_FACETS.includes(skip);
    return (
        FACETS.every(
            (facet) =>
                facet === skip || LICENCE_FACETS.includes(facet) || facetHit(entry, filters, facet),
        ) &&
        (skipLicence || licenceHit(entry, filters))
    );
}

export function activeFilters(filters: Filters): number {
    const toggles = (filters.fit.length > 0 ? 1 : 0) + (latestOnly(filters) ? 1 : 0);
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
    fit: "",
    latest: "",
};

export const CLEARED: ModelsSearch = { ...FILTERS_CLEARED, q: "" };

export function fitsPatch(on: boolean): ModelsSearch {
    return { fit: "", fits: on ? "true" : "" };
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
    children,
}: {
    checked: boolean | "indeterminate";
    onChange: (checked: boolean) => void;
    count?: number;
    children: ReactNode;
}) {
    return (
        <Label className="flex min-w-0 items-start gap-2 font-normal leading-snug">
            <Checkbox
                checked={checked}
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

function LicenceOptions({
    entries,
    filters,
    update,
    count,
}: {
    entries: CatalogEntry[];
    filters: Filters;
    update: (patch: ModelsSearch) => void;
    count: (facet: Facet, value: string) => number;
}) {
    const uses = new Map(entries.map((entry) => [licenceOf(entry), entry.license_use]));
    const namesOf = (use: LicenceUse) =>
        [...uses]
            .filter(([, found]) => found === use)
            .map(([name]) => name)
            .sort();
    const groups = LICENCE_USES.filter(
        (group) => group.value !== "unknown" || namesOf("unknown").length > 0,
    );
    const save = (picked: string[], names: string[]) =>
        update({ use: picked.join(","), licence: [...new Set(names)].join(",") });
    const toggleGroup = (use: LicenceUse, checked: boolean) => {
        const names = namesOf(use);
        const others = filters.uses.filter((value) => value !== use);
        save(
            checked ? [...others, use] : others,
            filters.licences.filter((name) => !names.includes(name)),
        );
    };
    const toggleName = (use: LicenceUse, name: string, checked: boolean) => {
        const names = namesOf(use);
        const current = filters.uses.includes(use)
            ? [...filters.licences, ...names]
            : filters.licences;
        const next = checked ? [...current, name] : current.filter((item) => item !== name);
        const others = filters.uses.filter((value) => value !== use);
        const whole = names.length > 0 && names.every((item) => next.includes(item));
        save(
            whole ? [...others, use] : others,
            whole ? next.filter((item) => !names.includes(item)) : next,
        );
    };
    return groups.map((group) => {
        const names = namesOf(group.value);
        const grouped = filters.uses.includes(group.value);
        const picked = names.filter((name) => grouped || filters.licences.includes(name));
        const state =
            grouped || (names.length > 0 && picked.length === names.length)
                ? true
                : picked.length > 0
                  ? "indeterminate"
                  : false;
        return (
            <Fragment key={group.value}>
                <Option
                    checked={state}
                    onChange={(checked) => toggleGroup(group.value, checked)}
                    count={count("uses", group.value)}
                >
                    {group.label}
                </Option>
                {names.length > 0 && (
                    <div className="flex flex-col gap-2 pl-6">
                        {names.map((name) => (
                            <Option
                                key={name}
                                checked={picked.includes(name)}
                                onChange={(checked) => toggleName(group.value, name, checked)}
                                count={count("licences", name)}
                            >
                                <span className="line-clamp-2 break-words">{name}</span>
                            </Option>
                        ))}
                    </div>
                )}
            </Fragment>
        );
    });
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
    const active = activeFilters(filters);
    return (
        <div className="flex flex-col divide-y rounded-md border bg-card">
            <div className="flex h-10 items-center gap-2 px-3">
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
            <div className="flex flex-col gap-3 px-3 py-3">{toggles}</div>
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
                <LicenceOptions entries={entries} filters={filters} update={update} count={count} />
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
            <Group title="Access">{ACCESS.map((item) => option("access", item.value))}</Group>
        </div>
    );
}
