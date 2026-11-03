import { ChevronDown } from "lucide-react";
import {
    Badge,
    CheckboxSelect,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    TabbedSearchList,
    type TabbedSearchListGroup,
    type TabbedSearchListTab,
} from "obp-ui";
import { useState } from "react";
import type { CatalogResponse, ModelRow } from "~/api/client";
import { PublisherLogo } from "~/components/PublisherLogo";
import { StatusText, type Tone } from "~/components/models/StatusText";
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

export type PickerTab = "recommended" | "catalogue" | "mine" | "import";

const FIT_HINT: Record<FitLevel, { text: string; tone: Tone }> = {
    fits: { text: "Runs here", tone: "success" },
    limited: { text: "Tight fit", tone: "warning" },
    insufficient: { text: "Needs more compute", tone: "info" },
    unknown: { text: "Fit not checked", tone: "neutral" },
};

const LICENCE_TEXT: Record<string, string> = {
    commercial: "Commercial use",
    restricted: "Commercial use with conditions",
    "non-commercial": "No commercial use",
    unknown: "Licence not reviewed",
};

const FIT_FILTERS = [
    { value: "here", label: "Runs here" },
    { value: "more", label: "Needs more compute" },
];

const USE_FILTERS = [
    { value: "commercial", label: "Commercial use" },
    { value: "restricted", label: "With conditions" },
    { value: "non-commercial", label: "No commercial use" },
    { value: "unknown", label: "Not reviewed" },
];

type Row = { group: string; option: BaseOption };

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

function OptionRow({ option }: { option: BaseOption }) {
    const fit = FIT_HINT[option.fit];
    const facts = [
        option.kind === "custom" ? null : option.publisher,
        option.params ? `${option.params} parameters` : null,
        option.licence ? LICENCE_TEXT[option.licence] : null,
    ].filter(Boolean);
    return (
        <>
            <PublisherLogo publisher={option.publisher} name={option.name} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-semibold">{option.name}</span>
                {facts.length > 0 && (
                    <span className="truncate text-muted-foreground">{facts.join(" · ")}</span>
                )}
                {option.note && (
                    <span className="truncate text-muted-foreground">{option.note}</span>
                )}
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1">
                <Availability option={option} />
                {option.kind !== "local" && <StatusText tone={fit.tone}>{fit.text}</StatusText>}
            </span>
        </>
    );
}

function CompactRow({ option }: { option: BaseOption }) {
    const fit = FIT_HINT[option.fit];
    const facts = [
        option.publisher,
        option.params,
        option.licence ? LICENCE_TEXT[option.licence] : null,
    ]
        .filter(Boolean)
        .join(" · ");
    return (
        <>
            <PublisherLogo publisher={option.publisher} name={option.name} size="sm" />
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="truncate font-semibold">{option.name}</span>
                <span className="hidden truncate text-muted-foreground sm:inline">{facts}</span>
            </span>
            {option.kind !== "local" && (
                <StatusText tone={fit.tone} className="hidden sm:inline-flex">
                    {fit.text}
                </StatusText>
            )}
            <Availability option={option} />
        </>
    );
}

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

function fitMatches(fit: FitLevel, chosen: string[]): boolean {
    if (chosen.length === 0) {
        return true;
    }
    const value = fit === "insufficient" ? "more" : fit === "unknown" ? "unknown" : "here";
    return chosen.includes(value);
}

type PickerValue = { option: BaseOption | null; importText: string | null };

function Trigger({ value }: { value: PickerValue }) {
    const { option, importText } = value;
    const state = option ? (installState(option) ?? DOWNLOAD) : null;
    return (
        <DialogTrigger asChild>
            <button
                type="button"
                id="base-model"
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-input-background px-2.5 text-sm outline-none hover:bg-secondary focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring"
            >
                {option ? (
                    <>
                        <PublisherLogo publisher={option.publisher} name={option.name} size="sm" />
                        <span className="truncate font-medium">{option.name}</span>
                        <span className="hidden truncate text-muted-foreground tabular-nums sm:inline">
                            {[option.params, option.size ? bytes(option.size) : null]
                                .filter(Boolean)
                                .join(" · ")}
                        </span>
                        {state && (
                            <Badge variant={state.variant} className="ml-auto shrink-0">
                                {state.text}
                            </Badge>
                        )}
                    </>
                ) : importText ? (
                    <>
                        <span className="truncate font-mono">{importText}</span>
                        <Badge variant="neutral" className="ml-auto shrink-0">
                            Import
                        </Badge>
                    </>
                ) : (
                    <span className="text-muted-foreground">Choose a base model</span>
                )}
                <ChevronDown
                    aria-hidden="true"
                    className={`size-4 shrink-0 text-muted-foreground ${option || importText ? "" : "ml-auto"}`}
                />
            </button>
        </DialogTrigger>
    );
}

