import { useQueries } from "@tanstack/react-query";
import { Boxes, ChevronDown } from "lucide-react";
import {
    Badge,
    Checkbox,
    CheckboxSelect,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    InfoTip,
    Label,
    TabbedSearchList,
    type TabbedSearchListGroup,
    type TabbedSearchListTab,
} from "obp-ui";
import { useState } from "react";
import { type CatalogEntry, type CatalogResponse, type ModelRow, api, unwrap } from "~/api/client";
import { keys } from "~/api/queries";
import { PublisherLogo } from "~/components/PublisherLogo";
import { bytes } from "~/lib/time";
import { ImportPanel, type ImportPick, looksLikeSource } from "./BaseSource";
import { TIERS } from "./DiscoverFilters";
import {
    type BaseOption,
    type FitLevel,
    type Recommendations,
    catalogueOption,
    customOptions,
    gigabytes,
    localBases,
    searchText,
} from "./baseOptions";

export type PickerTab = "catalogue" | "mine" | "import";

const LICENCE_TEXT: Record<string, string> = {
    commercial: "Commercial use",
    restricted: "Commercial use with conditions",
    "non-commercial": "No commercial use",
    unknown: "Licence not reviewed",
};

const USE_FILTERS = [
    { value: "commercial", label: "Commercial use" },
    { value: "restricted", label: "With conditions" },
    { value: "non-commercial", label: "No commercial use" },
    { value: "unknown", label: "Not reviewed" },
];

type Row = { group: string; option: BaseOption; recommended?: boolean };

type InstallState = { text: string; variant: "success" | "info" | "warning" | "neutral" };

const INSTALL_STATES: Record<string, InstallState> = {
    available: { text: "On this install", variant: "success" },
    downloading: { text: "Downloading", variant: "info" },
    importing: { text: "Importing", variant: "info" },
    missing: { text: "Files missing", variant: "warning" },
};

const DOWNLOAD: InstallState = { text: "Download", variant: "neutral" };

function installState(option: BaseOption): InstallState | null {
    return INSTALL_STATES[option.added?.availability.state ?? ""] ?? null;
}

function Availability({ option }: { option: BaseOption }) {
    const state = installState(option);
    if (state) {
        return <Badge variant={state.variant}>{state.text}</Badge>;
    }
    return option.size ? (
        <span className="tabular-nums">{`${gigabytes(option.size)} GB`}</span>
    ) : null;
}

function memoryText(option: BaseOption): string | null {
    const needed = option.variant?.fit.needed_bytes;
    return needed ? `Needs ${gigabytes(needed)} GB memory` : null;
}

function OptionRow({ option, recommended }: { option: BaseOption; recommended?: boolean }) {
    const memory = option.kind === "local" ? null : memoryText(option);
    const facts = [
        option.kind === "custom" ? null : option.publisher,
        option.params ? `${option.params} parameters` : null,
        option.licence ? LICENCE_TEXT[option.licence] : null,
    ].filter(Boolean);
    const description = descriptionOf(option);
    return (
        <span className="flex w-full min-w-0 items-start gap-3 py-1.5">
            <PublisherLogo publisher={option.publisher} name={option.name} />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-base font-semibold">{option.name}</span>
                    {recommended && <Badge variant="info">Recommended</Badge>}
                </span>
                {facts.length > 0 && (
                    <span className="truncate text-muted-foreground">{facts.join(" · ")}</span>
                )}
                {description && (
                    <span className="line-clamp-1 text-muted-foreground">{description}</span>
                )}
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
                <Availability option={option} />
                {memory && <span className="text-muted-foreground tabular-nums">{memory}</span>}
            </span>
        </span>
    );
}

function descriptionOf(option: BaseOption): string | null {
    return option.entry?.description || option.custom?.description || option.note || null;
}

const FIT_RANK: Record<FitLevel, number> = { fits: 0, limited: 1, unknown: 2, insufficient: 3 };

function rows(group: string, options: BaseOption[]): Row[] {
    return options.map((option) => ({ group, option }));
}

