import { Settings2, X } from "lucide-react";
import {
    Button,
    Checkbox,
    Label,
    Popover,
    PopoverContent,
    PopoverTrigger,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectItem,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
    Switch,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { PublisherLogo } from "~/components/PublisherLogo";
import {
    type FlowModel,
    attention,
    baseModelSlug,
    liveVersion,
    newestFirst,
    trainingVersion,
} from "./modelsFlowData";
import { COLUMNS, type Column, plural } from "./modelsFlowRows";

export type StatusKey = "deployed" | "off" | "attention" | "training" | "failed";
export type KindKey = "custom" | "base";
export type SortKey = "attention" | "name" | "score" | "requests" | "recent";
export type Filters = { status: StatusKey[]; kind: KindKey[]; base: string | null };

export const NO_FILTERS: Filters = { status: [], kind: [], base: null };
export const DEFAULT_SORT: SortKey = "attention";
const ANY_BASE = "any";

const STATUSES: { value: StatusKey; label: string; test: (model: FlowModel) => boolean }[] = [
    { value: "deployed", label: "Deployed", test: (model) => model.deployed },
    { value: "off", label: "Not deployed", test: (model) => !model.deployed },
    { value: "attention", label: "Needs attention", test: (model) => attention(model) !== null },
    { value: "training", label: "Training", test: (model) => trainingVersion(model) !== undefined },
    {
        value: "failed",
        label: "Failed",
        test: (model) => newestFirst(model)[0]?.status === "failed",
    },
];

const KINDS: { value: KindKey; label: string }[] = [
    { value: "custom", label: "Custom" },
    { value: "base", label: "Base" },
];

const SORTS: { value: SortKey; label: string; detail?: string }[] = [
    { value: "attention", label: "Needs attention first" },
    { value: "name", label: "Name", detail: "A to Z" },
    { value: "score", label: "Score", detail: "High to low" },
    { value: "requests", label: "Requests", detail: "Most first" },
    { value: "recent", label: "Recently updated", detail: "Newest first" },
];

export function baseOf(model: FlowModel): string | null {
    if (model.kind === "base") {
        return model.slug;
    }
    return model.base ? baseModelSlug(model.base) : null;
}

function statusPasses(model: FlowModel, status: StatusKey[]): boolean {
    return (
        status.length === 0 ||
        STATUSES.some((option) => status.includes(option.value) && option.test(model))
    );
}

export function passes(model: FlowModel, filters: Filters, skip?: keyof Filters): boolean {
    return (
        (skip === "status" || statusPasses(model, filters.status)) &&
        (skip === "kind" || filters.kind.length === 0 || filters.kind.includes(model.kind)) &&
        (skip === "base" || filters.base === null || baseOf(model) === filters.base)
    );
}

function scoreOf(model: FlowModel): number {
    const live = liveVersion(model)?.scores?.[0];
    return live ?? Math.max(-1, ...model.versions.map((version) => version.scores?.[0] ?? -1));
}

function requestsOf(model: FlowModel): number {
    return model.traffic.reduce((sum, value) => sum + value, 0);
}

function hoursSinceUpdate(model: FlowModel): number {
    return Math.min(
        Number.POSITIVE_INFINITY,
        ...model.versions.map((version) =>
            version.atMs ? (Date.now() - version.atMs) / 3600000 : version.hoursAgo,
        ),
    );
}

const COMPARE: Record<SortKey, (a: FlowModel, b: FlowModel) => number> = {
    attention: (a, b) =>
        Number(attention(b) !== null) - Number(attention(a) !== null) ||
        Number(a.kind === "base") - Number(b.kind === "base"),
    name: (a, b) => a.name.localeCompare(b.name),
    score: (a, b) => scoreOf(b) - scoreOf(a),
    requests: (a, b) => requestsOf(b) - requestsOf(a),
    recent: (a, b) => hoursSinceUpdate(a) - hoursSinceUpdate(b),
};

export function sortModels(models: FlowModel[], sort: SortKey): FlowModel[] {
    return [...models].sort(COMPARE[sort]).sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

export function activeCount(filters: Filters): number {
    return filters.status.length + filters.kind.length + (filters.base === null ? 0 : 1);
}

type BaseOption = { slug: string; name: string; publisher: string };

export function baseOptions(models: FlowModel[]): BaseOption[] {
    const found = new Map<string, BaseOption>();
    for (const model of models.filter((item) => item.kind === "base")) {
        found.set(model.slug, { slug: model.slug, name: model.name, publisher: model.publisher });
    }
    for (const model of models) {
        const slug = baseOf(model);
        if (slug && !found.has(slug) && model.base) {
            found.set(slug, { slug, name: model.base, publisher: model.publisher });
        }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function toggled<T>(list: T[], value: T, on: boolean, order: T[]): T[] {
    return on
        ? order.filter((item) => item === value || list.includes(item))
        : list.filter((item) => item !== value);
}

function moveFocus(event: KeyboardEvent<HTMLElement>) {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    const target = event.target as HTMLElement;
    const scope = target.closest("[data-arrow-scope]");
    if (!step || !scope || !target.matches("[role=checkbox],[role=switch]")) {
        return;
    }
    const items = [...scope.querySelectorAll<HTMLElement>("[role=checkbox],[role=switch]")];
    const next = items[items.indexOf(target) + step];
    if (next) {
        event.preventDefault();
        next.focus();
    }
}

function PanelHeading({ id, children }: { id: string; children: ReactNode }) {
    return (
        <h3 id={id} className="px-2.5 pt-1.5 pb-1 text-base font-medium">
            {children}
        </h3>
    );
}

function GroupLabel({ children }: { children: ReactNode }) {
    return <legend className="px-2.5 pt-2 pb-1 text-sm text-muted-foreground">{children}</legend>;
}

function Count({ value }: { value: number }) {
    return <span className="text-sm text-muted-foreground tabular-nums">{value}</span>;
}

const ROW = "flex h-8 items-center gap-2.5 rounded-sm px-2.5 font-normal hover:bg-secondary";

function CheckRow({
    label,
    count,
    checked,
    onChange,
}: {
    label: string;
    count?: number;
    checked: boolean;
    onChange: (on: boolean) => void;
}) {
    return (
        <Label className={cn(ROW, count === 0 && !checked && "text-muted-foreground")}>
            <Checkbox checked={checked} onCheckedChange={(next) => onChange(next === true)} />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {count !== undefined && <Count value={count} />}
        </Label>
    );
}

function BaseLabel({ option }: { option: BaseOption }) {
    return (
        <>
            <PublisherLogo publisher={option.publisher} name={option.name} size="sm" />
            <span className="truncate">{option.name}</span>
        </>
    );
}

function BasePicker({
    id,
    options,
    counts,
    value,
    onChange,
}: {
    id: string;
    options: BaseOption[];
    counts: Map<string, number>;
    value: string | null;
    onChange: (value: string | null) => void;
}) {
    const chosen = options.find((option) => option.slug === value);
    return (
        <Select
            value={value ?? ANY_BASE}
            onValueChange={(next) => onChange(next === ANY_BASE ? null : String(next))}
        >
            <SelectTrigger id={id} className="w-full">
                <SelectValue>
                    {chosen ? <BaseLabel option={chosen} /> : "Any base model"}
                </SelectValue>
            </SelectTrigger>
            <SelectContent>
                <SelectItem value={ANY_BASE} label="Any base model">
                    Any base model
                </SelectItem>
                <SelectSeparator />
                {options.map((option) => (
                    <SelectItem key={option.slug} value={option.slug} label={option.name}>
                        <BaseLabel option={option} />
                        <span className="ml-auto pl-3 text-sm text-muted-foreground tabular-nums">
                            {counts.get(option.slug) ?? 0}
                        </span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function FilterSection({
    pool,
    options,
    filters,
    onFilters,
}: {
    pool: FlowModel[];
    options: BaseOption[];
    filters: Filters;
    onFilters: (value: Filters) => void;
}) {
    const id = useId();
    const count = (skip: keyof Filters, test: (model: FlowModel) => boolean) =>
        pool.filter((model) => passes(model, filters, skip) && test(model)).length;
    const baseCounts = new Map(
        options.map((option) => [
            option.slug,
            count("base", (model) => baseOf(model) === option.slug),
        ]),
    );
    return (
        <section aria-labelledby={`${id}-filter`} className="p-1.5" data-arrow-scope="">
            <PanelHeading id={`${id}-filter`}>Filter</PanelHeading>
            <fieldset className="flex flex-col">
                <GroupLabel>Status</GroupLabel>
                {STATUSES.map((option) => (
                    <CheckRow
                        key={option.value}
                        label={option.label}
                        count={count("status", option.test)}
                        checked={filters.status.includes(option.value)}
                        onChange={(on) =>
                            onFilters({
                                ...filters,
                                status: toggled(
                                    filters.status,
                                    option.value,
                                    on,
                                    STATUSES.map((item) => item.value),
                                ),
                            })
                        }
                    />
                ))}
            </fieldset>
            <fieldset className="flex flex-col">
                <GroupLabel>Kind</GroupLabel>
                {KINDS.map((option) => (
                    <CheckRow
                        key={option.value}
                        label={option.label}
                        count={count("kind", (model) => model.kind === option.value)}
                        checked={filters.kind.includes(option.value)}
                        onChange={(on) =>
                            onFilters({
                                ...filters,
                                kind: toggled(
                                    filters.kind,
                                    option.value,
                                    on,
                                    KINDS.map((item) => item.value),
                                ),
                            })
                        }
                    />
                ))}
            </fieldset>
            <div className="flex flex-col px-2.5 pb-1.5">
                <Label
                    htmlFor={`${id}-base`}
                    className="pt-2 pb-1 text-sm font-normal text-muted-foreground"
                >
                    Base model
                </Label>
                <BasePicker
                    id={`${id}-base`}
                    options={options}
                    counts={baseCounts}
                    value={filters.base}
                    onChange={(base) => onFilters({ ...filters, base })}
                />
            </div>
        </section>
    );
}

function SortSection({ sort, onSort }: { sort: SortKey; onSort: (value: SortKey) => void }) {
    const id = useId();
    return (
        <section aria-labelledby={`${id}-sort`} className="p-1.5">
            <PanelHeading id={`${id}-sort`}>Sort</PanelHeading>
            <RadioGroup
                aria-labelledby={`${id}-sort`}
                value={sort}
                onValueChange={(value) => onSort(value as SortKey)}
                className="gap-0"
            >
                {SORTS.map((option) => (
                    <Label key={option.value} className={ROW}>
                        <RadioGroupItem value={option.value} />
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        {option.detail && (
                            <span className="text-sm text-muted-foreground">{option.detail}</span>
                        )}
                    </Label>
                ))}
            </RadioGroup>
        </section>
    );
}

function DisplaySection({
    nested,
    onNested,
    columns,
    onColumns,
}: {
    nested: boolean;
    onNested: (value: boolean) => void;
    columns: Column[];
    onColumns: (value: Column[]) => void;
}) {
    const id = useId();
    return (
        <section aria-labelledby={`${id}-display`} className="p-1.5" data-arrow-scope="">
            <PanelHeading id={`${id}-display`}>Display</PanelHeading>
            <Label className={ROW}>
                <span className="min-w-0 flex-1 truncate">Show versions</span>
                <Switch checked={nested} onCheckedChange={(next) => onNested(next === true)} />
            </Label>
            <fieldset className="flex flex-col">
                <GroupLabel>Columns</GroupLabel>
                {COLUMNS.map((column) => (
                    <CheckRow
                        key={column.id}
                        label={column.label}
                        checked={columns.includes(column.id)}
                        onChange={(on) =>
                            onColumns(
                                toggled(
                                    columns,
                                    column.id,
                                    on,
                                    COLUMNS.map((item) => item.id),
                                ),
                            )
                        }
                    />
                ))}
            </fieldset>
        </section>
    );
}

export function ViewOptions({
    pool,
    models,
    filters,
    onFilters,
    sort,
    onSort,
    nested,
    onNested,
    columns,
    onColumns,
}: {
    pool: FlowModel[];
    models: FlowModel[];
    filters: Filters;
    onFilters: (value: Filters) => void;
    sort: SortKey;
    onSort: (value: SortKey) => void;
    nested: boolean;
    onNested: (value: boolean) => void;
    columns: Column[];
    onColumns: (value: Column[]) => void;
}) {
    const [open, setOpen] = useState(false);
    const active = activeCount(filters);
    const matching = pool.filter((model) => passes(model, filters)).length;
    const pristine = active === 0 && sort === DEFAULT_SORT;
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <Tooltip open={open ? false : undefined}>
                <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                        <Button
                            variant="outline"
                            size="icon"
                            aria-label={
                                active > 0
                                    ? `View options, ${plural(active, "filter")} on`
                                    : "View options"
                            }
                            data-active={active > 0 || undefined}
                            className="relative data-active:border-primary"
                        >
                            <Settings2 aria-hidden="true" />
                            {active > 0 && (
                                <span
                                    aria-hidden="true"
                                    className="absolute -top-2 -right-2 flex h-4.5 min-w-4.5 items-center justify-center rounded-sm bg-primary px-1 text-sm leading-none text-primary-foreground tabular-nums"
                                >
                                    {active}
                                </span>
                            )}
                        </Button>
                    </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>Filter, sort and display</TooltipContent>
            </Tooltip>
            <PopoverContent
                align="end"
                aria-label="View options"
                className="w-136 max-w-[calc(100vw-2rem)] p-0"
            >
                <div
                    className="grid max-h-[min(36rem,75vh)] grid-cols-2 divide-x overflow-y-auto"
                    onKeyDown={moveFocus}
                >
                    <FilterSection
                        pool={pool}
                        options={baseOptions(models)}
                        filters={filters}
                        onFilters={onFilters}
                    />
                    <div className="flex flex-col divide-y">
                        <SortSection sort={sort} onSort={onSort} />
                        <DisplaySection
                            nested={nested}
                            onNested={onNested}
                            columns={columns}
                            onColumns={onColumns}
                        />
                    </div>
                </div>
                <div className="flex items-center justify-between gap-3 border-t px-4 py-2">
                    <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
                        {matching === pool.length
                            ? `${plural(pool.length, "model")}`
                            : `${matching} of ${plural(pool.length, "model")} match`}
                    </span>
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={pristine}
                        onClick={() => {
                            onFilters(NO_FILTERS);
                            onSort(DEFAULT_SORT);
                        }}
                    >
                        Reset
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
}

type Chip = { key: string; group: string; label: ReactNode; text: string; clear: Filters };

function chipsOf(filters: Filters, options: BaseOption[]): Chip[] {
    const status = STATUSES.filter((option) => filters.status.includes(option.value)).map(
        (option) => ({
            key: `status:${option.value}`,
            group: "Status",
            label: option.label,
            text: option.label,
            clear: { ...filters, status: filters.status.filter((item) => item !== option.value) },
        }),
    );
    const kind = KINDS.filter((option) => filters.kind.includes(option.value)).map((option) => ({
        key: `kind:${option.value}`,
        group: "Kind",
        label: option.label,
        text: option.label,
        clear: { ...filters, kind: filters.kind.filter((item) => item !== option.value) },
    }));
    const base = options.find((option) => option.slug === filters.base);
    const baseChip: Chip[] = base
        ? [
              {
                  key: "base",
                  group: "Base",
                  label: (
                      <span className="flex items-center gap-1.5">
                          <BaseLabel option={base} />
                      </span>
                  ),
                  text: base.name,
                  clear: { ...filters, base: null },
              },
          ]
        : [];
    return [...status, ...kind, ...baseChip];
}

export function FilterChips({
    models,
    filters,
    onFilters,
}: {
    models: FlowModel[];
    filters: Filters;
    onFilters: (value: Filters) => void;
}) {
    const chips = chipsOf(filters, baseOptions(models));
    if (chips.length === 0) {
        return null;
    }
    return (
        <ul aria-label="Active filters" className="flex flex-wrap items-center gap-1.5">
            {chips.map((chip) => (
                <li
                    key={chip.key}
                    className="flex h-7 items-center gap-1.5 rounded-md border bg-card pr-0.5 pl-2 text-sm"
                >
                    <span className="text-muted-foreground">{chip.group}</span>
                    {chip.label}
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label={`Remove filter ${chip.group}: ${chip.text}`}
                                onClick={() => onFilters(chip.clear)}
                            >
                                <X aria-hidden="true" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Remove</TooltipContent>
                    </Tooltip>
                </li>
            ))}
            <li>
                <Button variant="ghost" size="sm" onClick={() => onFilters(NO_FILTERS)}>
                    Clear all
                </Button>
            </li>
        </ul>
    );
}