export function BasePicker({
    value,
    catalog,
    models,
    picks,
    taskNoun,
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
    taskNoun: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    tab: PickerTab;
    onTabChange: (tab: PickerTab) => void;
    onPick: (option: BaseOption) => void;
    onImport: (pick: ImportPick) => void;
}) {
    const [tiers, setTiers] = useState<string[]>([]);
    const [fits, setFits] = useState<string[]>([]);
    const [uses, setUses] = useState<string[]>([]);
    const entries = catalog?.entries ?? [];
    const everything = entries.map((entry) => catalogueOption(entry));
    const catalogue = everything.filter(
        (option) =>
            (tiers.length === 0 || tiers.includes(option.entry?.tier ?? "")) &&
            fitMatches(option.fit, fits) &&
            (uses.length === 0 || uses.includes(option.licence ?? "unknown")),
    );
    const count = (match: (option: BaseOption) => boolean) => everything.filter(match).length;
    const custom = customOptions(entries, models);
    const imported = localBases(entries, models);
    const recommended: TabbedSearchListGroup<Row>[] = [
        groupOf("recent", "Recently used", picks.recent),
        groupOf("here", "Runs on this machine", picks.here),
        groupOf("more", "Needs more compute: train or serve it on a GPU pool", picks.more),
        groupOf("unchecked", "Suggested; fit not checked yet", picks.unchecked),
    ].filter((group) => group.items.length > 0);
    const tabs: TabbedSearchListTab<Row>[] = [
        {
            value: "recommended",
            label: "Recommended",
            groups: recommended,
            empty: "No catalogue model suits this task yet.",
        },
        {
            value: "catalogue",
            label: "Catalogue",
            toolbar: (
                <div className="flex flex-wrap gap-2">
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
                        label="Fit"
                        allLabel="Any fit"
                        noun="fits"
                        options={FIT_FILTERS.map((item) => ({
                            ...item,
                            count: count((option) => fitMatches(option.fit, [item.value])),
                        }))}
                        value={fits}
                        onValueChange={setFits}
                        className="w-48"
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
                </div>
            ),
            groups: [groupOf("catalogue", undefined, catalogue)],
            empty: "No catalogue model matches these filters.",
        },
        {
            value: "mine",
            label: "My models",
            groups: [
                groupOf(
                    "custom",
                    "Start from a custom model: copies its base, training data and settings",
                    custom,
                ),
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
    const hardware = catalog?.hardware;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <Trigger value={value} />
            <DialogContent className="flex h-[min(46rem,calc(100%-2rem))] flex-col sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Choose a base model</DialogTitle>
                    <DialogDescription>
                        {hardware?.known
                            ? `Suggestions for ${taskNoun}. Fit is judged against ${hardware.machine}: ${bytes(hardware.memory_bytes)} ${hardware.memory_label}.`
                            : `Suggestions for ${taskNoun}. This machine has not reported its memory, so fit is not checked.`}
                    </DialogDescription>
                </DialogHeader>
                <TabbedSearchList
                    tabs={tabs}
                    tab={tab}
                    onTabChange={(next) => onTabChange(next as PickerTab)}
                    itemKey={(row) => row.option.key}
                    itemText={(row) => searchText(row.option)}
                    renderItem={(row) =>
                        row.group === "recent" ? (
                            <CompactRow option={row.option} />
                        ) : (
                            <OptionRow option={row.option} />
                        )
                    }
                    currentKey={value.option?.key}
                    onPick={(row) => onPick(row.option)}
                    label="Search base models"
                    placeholder="Search every tab"
                    className="min-h-0 flex-1"
                    listClassName="max-h-none"
                />
            </DialogContent>
        </Dialog>
    );
}
