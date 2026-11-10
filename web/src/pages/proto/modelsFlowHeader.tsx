import { useRouter, useRouterState } from "@tanstack/react-router";
import { CircleHelp } from "lucide-react";
import {
    Button,
    CubePlus,
    Kbd,
    Link,
    SegmentedTabs,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import { type ReactNode, useEffect, useId, useSyncExternalStore } from "react";
import { Sparkline } from "./flowSparkline";
import { FLOW, type FlowModel } from "./modelsFlowData";
import {
    DEFAULT_SORT,
    type Filters,
    STATUSES,
    type SortKey,
    type StatusKey,
    statusCount,
} from "./modelsFlowView";

export type HeaderStyle = "a" | "b" | "c";

const HEADER_KEY = "minibrain.proto.flow.header";
const HEADER_STYLES: HeaderStyle[] = ["a", "b", "c"];
const DEFAULT_HEADER: HeaderStyle = "b";
const MODELS_PATH = `${FLOW}/models`;
const listeners = new Set<() => void>();

export const STRIP_STATUSES: StatusKey[] = ["deployed", "training", "attention", "failed"];
export const TILE_STATUSES: StatusKey[] = ["deployed", "attention", "training"];

function asStyle(value: string | null | undefined): HeaderStyle | null {
    return HEADER_STYLES.find((style) => style === value?.toLowerCase()) ?? null;
}

function readHeader(): HeaderStyle {
    try {
        return asStyle(window.localStorage.getItem(HEADER_KEY)) ?? DEFAULT_HEADER;
    } catch {
        return DEFAULT_HEADER;
    }
}

function store(style: HeaderStyle) {
    try {
        window.localStorage.setItem(HEADER_KEY, style);
    } catch {
        return;
    }
}

function writeHeader(style: HeaderStyle) {
    store(style);
    for (const listener of listeners) {
        listener();
    }
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useHeaderStyle(): HeaderStyle {
    const param = useRouterState({
        select: (state) => asStyle(new URLSearchParams(state.location.searchStr).get("header")),
    });
    const stored = useSyncExternalStore(subscribe, readHeader, () => DEFAULT_HEADER);
    useEffect(() => {
        if (param && param !== stored) {
            writeHeader(param);
        }
    }, [param, stored]);
    return param ?? stored;
}

export function HeaderSwitch() {
    const router = useRouter();
    const style = useHeaderStyle();
    return (
        <fieldset className="flex items-center gap-2">
            <legend className="sr-only">Models page header</legend>
            <span aria-hidden="true" className="text-sm text-muted-foreground">
                Header
            </span>
            <SegmentedTabs
                tabs={HEADER_STYLES.map((key) => ({ key, label: key.toUpperCase() }))}
                active={style}
                onSelect={(key) => {
                    const next = asStyle(key) ?? DEFAULT_HEADER;
                    writeHeader(next);
                    router.history.replace(`${MODELS_PATH}?header=${next}`);
                }}
            />
        </fieldset>
    );
}

function Title() {
    return <h1 className="shrink-0 text-3xl font-normal">Models</h1>;
}

function AddModel() {
    return (
        <Button asChild>
            <Link href={`${FLOW}/models/new`}>
                <CubePlus />
                Add model
            </Link>
        </Button>
    );
}

const KEY_INK = "border-current/30 bg-transparent text-current";

export function ShortcutsHelp({ nested }: { nested: boolean }) {
    const id = useId();
    const shortcuts = [
        { keys: ["↑", "↓"], text: "Move" },
        ...(nested ? [{ keys: ["→", "←"], text: "Expand, collapse" }] : []),
        { keys: ["Enter"], text: "Open" },
        {
            keys: ["Space"],
            text: nested ? "Quick look on a model, select a version or variant" : "Quick look",
        },
    ];
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Keyboard shortcuts"
                    aria-describedby={id}
                >
                    <CircleHelp aria-hidden="true" />
                </Button>
            </TooltipTrigger>
            <span id={id} className="sr-only">
                {shortcuts.map((item) => `${item.keys.join(" ")}: ${item.text}.`).join(" ")}
            </span>
            <TooltipContent className="max-w-xs text-left">
                <p className="pb-1 font-medium">Keyboard shortcuts</p>
                <ul className="flex flex-col gap-1 pb-0.5">
                    {shortcuts.map((item) => (
                        <li key={item.text} className="flex items-start gap-2">
                            <span className="flex w-14 shrink-0 gap-0.5">
                                {item.keys.map((key) => (
                                    <Kbd key={key} className={KEY_INK}>
                                        {key}
                                    </Kbd>
                                ))}
                            </span>
                            <span>{item.text}</span>
                        </li>
                    ))}
                </ul>
            </TooltipContent>
        </Tooltip>
    );
}

function labelOf(status: StatusKey): string {
    return STATUSES.find((option) => option.value === status)?.label ?? status;
}

function StatusStrip({
    scope,
    filters,
    onFilters,
}: {
    scope: FlowModel[];
    filters: Filters;
    onFilters: (value: Filters) => void;
}) {
    const items = [
        { key: "all", label: "All", count: scope.length, active: filters.status.length === 0 },
        ...STRIP_STATUSES.map((status) => ({
            key: status,
            label: labelOf(status),
            count: statusCount(scope, status),
            active: filters.status.includes(status),
        })),
    ];
    return (
        <fieldset className="flex flex-wrap gap-1 border-b">
            <legend className="sr-only">Show by status</legend>
            {items.map((item) => (
                <button
                    key={item.key}
                    type="button"
                    aria-pressed={item.active}
                    onClick={() =>
                        onFilters({
                            ...filters,
                            status: item.key === "all" ? [] : [item.key as StatusKey],
                        })
                    }
                    className={cn(
                        "-mb-px inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-sm border-b-2 px-3 text-base font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                        item.active
                            ? "border-primary text-foreground"
                            : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                >
                    {item.label}
                    <span className="text-sm font-normal text-muted-foreground tabular-nums">
                        {item.count}
                    </span>
                </button>
            ))}
        </fieldset>
    );
}

function compact(value: number): string {
    return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function dailyRequests(scope: FlowModel[]): number[] {
    return Array.from({ length: 7 }, (_, day) =>
        scope.reduce((sum, model) => sum + (model.traffic[day] ?? 0), 0),
    );
}

function dayLabel(day: number): string {
    const back = 6 - day;
    if (back === 0) {
        return "Today";
    }
    return back === 1 ? "Yesterday" : `${back} days ago`;
}

function Tile({
    label,
    value,
    active,
    onClick,
    children,
}: {
    label: string;
    value: string;
    active: boolean;
    onClick: () => void;
    children?: ReactNode;
}) {
    return (
        <button
            type="button"
            aria-pressed={active}
            onClick={onClick}
            className={cn(
                "flex min-w-0 flex-col gap-1 rounded-lg border bg-card px-4 py-3 text-left outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                active && "border-primary bg-accent hover:bg-accent",
            )}
        >
            <span className="truncate text-muted-foreground">{label}</span>
            <span className="flex h-6 items-center justify-between gap-3">
                <span className="text-2xl leading-none tabular-nums">{value}</span>
                {children}
            </span>
        </button>
    );
}

function SummaryTiles({
    scope,
    filters,
    onFilters,
    sort,
    onSort,
}: {
    scope: FlowModel[];
    filters: Filters;
    onFilters: (value: Filters) => void;
    sort: SortKey;
    onSort: (value: SortKey) => void;
}) {
    const daily = dailyRequests(scope);
    const total = daily.reduce((sum, value) => sum + value, 0);
    const statusTile = (status: StatusKey) => (
        <Tile
            key={status}
            label={labelOf(status)}
            value={String(statusCount(scope, status))}
            active={filters.status.includes(status)}
            onClick={() =>
                onFilters({
                    ...filters,
                    status: filters.status.includes(status)
                        ? filters.status.filter((item) => item !== status)
                        : [status],
                })
            }
        />
    );
    return (
        <div className="grid grid-cols-4 gap-3">
            {statusTile("deployed")}
            <Tile
                label="Requests 7d"
                value={compact(total)}
                active={sort === "requests"}
                onClick={() => onSort(sort === "requests" ? DEFAULT_SORT : "requests")}
            >
                <Sparkline
                    points={daily.map((value, day) => ({
                        key: String(day),
                        label: dayLabel(day),
                        value,
                    }))}
                    width={72}
                    height={24}
                    label="Requests over the last 7 days"
                    format={(value) => value.toLocaleString()}
                />
            </Tile>
            {statusTile("attention")}
            {statusTile("training")}
        </div>
    );
}

export function ModelsHeader({
    style,
    toolbar,
    selecting,
    canAdd,
    scope,
    filters,
    onFilters,
    sort,
    onSort,
}: {
    style: HeaderStyle;
    toolbar: ReactNode;
    selecting: boolean;
    canAdd: boolean;
    scope: FlowModel[];
    filters: Filters;
    onFilters: (value: Filters) => void;
    sort: SortKey;
    onSort: (value: SortKey) => void;
}) {
    if (style === "c") {
        return (
            <div className="flex flex-col gap-3">
                <header className="flex min-h-9 items-center justify-between gap-3">
                    <Title />
                    {canAdd && <AddModel />}
                </header>
                <SummaryTiles
                    scope={scope}
                    filters={filters}
                    onFilters={onFilters}
                    sort={sort}
                    onSort={onSort}
                />
                {toolbar}
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-3">
            <header className="flex min-h-9 items-center gap-4">
                <Title />
                <div className="min-w-0 flex-1">{toolbar}</div>
                {canAdd && !selecting && <AddModel />}
            </header>
            {style === "b" && <StatusStrip scope={scope} filters={filters} onFilters={onFilters} />}
        </div>
    );
}

export function hiddenChips(style: HeaderStyle): StatusKey[] {
    return { a: [], b: STRIP_STATUSES, c: TILE_STATUSES }[style];
}
