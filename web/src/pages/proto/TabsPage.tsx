import { Download, HardDrive, Library, type LucideIcon, MemoryStick, User } from "lucide-react";
import { Badge, FilterMenu, Input, SearchInput, cn } from "obp-ui";
import { type ComponentType, type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { PageHeader } from "~/components/PageHeader";
import { PublisherLogo } from "~/components/PublisherLogo";
import { Page } from "~/components/Section";
import { TIERS } from "~/pages/models/DiscoverFilters";

type TabId = "catalogue" | "mine" | "import";

type TabDef = {
    id: TabId;
    label: string;
    count: number | null;
    description: string;
    icon: LucideIcon;
};

const TABS: TabDef[] = [
    {
        id: "catalogue",
        label: "Catalogue",
        count: 56,
        description: "Tested base models to download",
        icon: Library,
    },
    {
        id: "mine",
        label: "My models",
        count: 2,
        description: "Your custom models and imported bases",
        icon: User,
    },
    {
        id: "import",
        label: "Import",
        count: null,
        description: "From Hugging Face, S3 or a server folder",
        icon: Download,
    },
];

type MockModel = {
    name: string;
    publisher: string;
    facts: string[];
    description: string;
    state?: { text: string; variant: "success" | "info" };
    recommended?: boolean;
    memory?: number;
    disk: number;
};

type MockGroup = { key: string; label?: string; models: MockModel[] };

const GROUPS: Record<Exclude<TabId, "import">, MockGroup[]> = {
    catalogue: [
        {
            key: "catalogue",
            models: [
                {
                    name: "Qwen3 0.6B",
                    publisher: "Qwen",
                    facts: ["Qwen", "0.6B parameters", "Apache 2.0"],
                    description:
                        "Small chat model; the tested default base for training minibrains on a laptop.",
                    state: { text: "On this install", variant: "success" },
                    recommended: true,
                    memory: 1.9,
                    disk: 1.5,
                },
                {
                    name: "Llama 3.2 3B Instruct",
                    publisher: "Meta",
                    facts: ["Meta", "3.2B parameters", "Llama 3.2 Community Licence"],
                    description: "Meta instruct model, 3.2B parameters.",
                    recommended: true,
                    memory: 7.4,
                    disk: 6.4,
                },
                {
                    name: "Gemma 3 1B",
                    publisher: "Google",
                    facts: ["Google", "1.0B parameters", "Gemma Terms of Use"],
                    description: "Google instruct model, 1.0B parameters.",
                    memory: 2.6,
                    disk: 2.0,
                },
            ],
        },
    ],
    mine: [
        {
            key: "custom",
            label: "Your models: adds a copy with its data and settings",
            models: [
                {
                    name: "Support triage",
                    publisher: "",
                    facts: ["0.6B parameters", "Apache 2.0"],
                    description: "Routes incoming support email to the right queue.",
                    state: { text: "On this install", variant: "success" },
                    disk: 1.6,
                },
            ],
        },
        {
            key: "imported",
            label: "Imported base models",
            models: [
                {
                    name: "Phi 3.5 Mini Instruct",
                    publisher: "Microsoft",
                    facts: ["Microsoft", "3.8B parameters", "MIT"],
                    description: "Imported from a folder on the minibrain server.",
                    state: { text: "Importing", variant: "info" },
                    disk: 7.6,
                },
            ],
        },
    ],
};

const FOCUS =
    "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

type Picker = {
    uid: string;
    tab: TabId;
    setTab: (tab: TabId) => void;
    query: string;
    setQuery: (query: string) => void;
};

function usePicker(): Picker {
    const uid = useId();
    const [tab, setTab] = useState<TabId>("catalogue");
    const [query, setQuery] = useState("");
    return { uid, tab, setTab, query, setQuery };
}

function moveFocus(event: KeyboardEvent<HTMLDivElement>, picker: Picker) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) {
        return;
    }
    event.preventDefault();
    const index = TABS.findIndex((item) => item.id === picker.tab);
    const next = TABS[(index + step + TABS.length) % TABS.length];
    if (!next) {
        return;
    }
    picker.setTab(next.id);
    event.currentTarget
        .querySelector<HTMLButtonElement>(`[data-tab="${next.id}"]`)
        ?.focus({ preventScroll: true });
}

