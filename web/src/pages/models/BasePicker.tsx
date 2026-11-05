import {
    Boxes,
    ChevronDown,
    ExternalLink,
    HardDrive,
    type LucideIcon,
    MemoryStick,
} from "lucide-react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    FilterMenu,
    TabbedSearchList,
    type TabbedSearchListGroup,
    type TabbedSearchListTab,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "obp-ui";
import { useState } from "react";
import type { CatalogEntry, CatalogResponse, ModelRow } from "~/api/client";
import { PublisherLogo } from "~/components/PublisherLogo";
import { discoverListHref } from "~/lib/modelsSearch";
import { ImportPanel, type ImportPick, looksLikeSource } from "./BaseSource";
import { discoverHref } from "./Discover";
import { TIERS } from "./DiscoverFilters";
import {
    type BaseOption,
    type FitLevel,
    type Recommendations,
    catalogueOption,
    customOptions,
    gigabytes,
    localBases,
    logoPublisher,
    searchText,
    servesOnly,
    servingCopies,
} from "./baseOptions";
import { formatName, quantized } from "./formats";
import { RUNS_HERE_INFO, useRunsHere } from "./runsHere";

export type PickerTab = "catalogue" | "mine" | "import";

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
    return state ? <Badge variant={state.variant}>{state.text}</Badge> : null;
}

function ServeOnly({ option, className }: { option: BaseOption; className?: string }) {
    return servesOnly(option) ? (
        <Badge variant="warning" className={className}>
            Serve only
        </Badge>
    ) : null;
}

function Amount({
    icon: Icon,
    label,
    help,
    bytes,
}: {
    icon: LucideIcon;
    label: string;
    help: string;
    bytes: number;
}) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="flex items-center gap-1 rounded-sm">
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    <span className="sr-only">{`${label}: `}</span>
                    {`${gigabytes(bytes)} GB`}
                </span>
            </TooltipTrigger>
            <TooltipContent>{help}</TooltipContent>
        </Tooltip>
    );
}

function Resources({ option }: { option: BaseOption }) {
    const memory = option.kind === "local" ? null : option.variant?.fit.needed_bytes;
    const disk = option.size;
    if (!memory && !disk) {
        return null;
    }
    return (
        <span className="flex items-center gap-3 text-muted-foreground tabular-nums">
            {memory ? (
                <Amount
                    icon={MemoryStick}
                    label="Memory needed"
                    help="Memory needed: GPU or unified memory it takes to run"
                    bytes={memory}
                />
            ) : null}
            {disk ? (
                <Amount
                    icon={HardDrive}
                    label={installState(option) ? "On disk" : "Download"}
                    help={
                        installState(option)
                            ? "On disk: space its files take on this install"
                            : "Download: disk space it takes once added"
                    }
                    bytes={disk}
                />
            ) : null}
        </span>
    );
}

function factsOf(option: BaseOption): string[] {
    const variant = option.variant;
    return [
        option.kind === "custom" ? null : option.publisher,
        option.params ? `${option.params} parameters` : null,
        option.entry?.license_name ?? null,
        variant && (quantized(variant) || servesOnly(option)) ? formatName(variant) : null,
    ].filter((fact): fact is string => Boolean(fact));
}

function Details({ entry }: { entry: CatalogEntry }) {
    return (
        <Button
            asChild
            variant="outline"
            size="sm"
            className="invisible shrink-0 self-center in-data-highlighted:visible focus-visible:visible"
        >
            <a
                href={discoverHref(entry)}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.stopPropagation();
                    }
                }}
            >
                Details
                <ExternalLink aria-hidden="true" className="size-3.5" />
                <span className="sr-only"> (opens in a new tab)</span>
            </a>
        </Button>
    );
}

function OptionRow({ option, recommended }: { option: BaseOption; recommended?: boolean }) {
    const facts = factsOf(option);
    const description = descriptionOf(option);
    return (
        <span className="flex w-full min-w-0 items-start gap-3 py-1.5">
            <PublisherLogo publisher={logoPublisher(option)} name={option.name} />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-base font-semibold">{option.name}</span>
                    {recommended && <Badge variant="info">Recommended</Badge>}
                    <ServeOnly option={option} />
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
                <Resources option={option} />
            </span>
            {option.kind === "catalogue" && option.entry && <Details entry={option.entry} />}
        </span>
    );
}

function descriptionOf(option: BaseOption): string | null {
    return option.entry?.description || option.custom?.description || option.note || null;
}

