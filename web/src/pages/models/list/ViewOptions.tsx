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
    type BaseOption,
    COLUMNS,
    type Column,
    type Filters,
    KINDS,
    NO_FILTERS,
    SORTS,
    STATUSES,
    type SortKey,
    activeCount,
    baseOptions,
    passes,
    toggled,
} from "./filters";
import { type ListModel, plural } from "./model";

const ANY_BASE = "any";
const ROW = "flex h-8 items-center gap-2.5 rounded-sm px-2.5 font-normal hover:bg-secondary";

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
            {count !== undefined && (
                <span className="text-sm text-muted-foreground tabular-nums">{count}</span>
            )}
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
    const chosen = options.find((option) => option.group === value);
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
                    <SelectItem key={option.group} value={option.group} label={option.name}>
                        <BaseLabel option={option} />
                        <span className="ml-auto pl-3 text-sm text-muted-foreground tabular-nums">
                            {counts.get(option.group) ?? 0}
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
    pool: ListModel[];
    options: BaseOption[];
    filters: Filters;
    onFilters: (value: Filters) => void;
}) {
    const id = useId();
    const count = (skip: keyof Filters, test: (model: ListModel) => boolean) =>
        pool.filter((model) => passes(model, filters, skip) && test(model)).length;
    const baseCounts = new Map(
        options.map((option) => [
            option.group,
            count("base", (model) => model.baseGroup === option.group),
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
    onReset,
    pristine,
    nested,
    onNested,
    columns,
    onColumns,
}: {
    pool: ListModel[];
    models: ListModel[];
    filters: Filters;
    onFilters: (value: Filters) => void;
    sort: SortKey;
    onSort: (value: SortKey) => void;
    onReset: () => void;
    pristine: boolean;
    nested: boolean;
    onNested: (value: boolean) => void;
    columns: Column[];
    onColumns: (value: Column[]) => void;
}) {
    const [open, setOpen] = useState(false);
    const active = activeCount(filters);
    const matching = pool.filter((model) => passes(model, filters)).length;
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
                            ? plural(pool.length, "model")
                            : `${matching} of ${plural(pool.length, "model")} match`}
                    </span>
                    <Button variant="ghost" disabled={pristine} onClick={onReset}>
                        Reset to default
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
    const base = options.find((option) => option.group === filters.base);
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
    models: ListModel[];
    filters: Filters;
    onFilters: (value: Filters) => void;
}) {
    const chips = chipsOf(filters, baseOptions(models));
    if (chips.length === 0) {
        return null;
    }
    return (
        <ul aria-label="Active filters" className="contents">
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
            {chips.length > 1 && (
                <li>
                    <Button variant="ghost" onClick={() => onFilters(NO_FILTERS)}>
                        Clear all
                    </Button>
                </li>
            )}
        </ul>
    );
}