function TabStrip({
    picker,
    vertical = false,
    className,
    tabClassName,
    children,
}: {
    picker: Picker;
    vertical?: boolean;
    className?: string;
    tabClassName: (active: boolean) => string;
    children: (item: TabDef, active: boolean) => ReactNode;
}) {
    return (
        <div
            role="tablist"
            aria-label="Where the base model comes from"
            aria-orientation={vertical ? "vertical" : "horizontal"}
            onKeyDown={(event) => moveFocus(event, picker)}
            className={className}
        >
            {TABS.map((item) => {
                const active = item.id === picker.tab;
                return (
                    <button
                        key={item.id}
                        type="button"
                        role="tab"
                        id={`${picker.uid}-${item.id}`}
                        data-tab={item.id}
                        aria-selected={active}
                        aria-controls={`${picker.uid}-panel`}
                        tabIndex={active ? 0 : -1}
                        onClick={() => picker.setTab(item.id)}
                        className={cn(FOCUS, tabClassName(active))}
                    >
                        {children(item, active)}
                    </button>
                );
            })}
        </div>
    );
}

function Count({ value, className }: { value: number | null; className?: string }) {
    if (value === null) {
        return null;
    }
    return <span className={cn("tabular-nums", className)}>{value}</span>;
}

function StableLabel({ text, bold }: { text: string; bold: boolean }) {
    return (
        <span className="grid">
            <span aria-hidden="true" className="invisible col-start-1 row-start-1 font-semibold">
                {text}
            </span>
            <span className={cn("col-start-1 row-start-1", bold && "font-semibold")}>{text}</span>
        </span>
    );
}

function Frame({ children }: { children: ReactNode }) {
    return (
        <div className="flex w-full max-w-3xl flex-col gap-6 rounded-lg border bg-card p-7 text-base">
            <h3 className="text-2xl font-normal">Choose a base model</h3>
            <div className="flex flex-col gap-3">{children}</div>
        </div>
    );
}

function Search({ picker }: { picker: Picker }) {
    return (
        <SearchInput
            value={picker.query}
            onValueChange={picker.setQuery}
            aria-label="Search base models"
            placeholder="Search"
            className="min-w-0 flex-1"
        />
    );
}

function Filters({ picker }: { picker: Picker }) {
    const [tiers, setTiers] = useState<string[]>([]);
    const [runsHere, setRunsHere] = useState(true);
    if (picker.tab !== "catalogue") {
        return null;
    }
    return (
        <FilterMenu
            sections={[
                {
                    kind: "options",
                    key: "size",
                    title: "Size",
                    options: TIERS.map((tier, index) => ({
                        ...tier,
                        count: [31, 14, 7, 4][index],
                    })),
                    value: tiers,
                    onValueChange: setTiers,
                },
                {
                    kind: "toggle",
                    key: "runs-here",
                    title: "Compute",
                    label: "Runs here",
                    count: 31,
                    checked: runsHere,
                    onCheckedChange: setRunsHere,
                },
            ]}
            summary="31 of 56 models"
            onClear={() => {
                setTiers([]);
                setRunsHere(false);
            }}
        />
    );
}