function groupOf(
    key: string,
    label: string | undefined,
    options: BaseOption[],
): TabbedSearchListGroup<Row> {
    return { key, label, items: rows(key, options) };
}

const RUNNABLE: FitLevel[] = ["fits", "limited"];

function runsIn(entry: CatalogEntry | undefined): boolean {
    return Boolean(entry?.variants.some((variant) => RUNNABLE.includes(variant.fit.level)));
}

type PickerValue = { option: BaseOption | null; importText: string | null };

function Trigger({ value }: { value: PickerValue }) {
    const { option, importText } = value;
    const state = option ? (installState(option) ?? DOWNLOAD) : null;
    const facts = option
        ? [
              option.kind === "custom" ? null : option.publisher,
              option.params ? `${option.params} parameters` : null,
              option.size ? bytes(option.size) : null,
              option.kind === "local" ? null : memoryText(option),
              option.licence ? LICENCE_TEXT[option.licence] : null,
          ].filter(Boolean)
        : [];
    const description = option ? descriptionOf(option) : null;
    return (
        <DialogTrigger asChild>
            <button
                type="button"
                id="base-model"
                className="flex w-full min-w-0 items-center gap-4 rounded-lg border border-input bg-input-background p-4 text-left text-sm outline-none hover:bg-secondary focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
            >
                {option ? (
                    <PublisherLogo publisher={option.publisher} name={option.name} size="lg" />
                ) : (
                    <span className="flex size-12 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground">
                        <Boxes aria-hidden="true" className="size-4" />
                    </span>
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {option ? (
                        <>
                            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="min-w-0 break-words text-base font-semibold">
                                    {option.name}
                                </span>
                                {state && (
                                    <Badge variant={state.variant} className="shrink-0">
                                        {state.text}
                                    </Badge>
                                )}
                            </span>
                            <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground tabular-nums">
                                <span className="truncate">{facts.join(" · ")}</span>
                            </span>
                            {description && (
                                <span className="line-clamp-2 text-foreground">{description}</span>
                            )}
                        </>
                    ) : importText ? (
                        <>
                            <span className="flex min-w-0 items-center gap-2">
                                <span className="truncate font-mono">{importText}</span>
                                <Badge variant="neutral" className="shrink-0">
                                    Import
                                </Badge>
                            </span>
                            <span className="text-muted-foreground">
                                Copied into this install when you add the model.
                            </span>
                        </>
                    ) : (
                        <>
                            <span className="text-base font-semibold">Choose a base model</span>
                            <span className="text-muted-foreground">
                                Recommended, from the catalogue, one of yours, or an import.
                            </span>
                        </>
                    )}
                </span>
                <span className="flex shrink-0 items-center gap-1 self-center text-primary">
                    <span className="hidden sm:inline">
                        {option || importText ? "Change" : "Choose"}
                    </span>
                    <ChevronDown aria-hidden="true" className="size-4" />
                </span>
            </button>
        </DialogTrigger>
    );
}

export function BasePicker({
    value,
    catalog,
    models,
    picks,
    open,
    onOpenChange,
    tab,
    onTabChange,
    onPick,
    onImport,
}: {
    value: PickerValue;
    catalog: CatalogResponse | undefined;
    models: ModelRow[];
    picks: Recommendations;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    tab: PickerTab;
    onTabChange: (tab: PickerTab) => void;
    onPick: (option: BaseOption) => void;
    onImport: (pick: ImportPick) => void;
}) {
    const [tiers, setTiers] = useState<string[]>([]);
    const [uses, setUses] = useState<string[]>([]);
    const [runsHere, setRunsHere] = useState(false);
    const entries = catalog?.entries ?? [];
    const otherPools = (catalog?.pools ?? []).filter((pool) => pool.name !== catalog?.pool);
    const pools = useQueries({
        queries: otherPools.map((pool) => ({
            queryKey: [...keys.catalog, pool.name],
            queryFn: () =>
                unwrap(api.GET("/api/catalog", { params: { query: { pool: pool.name } } })),
        })),
    });
    const elsewhere = pools.flatMap((query) => (query.data ? [query.data.entries] : []));
    const runsSomewhere = (option: BaseOption) =>
        runsIn(option.entry ?? undefined) ||
        elsewhere.some((list) => runsIn(list.find((entry) => entry.id === option.entry?.id)));
    const everything = entries.map((entry) => catalogueOption(entry));
    const catalogue = everything.filter(
        (option) =>
            (tiers.length === 0 || tiers.includes(option.entry?.tier ?? "")) &&
            (!runsHere || runsSomewhere(option)) &&
            (uses.length === 0 || uses.includes(option.licence ?? "unknown")),
    );
    const count = (match: (option: BaseOption) => boolean) => everything.filter(match).length;
    const custom = customOptions(entries, models);
    const imported = localBases(entries, models);
    const suggested = [...picks.here, ...picks.unchecked].slice(0, 3).map((pick) => pick.key);
    const ordered = [...catalogue].sort((left, right) => {
        const a = suggested.indexOf(left.key);
        const b = suggested.indexOf(right.key);
        if (a !== b) {
            return (a === -1 ? suggested.length : a) - (b === -1 ? suggested.length : b);
        }
        return (
            FIT_RANK[left.fit] - FIT_RANK[right.fit] ||
            (right.entry?.popularity ?? 0) - (left.entry?.popularity ?? 0)
        );
    });
    const tabs: TabbedSearchListTab<Row>[] = [
        {
            value: "catalogue",
            label: "Catalogue",
            toolbar: (
                <div className="flex flex-wrap items-center gap-2">
                    <CheckboxSelect
                        label="Size"
                        allLabel="Any size"
                        noun="sizes"
                        options={TIERS.map((tier) => ({
                            ...tier,
                            count: count((option) => option.entry?.tier === tier.value),
                        }))}
                        value={tiers}
                        onValueChange={setTiers}
                        className="w-40"
                    />
                    <CheckboxSelect
                        label="Licence use"
                        allLabel="Any licence"
                        noun="licence uses"
                        options={USE_FILTERS.map((item) => ({
                            ...item,
                            count: count((option) => option.licence === item.value),
                        }))}
                        value={uses}
                        onValueChange={setUses}
                        className="w-48"
                    />
                    <span className="ml-auto flex items-center gap-1.5">
                        <Label className="flex items-center gap-2 font-normal">
                            <Checkbox
                                checked={runsHere}
                                onCheckedChange={(checked) => setRunsHere(checked === true)}
                            />
                            Runs here
                        </Label>
                        <InfoTip label="What runs here means">
                            Fits in memory on a machine in one of your compute pools, on demand ones
                            included.
                        </InfoTip>
                    </span>
                </div>
            ),
            groups: [
                {
                    key: "catalogue",
                    items: ordered.map((option) => ({
                        group: "catalogue",
                        option,
                        recommended: suggested.includes(option.key),
                    })),
                },
            ],
            empty: "No catalogue model matches these filters.",
        },
        {
            value: "mine",
            label: "My models",
            groups: [
                groupOf("custom", "Your models: adds a copy with its data and settings", custom),
                groupOf("imported", "Imported base models", imported),
            ].filter((group) => group.items.length > 0),
            empty: "No custom or imported models yet.",
        },
        {
            value: "import",
            label: "Import",
            matches: looksLikeSource,
            panel: (query) => <ImportPanel seed={query} onUse={onImport} />,
        },
    ];
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <Trigger value={value} />
            <DialogContent className="flex h-[min(46rem,calc(100%-2rem))] flex-col sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Choose a base model</DialogTitle>
                </DialogHeader>
                <TabbedSearchList
                    tabs={tabs}
                    tab={tab}
                    onTabChange={(next) => onTabChange(next as PickerTab)}
                    itemKey={(row) => row.option.key}
                    itemText={(row) => searchText(row.option)}
                    renderItem={(row) => (
                        <OptionRow option={row.option} recommended={row.recommended} />
                    )}
                    currentKey={value.option?.key}
                    onPick={(row) => onPick(row.option)}
                    label="Search base models"
                    placeholder="Search"
                    className="min-h-0 flex-1"
                    listClassName="max-h-none"
                />
            </DialogContent>
        </Dialog>
    );
}
