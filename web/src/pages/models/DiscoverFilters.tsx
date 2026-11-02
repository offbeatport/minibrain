import { Button, Checkbox, Label, Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import type { ReactNode } from "react";
import type { CatalogEntry } from "~/api/client";
import { PublisherLogo } from "~/components/PublisherLogo";
import type { ModelsSearch } from "~/lib/modelsSearch";

const READY = "ready";
const NEEDS_ACCESS = "needs-access";
const NONE = "none";

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

type Facet = "access" | "publishers" | "tasks" | "tiers";

export type Filters = Record<Facet, string[]> & { q: string; fits: boolean };

const FACET_KEYS: Record<Facet, "access" | "provider" | "task" | "tier"> = {
    access: "access",
    publishers: "provider",
    tasks: "task",
    tiers: "tier",
};

const FACET_VALUES: Record<Facet, (entry: CatalogEntry) => string[]> = {
    access: (entry) => [entry.gated ? NEEDS_ACCESS : READY],
    publishers: (entry) => [entry.provider],
    tasks: (entry) => entry.capabilities,
    tiers: (entry) => [entry.tier],
};

function list(value: string | undefined): string[] {
    return value ? value.split(",").filter(Boolean) : [];
}

export function readFilters(search: ModelsSearch, fitsKnown: boolean): Filters {
    return {
        q: (search.q ?? "").trim().toLowerCase(),
        access: search.access ? list(search.access) : [READY],
        publishers: list(search.provider),
        tasks: list(search.task),
        tiers: list(search.tier),
        fits: search.fits === "true" && fitsKnown,
    };
}

export function fitsPool(entry: CatalogEntry): boolean {
    return entry.variants.some((variant) => ["fits", "limited"].includes(variant.fit.level));
}

export function matches(entry: CatalogEntry, filters: Filters, skip?: Facet): boolean {
    const text = `${entry.name} ${entry.description} ${entry.provider} ${entry.repo} ${entry.family} ${entry.architecture}`;
    if (filters.q && !text.toLowerCase().includes(filters.q)) {
        return false;
    }
    if (filters.fits && !fitsPool(entry)) {
        return false;
    }
    return (Object.keys(FACET_VALUES) as Facet[]).every(
        (facet) =>
            facet === skip ||
            filters[facet].length === 0 ||
            FACET_VALUES[facet](entry).some((value) => filters[facet].includes(value)),
    );
}

export function activeFilters(filters: Filters): number {
    const access = filters.access.join(",") === READY ? 0 : 1;
    return (
        access +
        filters.publishers.length +
        filters.tasks.length +
        filters.tiers.length +
        (filters.fits ? 1 : 0)
    );
}

export const CLEARED: ModelsSearch = {
    q: "",
    access: "",
    provider: "",
    task: "",
    tier: "",
    fits: "",
};

function encode(facet: Facet, values: string[]): string {
    if (facet !== "access") {
        return values.join(",");
    }
    if (values.length === 0) {
        return NONE;
    }
    return values.join(",") === READY ? "" : values.join(",");
}

function Group({ title, children }: { title: string; children: ReactNode }) {
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
        <Label className="flex min-w-0 items-center gap-2 font-normal">
            <Checkbox
                checked={checked}
                disabled={disabled}
                onCheckedChange={(next) => onChange(next === true)}
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
    fitsLabel,
    fitsHint,
}: {
    entries: CatalogEntry[];
    filters: Filters;
    update: (patch: ModelsSearch) => void;
    fitsKnown: boolean;
    fitsLabel: string;
    fitsHint: string;
}) {
    const count = (facet: Facet, value: string) =>
        entries.filter(
            (entry) => matches(entry, filters, facet) && FACET_VALUES[facet](entry).includes(value),
        ).length;
    const toggle = (facet: Facet, value: string, checked: boolean) => {
        const next = checked
            ? [...filters[facet], value]
            : filters[facet].filter((item) => item !== value);
        update({ [FACET_KEYS[facet]]: encode(facet, next) });
    };
    const option = (facet: Facet, value: string, label: ReactNode) => (
        <Option
            key={value}
            checked={filters[facet].includes(value)}
            onChange={(checked) => toggle(facet, value, checked)}
            count={count(facet, value)}
        >
            {label}
        </Option>
    );
    const publishers = [...new Set(entries.map((entry) => entry.provider))].sort();
    const tasks = [...new Set(entries.flatMap((entry) => entry.capabilities))].sort();
    return (
        <div className="flex flex-col divide-y rounded-md border bg-card">
            <div className="flex h-10 items-center justify-between px-3">
                <span className="text-sm font-semibold">Filters</span>
                {activeFilters(filters) > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => update(CLEARED)}>
                        Clear
                    </Button>
                )}
            </div>
            <Group title="Download">
                {ACCESS.map((item) => option("access", item.value, item.label))}
            </Group>
            <Group title="Hardware">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <span>
                            <Option
                                checked={filters.fits}
                                disabled={!fitsKnown}
                                onChange={(checked) => update({ fits: checked ? "true" : "" })}
                            >
                                {`Fits ${fitsLabel}`}
                            </Option>
                        </span>
                    </TooltipTrigger>
                    <TooltipContent>{fitsHint}</TooltipContent>
                </Tooltip>
            </Group>
            <Group title="Publisher">
                {publishers.map((publisher) =>
                    option(
                        "publishers",
                        publisher,
                        <>
                            <PublisherLogo publisher={publisher} name={publisher} size="sm" />
                            <span className="truncate">{publisher}</span>
                        </>,
                    ),
                )}
            </Group>
            <Group title="Task">{tasks.map((task) => option("tasks", task, task))}</Group>
            <Group title="Size">
                {TIERS.map((tier) => option("tiers", tier.value, tier.label))}
            </Group>
        </div>
    );
}