function Amount({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
    return (
        <span className="flex items-center gap-1">
            <Icon aria-hidden="true" className="size-4 shrink-0" />
            <span className="sr-only">{`${label}: `}</span>
            {`${value.toFixed(1)} GB`}
        </span>
    );
}

function ModelRow({ model, highlighted }: { model: MockModel; highlighted: boolean }) {
    return (
        <div
            className={cn(
                "flex cursor-pointer items-start gap-3 px-3 py-3.5 text-sm",
                highlighted ? "bg-secondary" : "hover:bg-secondary",
            )}
        >
            <PublisherLogo publisher={model.publisher} name={model.name} />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-base font-semibold">{model.name}</span>
                    {model.recommended && <Badge variant="info">Recommended</Badge>}
                </span>
                <span className="truncate text-muted-foreground">{model.facts.join(" · ")}</span>
                <span className="line-clamp-1 text-muted-foreground">{model.description}</span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
                {model.state && <Badge variant={model.state.variant}>{model.state.text}</Badge>}
                <span className="flex items-center gap-3 text-muted-foreground tabular-nums">
                    {model.memory !== undefined && (
                        <Amount icon={MemoryStick} label="Memory needed" value={model.memory} />
                    )}
                    <Amount icon={HardDrive} label="Disk" value={model.disk} />
                </span>
            </span>
        </div>
    );
}

function ModelList({ groups }: { groups: MockGroup[] }) {
    return (
        <div className="flex flex-col overflow-clip rounded-md border">
            {groups.map((group, groupIndex) => (
                <div key={group.key} className="border-t first:border-t-0">
                    {group.label && (
                        <div className="px-3 pt-2.5 pb-1 text-sm font-medium text-muted-foreground">
                            {group.label}
                        </div>
                    )}
                    <div className="flex flex-col divide-y divide-border-soft">
                        {group.models.map((model, index) => (
                            <ModelRow
                                key={model.name}
                                model={model}
                                highlighted={groupIndex === 0 && index === 0}
                            />
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

function ImportMock({ uid }: { uid: string }) {
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-label">
                <label htmlFor={`${uid}-source`} className="text-sm font-medium">
                    Model id, link, S3 path or folder
                </label>
                <Input id={`${uid}-source`} placeholder="Qwen/Qwen3-0.6B" className="font-mono" />
            </div>
            <div className="flex min-h-28 flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Paste where the model is</span>
                <span>minibrain reads its files and checks them before anything is copied.</span>
            </div>
        </div>
    );
}

function Panel({ picker }: { picker: Picker }) {
    return (
        <div
            role="tabpanel"
            id={`${picker.uid}-panel`}
            aria-labelledby={`${picker.uid}-${picker.tab}`}
            className="flex min-h-75 flex-col gap-3"
        >
            {picker.tab === "import" ? (
                <ImportMock uid={picker.uid} />
            ) : (
                <ModelList groups={GROUPS[picker.tab]} />
            )}
        </div>
    );
}

const UNDERLINE = "after:absolute after:inset-x-0 after:bottom-0 after:bg-primary";

function BiggerLine() {
    const picker = usePicker();
    return (
        <Frame>
            <Search picker={picker} />
            <div className="flex items-center justify-between gap-3 border-b">
                <TabStrip
                    picker={picker}
                    className="-mb-px flex gap-2"
                    tabClassName={(active) =>
                        cn(
                            "relative flex h-10 items-center gap-2 px-3 text-base font-medium",
                            active
                                ? `text-foreground after:h-0.5 ${UNDERLINE}`
                                : "text-muted-foreground hover:text-foreground",
                        )
                    }
                >
                    {(item) => (
                        <>
                            {item.label}
                            <Count
                                value={item.count}
                                className="font-normal text-muted-foreground"
                            />
                        </>
                    )}
                </TabStrip>
                <Filters picker={picker} />
            </div>
            <Panel picker={picker} />
        </Frame>
    );
}

function Segmented() {
    const picker = usePicker();
    return (
        <Frame>
            <Search picker={picker} />
            <div className="flex items-center justify-between gap-3">
                <TabStrip
                    picker={picker}
                    className="inline-flex h-9 items-stretch gap-0.5 rounded-md border bg-secondary p-0.5"
                    tabClassName={(active) =>
                        cn(
                            "flex items-center gap-2 rounded-sm border px-3 text-sm font-medium",
                            active
                                ? "border-input bg-card text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground",
                        )
                    }
                >
                    {(item) => (
                        <>
                            {item.label}
                            <Count
                                value={item.count}
                                className="font-normal text-muted-foreground"
                            />
                        </>
                    )}
                </TabStrip>
                <Filters picker={picker} />
            </div>
            <Panel picker={picker} />
        </Frame>
    );
}

function BoldUnderline() {
    const picker = usePicker();
    return (
        <Frame>
            <Search picker={picker} />
            <div className="flex items-center justify-between gap-3 border-b-2">
                <TabStrip
                    picker={picker}
                    className="-mb-0.5 flex gap-4"
                    tabClassName={(active) =>
                        cn(
                            "relative flex h-11 items-center gap-2 px-1 text-base",
                            active
                                ? `text-foreground after:h-0.75 ${UNDERLINE}`
                                : "text-muted-foreground hover:text-foreground",
                        )
                    }
                >
                    {(item, active) => (
                        <>
                            <StableLabel text={item.label} bold={active} />
                            <Count
                                value={item.count}
                                className={active ? "text-foreground" : "text-muted-foreground"}
                            />
                        </>
                    )}
                </TabStrip>
                <Filters picker={picker} />
            </div>
            <Panel picker={picker} />
        </Frame>
    );
}

function HeaderStrip() {
    const picker = usePicker();
    return (
        <Frame>
            <Search picker={picker} />
            <div className="-mx-7 flex items-stretch justify-between gap-3 border-y bg-secondary px-7">
                <TabStrip
                    picker={picker}
                    className="-mb-px flex items-end gap-1 pt-2"
                    tabClassName={(active) =>
                        cn(
                            "relative flex h-9 items-center gap-2 rounded-t-md border px-4 text-base font-medium",
                            active
                                ? "border-border border-b-transparent bg-card text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground",
                        )
                    }
                >
                    {(item) => (
                        <>
                            {item.label}
                            <Count
                                value={item.count}
                                className="font-normal text-muted-foreground"
                            />
                        </>
                    )}
                </TabStrip>
                <div className="flex items-center">
                    <Filters picker={picker} />
                </div>
            </div>
            <Panel picker={picker} />
        </Frame>
    );
}

function CountChips() {
    const picker = usePicker();
    return (
        <Frame>
            <Search picker={picker} />
            <div className="flex items-center justify-between gap-3 border-b">
                <TabStrip
                    picker={picker}
                    className="-mb-px flex gap-2"
                    tabClassName={(active) =>
                        cn(
                            "relative flex h-10 items-center gap-2 px-3 text-sm font-medium",
                            active
                                ? `text-foreground after:h-0.5 ${UNDERLINE}`
                                : "text-muted-foreground hover:text-foreground",
                        )
                    }
                >
                    {(item, active) => (
                        <>
                            {item.label}
                            <Count
                                value={item.count}
                                className={cn(
                                    "flex h-5 min-w-5 items-center justify-center rounded-sm border px-1.5 leading-none",
                                    active
                                        ? "border-primary bg-primary text-primary-foreground"
                                        : "border-border text-muted-foreground",
                                )}
                            />
                        </>
                    )}
                </TabStrip>
                <Filters picker={picker} />
            </div>
            <Panel picker={picker} />
        </Frame>
    );
}

function IconLabel() {
    const picker = usePicker();
    return (
        <Frame>
            <Search picker={picker} />
            <div className="flex items-center justify-between gap-3 border-b">
                <TabStrip
                    picker={picker}
                    className="-mb-px flex gap-2"
                    tabClassName={(active) =>
                        cn(
                            "relative flex h-10 items-center gap-2 px-3 text-base font-medium",
                            active
                                ? `text-foreground after:h-0.5 ${UNDERLINE}`
                                : "text-muted-foreground hover:text-foreground",
                        )
                    }
                >
                    {(item, active) => (
                        <>
                            <item.icon
                                aria-hidden="true"
                                className={cn("size-4", active && "text-primary")}
                            />
                            {item.label}
                            <Count
                                value={item.count}
                                className="font-normal text-muted-foreground"
                            />
                        </>
                    )}
                </TabStrip>
                <Filters picker={picker} />
            </div>
            <Panel picker={picker} />
        </Frame>
    );
}

function VerticalRail() {
    const picker = usePicker();
    return (
        <Frame>
            <div className="flex items-center gap-3">
                <Search picker={picker} />
                <Filters picker={picker} />
            </div>
            <div className="flex items-start gap-4">
                <TabStrip
                    picker={picker}
                    vertical
                    className="flex w-44 shrink-0 flex-col gap-0.5"
                    tabClassName={(active) =>
                        cn(
                            "relative flex h-9 items-center justify-between gap-2 rounded-md px-2.5 text-left text-base",
                            active
                                ? "bg-accent font-medium text-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:bg-primary"
                                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                        )
                    }
                >
                    {(item) => (
                        <>
                            {item.label}
                            <Count value={item.count} className="font-normal" />
                        </>
                    )}
                </TabStrip>
                <div className="min-w-0 flex-1">
                    <Panel picker={picker} />
                </div>
            </div>
        </Frame>
    );
}

function LargeCards() {
    const picker = usePicker();
    return (
        <Frame>
            <Search picker={picker} />
            <TabStrip
                picker={picker}
                className="grid gap-3 sm:grid-cols-3"
                tabClassName={(active) =>
                    cn(
                        "flex flex-col items-start gap-1 rounded-lg text-left",
                        active
                            ? "border-2 border-primary bg-accent p-2.75"
                            : "border p-3 hover:bg-secondary",
                    )
                }
            >
                {(item, active) => (
                    <>
                        <span className="flex w-full items-baseline justify-between gap-2">
                            <span
                                className={cn(
                                    "text-base font-semibold",
                                    active && "text-accent-foreground",
                                )}
                            >
                                {item.label}
                            </span>
                            <Count
                                value={item.count}
                                className={cn(
                                    "text-sm",
                                    active ? "text-accent-foreground" : "text-muted-foreground",
                                )}
                            />
                        </span>
                        <span className="text-sm text-muted-foreground">{item.description}</span>
                    </>
                )}
            </TabStrip>
            {picker.tab === "catalogue" && (
                <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-muted-foreground">
                        31 of 56 models, best fit first
                    </span>
                    <Filters picker={picker} />
                </div>
            )}
            <Panel picker={picker} />
        </Frame>
    );
}

function TabsFirst() {
    const picker = usePicker();
    return (
        <Frame>
            <div className="border-b">
                <TabStrip
                    picker={picker}
                    className="-mb-px flex gap-4"
                    tabClassName={(active) =>
                        cn(
                            "relative flex h-11 items-center gap-2 px-1 text-lg font-medium",
                            active
                                ? `text-foreground after:h-0.5 ${UNDERLINE}`
                                : "text-muted-foreground hover:text-foreground",
                        )
                    }
                >
                    {(item) => (
                        <>
                            {item.label}
                            <Count
                                value={item.count}
                                className="text-base font-normal text-muted-foreground"
                            />
                        </>
                    )}
                </TabStrip>
            </div>
            <div className="flex items-center gap-3 pt-1">
                <Search picker={picker} />
                <Filters picker={picker} />
            </div>
            <Panel picker={picker} />
        </Frame>
    );
}

function ButtonGroup() {
    const picker = usePicker();
    return (
        <Frame>
            <Search picker={picker} />
            <div className="flex items-center justify-between gap-3">
                <TabStrip
                    picker={picker}
                    className="inline-flex"
                    tabClassName={(active) =>
                        cn(
                            "-ml-px flex h-8 items-center gap-1.5 border px-3 text-sm font-medium first:ml-0 first:rounded-l-md last:rounded-r-md",
                            active
                                ? "relative border-primary bg-primary text-primary-foreground"
                                : "border-input bg-card text-foreground hover:bg-secondary",
                        )
                    }
                >
                    {(item, active) => (
                        <>
                            {item.label}
                            <Count
                                value={item.count}
                                className={cn(
                                    "font-normal",
                                    active ? "text-primary-foreground" : "text-muted-foreground",
                                )}
                            />
                        </>
                    )}
                </TabStrip>
                <Filters picker={picker} />
            </div>
            <Panel picker={picker} />
        </Frame>
    );
}

type Design = { name: string; idea: string; Mock: ComponentType };

const DESIGNS: Design[] = [
    {
        name: "Bigger line tabs",
        idea: "Today's underline tabs at 14px medium in a 40px row, with each count as a muted number.",
        Mock: BiggerLine,
    },
    {
        name: "Segmented control",
        idea: "A tinted track with the chosen source raised on the card colour inside a 1px input edge; no divider.",
        Mock: Segmented,
    },
    {
        name: "Bold underline",
        idea: "A 3px primary underline over a 2px divider, the chosen label in semibold foreground.",
        Mock: BoldUnderline,
    },
    {
        name: "Header strip",
        idea: "Tabs sit on a tinted band across the whole dialog; the chosen one is a folder tab open to the list below.",
        Mock: HeaderStrip,
    },
    {
        name: "Count chips",
        idea: "Today's 13px underline tabs with each count in a bordered chip; the chosen tab's chip fills with primary.",
        Mock: CountChips,
    },
    {
        name: "Icon and label",
        idea: "Each tab leads with a functional icon that turns primary when chosen; needs an icon exception in CLAUDE.md.",
        Mock: IconLabel,
    },
    {
        name: "Vertical rail",
        idea: "Sources become a left rail with counts on the right, selected on accent with a 2px primary edge; the list fills the rest.",
        Mock: VerticalRail,
    },
    {
        name: "Source cards",
        idea: "Three cards with a title, count and one-line description; the chosen card takes a 2px primary edge on accent.",
        Mock: LargeCards,
    },
    {
        name: "Tabs above search",
        idea: "A 16px tab row directly under the title switches sections; search and filters belong to the chosen tab.",
        Mock: TabsFirst,
    },
    {
        name: "Button group",
        idea: "Three joined outline buttons, the chosen one solid primary; compact at 32px like every other control.",
        Mock: ButtonGroup,
    },
];

export function TabsPage() {
    return (
        <Page>
            <PageHeader
                title="Picker tabs"
                caption="Ten tab rows for Choose a base model. Click the tabs in each to switch. Prototype; not in the sidebar."
            />
            {DESIGNS.map(({ name, idea, Mock }, index) => (
                <section key={name} className="flex flex-col gap-3 pb-6">
                    <div className="flex flex-col gap-0.5">
                        <h2 className="text-lg font-semibold">{`${index + 1}. ${name}`}</h2>
                        <p className="text-sm text-muted-foreground">{idea}</p>
                    </div>
                    <Mock />
                </section>
            ))}
        </Page>
    );
}