const FIT_RANK: Record<FitLevel, number> = { fits: 0, limited: 1, unknown: 2, insufficient: 3 };

function trainableFirst(left: BaseOption, right: BaseOption): number {
    return Number(servesOnly(left)) - Number(servesOnly(right));
}

function rows(group: string, options: BaseOption[]): Row[] {
    return [...options].sort(trainableFirst).map((option) => ({ group, option }));
}

function groupOf(
    key: string,
    label: string | undefined,
    options: BaseOption[],
): TabbedSearchListGroup<Row> {
    return { key, label, items: rows(key, options) };
}

type PickerValue = { option: BaseOption | null; importText: string | null };

function Trigger({ value }: { value: PickerValue }) {
    const { option, importText } = value;
    const state = option ? (installState(option) ?? DOWNLOAD) : null;
    const facts = option ? factsOf(option) : [];
    const description = option ? descriptionOf(option) : null;
    return (
        <DialogTrigger asChild>
            <button
                type="button"
                id="base-model"
                className="flex w-full min-w-0 items-center gap-4 rounded-lg border border-input bg-input-background p-4 text-left text-sm outline-none hover:bg-secondary focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
            >
                {option ? (
                    <PublisherLogo publisher={logoPublisher(option)} name={option.name} size="lg" />
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
                                <ServeOnly option={option} className="shrink-0" />
                            </span>
                            <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                                {facts.length > 0 && (
                                    <span className="truncate">{facts.join(" · ")}</span>
                                )}
                                <Resources option={option} />
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
    const runsSomewhere = useRunsHere(catalog);
    const everything = entries.map((entry) => catalogueOption(entry));
    const shown = (option: BaseOption) =>
        (tiers.length === 0 || tiers.includes(option.entry?.tier ?? "")) &&
        (!runsHere || runsSomewhere(option.entry)) &&
        (uses.length === 0 || uses.includes(option.licence ?? "unknown"));
    const catalogue = everything.filter(shown);
    const copies = entries.flatMap(servingCopies).filter(shown);
    const count = (match: (option: BaseOption) => boolean) => everything.filter(match).length;
    const custom = customOptions(entries, models);
    const imported = localBases(entries, models);
    const suggested = [...picks.here, ...picks.unchecked].slice(0, 3).map((pick) => pick.key);
    const ordered = [...catalogue, ...copies].sort((left, right) => {
        const a = suggested.indexOf(left.key);
        const b = suggested.indexOf(right.key);
        if (a !== b) {
            return (a === -1 ? suggested.length : a) - (b === -1 ? suggested.length : b);
        }
        return (
            trainableFirst(left, right) ||
            FIT_RANK[left.fit] - FIT_RANK[right.fit] ||
            (right.entry?.popularity ?? 0) - (left.entry?.popularity ?? 0)
        );
    });
    const tabs: TabbedSearchListTab<Row>[] = [
        {
            value: "catalogue",
            label: "Catalogue",
            actions: (
                <FilterMenu
                    sections={[
                        {
                            kind: "options",
                            key: "size",
                            title: "Size",
                            options: TIERS.map((tier) => ({
                                ...tier,
                                count: count((option) => option.entry?.tier === tier.value),
                            })),
                            value: tiers,
                            onValueChange: setTiers,
                        },
                        {
                            kind: "options",
                            key: "licence",
                            title: "Licence use",
                            options: USE_FILTERS.map((item) => ({
                                ...item,
                                count: count((option) => option.licence === item.value),
                            })),
                            value: uses,
                            onValueChange: setUses,
                        },
                        {
                            kind: "toggle",
                            key: "runs-here",
                            title: "Compute",
                            label: "Runs here",
                            info: RUNS_HERE_INFO,
                            count: count((option) => runsSomewhere(option.entry)),
                            checked: runsHere,
                            onCheckedChange: setRunsHere,
                        },
                    ]}
                    summary={`${catalogue.length} of ${everything.length} models`}
                    onClear={() => {
                        setTiers([]);
                        setUses([]);
                        setRunsHere(false);
                    }}
                />
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
                <DialogHeader className="flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2 pr-9">
                    <DialogTitle className="pr-0">Choose a base model</DialogTitle>
                    <a
                        href={discoverListHref()}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-sm text-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                        Explore in Discover
                        <ExternalLink aria-hidden="true" className="size-3.5" />
                    </a>
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
