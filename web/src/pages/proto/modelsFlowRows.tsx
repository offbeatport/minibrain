import {
    ChevronRight,
    Eye,
    FileText,
    GitCompare,
    GraduationCap,
    MoreHorizontal,
    PanelRight,
    Pin,
    PinOff,
    Play,
    Plug,
    PowerOff,
    Repeat,
    Trash2,
} from "lucide-react";
import {
    Badge,
    Button,
    Checkbox,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Link,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
} from "obp-ui";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import type { ModelUsage } from "~/api/client";
import { Requests } from "~/components/models/ModelMetrics";
import { StatusText } from "~/components/models/StatusText";
import { Sparkline } from "./flowSparkline";
import {
    type BaseVariant,
    type FlowModel,
    type FlowVersion,
    cardHref,
    compareHref,
    flowHref,
    liveShare,
    liveVersion,
    modelHref,
    newestFirst,
    openIntent,
    pct,
    playgroundHref,
    retryWithQLoRA,
    shortAgo,
    statusLine,
    variantKey,
} from "./modelsFlowData";
import {
    MakeLiveButton,
    ModelAvatar,
    ScoreBadge,
    VersionName,
    VersionStatus,
    openConnect,
} from "./modelsFlowParts";

export type Column = "quality" | "requests" | "cost" | "p95";

export const COLUMNS: { id: Column; label: string; track: string }[] = [
    { id: "quality", label: "Quality", track: "minmax(10.5rem,auto)" },
    { id: "requests", label: "Requests, 7 days", track: "minmax(9rem,auto)" },
    { id: "cost", label: "Cost / 1k req.", track: "minmax(6rem,auto)" },
    { id: "p95", label: "p95", track: "minmax(4rem,auto)" },
];

export function gridTemplate(shown: Column[]): string {
    const tracks = COLUMNS.filter((column) => shown.includes(column.id)).map((c) => c.track);
    return ["minmax(14rem,1fr)", ...tracks, "minmax(10rem,14rem)", "auto"].join(" ");
}

export type Handlers = {
    open: (href: string) => void;
    undeploy: (models: FlowModel[]) => void;
    removeModels: (models: FlowModel[]) => void;
    removeVersions: (items: { model: FlowModel; version: FlowVersion }[]) => void;
    peek: (model: FlowModel) => void;
    pin: (model: FlowModel) => void;
    autopilot: (model: FlowModel) => void;
    deployVariants: (keys: string[]) => void;
    undeployVariants: (keys: string[]) => void;
    removeVariants: (keys: string[]) => void;
};

export type RowProps = {
    id: string;
    nested: boolean;
    focused: boolean;
    selected: boolean;
    selecting: boolean;
    peeked: boolean;
    columns: Column[];
    onFocus: () => void;
    onKey: (event: KeyboardEvent<HTMLLIElement>) => void;
    onSelect: (on: boolean) => void;
    open: () => void;
};

export function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function gpuSeconds(value: number): string {
    return `${value.toFixed(1)} GPU·s`;
}

export function usageOf(traffic: number[], previous: number, live: boolean): ModelUsage | null {
    const total = traffic.reduce((sum, value) => sum + value, 0);
    if (total === 0 && !live) {
        return null;
    }
    return {
        days: [],
        daily: traffic,
        total,
        previous,
        failed: 0,
        last_at: new Date().toISOString(),
        p50_ms: null,
    };
}

export function scoredVersions(model: FlowModel): FlowVersion[] {
    return [...model.versions]
        .filter((version) => version.scores !== null)
        .sort((a, b) => a.number - b.number);
}

export function headlineVersion(model: FlowModel): FlowVersion | undefined {
    return liveVersion(model) ?? newestFirst(model).find((version) => version.scores !== null);
}

export function autopilotText(model: FlowModel): string | null {
    const run = model.autopilot?.run;
    if (!run) {
        return null;
    }
    return `v${run.version} on ${model.autopilot?.canary}% canary · ${run.minutesLeft} min left`;
}

function fromControl(event: MouseEvent | KeyboardEvent): boolean {
    return (event.target as HTMLElement).closest("a,button,label,input,[role=menuitem]") !== null;
}

const ROW_STATE =
    "relative cursor-pointer outline-none hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[state=selected]:bg-accent data-[peeked=true]:bg-accent";
export const ROW_GRID = "col-span-full grid grid-cols-subgrid items-center px-4";

function rowEvents(props: RowProps, child: boolean) {
    return {
        id: props.id,
        tabIndex: props.focused ? 0 : -1,
        onFocus: props.onFocus,
        onKeyDown: props.onKey,
        "data-peeked": props.peeked ? "true" : undefined,
        "data-state": props.selected ? "selected" : undefined,
        onClick: (event: MouseEvent<HTMLLIElement>) => {
            if (fromControl(event)) {
                return;
            }
            if (child && props.selecting) {
                props.onSelect(!props.selected);
                return;
            }
            props.open();
        },
    };
}

function Cells({
    columns,
    cells,
}: {
    columns: Column[];
    cells: Partial<Record<Column, ReactNode>>;
}) {
    return (
        <>
            {COLUMNS.filter((column) => columns.includes(column.id)).map((column) => (
                <div key={column.id} className="min-w-0">
                    {cells[column.id] ?? null}
                </div>
            ))}
        </>
    );
}

function Muted({ children = "—" }: { children?: ReactNode }) {
    return <span className="text-muted-foreground">{children}</span>;
}

function Chevron({
    name,
    expandable,
    expanded,
    noun,
    onToggle,
}: {
    name: string;
    expandable: boolean;
    expanded: boolean;
    noun: string;
    onToggle: () => void;
}) {
    if (!expandable) {
        return <span aria-hidden="true" className="size-6 shrink-0" />;
    }
    return (
        <Button
            variant="ghost"
            size="icon-xs"
            tabIndex={-1}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} ${noun} of ${name}`}
            className="relative z-10 shrink-0"
            onClick={onToggle}
        >
            <ChevronRight
                className={cn(
                    "transition-transform duration-100 motion-reduce:transition-none",
                    expanded && "rotate-90",
                )}
            />
        </Button>
    );
}

export function LiveStatus({
    machines,
    text = "Deployed",
}: {
    machines: string[];
    text?: string;
}) {
    const label = (
        <StatusText tone="success">
            {text}
            {machines.length > 1 && (
                <span className="tabular-nums">{` · ${machines.length} replicas`}</span>
            )}
        </StatusText>
    );
    if (machines.length === 0) {
        return label;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="relative z-10 rounded-sm text-left">
                    {label}
                </button>
            </TooltipTrigger>
            <TooltipContent>
                <span className="flex flex-col gap-0.5">
                    <span className="font-semibold">
                        {machines.length === 1 ? "Served on" : `${machines.length} replicas on`}
                    </span>
                    {machines.map((machine) => (
                        <span key={machine} className="font-mono">
                            {machine}
                        </span>
                    ))}
                </span>
            </TooltipContent>
        </Tooltip>
    );
}

const AUTOPILOT_TIP =
    "Autopilot: once accepted feedback reaches the threshold it trains a new version, scores it, sends it a canary share of traffic, then deploys it. It rolls back if errors rise or the score drops.";

export function AutopilotBadge() {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Badge variant="accent" className="relative z-10 cursor-help" tabIndex={0}>
                    Autopilot
                </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{AUTOPILOT_TIP}</TooltipContent>
        </Tooltip>
    );
}

function ModelMenu({ model, on }: { model: FlowModel; on: Handlers }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`More actions for ${model.name}`}>
                    <MoreHorizontal />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem onSelect={() => on.open(flowHref(model.slug))}>
                    <Eye />
                    View details
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => on.peek(model)}>
                    <PanelRight />
                    Quick look
                </DropdownMenuItem>
                {model.kind === "custom" && (
                    <DropdownMenuItem
                        disabled={model.serveOnly}
                        className={model.serveOnly ? "items-start" : undefined}
                        onSelect={() => on.open(modelHref(model.slug, "training"))}
                    >
                        <GraduationCap className={model.serveOnly ? "mt-0.5" : undefined} />
                        <span className="flex flex-col">
                            <span>Train</span>
                            {model.serveOnly && (
                                <span className="max-w-60 text-sm whitespace-normal text-muted-foreground">
                                    {`${model.base} is serve-only: GGUF weights cannot be trained.`}
                                </span>
                            )}
                        </span>
                    </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => on.pin(model)}>
                    {model.pinned ? <PinOff /> : <Pin />}
                    {model.pinned ? "Unpin" : "Pin to top"}
                </DropdownMenuItem>
                {model.kind === "custom" && (
                    <DropdownMenuItem onSelect={() => on.autopilot(model)}>
                        <Repeat />
                        {model.autopilot ? "Autopilot settings…" : "Turn on autopilot…"}
                    </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {model.deployed && (
                    <DropdownMenuItem variant="destructive" onSelect={() => on.undeploy([model])}>
                        <PowerOff />
                        {model.kind === "base" ? "Undeploy every format" : "Undeploy"}
                    </DropdownMenuItem>
                )}
                <DropdownMenuItem variant="destructive" onSelect={() => on.removeModels([model])}>
                    <Trash2 />
                    {model.kind === "custom" ? "Delete model and all versions" : "Delete model"}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function ModelActions({ model, on }: { model: FlowModel; on: Handlers }) {
    return (
        <div className="relative z-10 flex items-center justify-end gap-1">
            {model.deployed ? (
                <Button variant="secondary" onClick={() => openConnect(model.slug)}>
                    <Plug aria-hidden="true" />
                    Connect
                </Button>
            ) : (
                <Button variant="secondary" onClick={() => on.open(playgroundHref(model.slug))}>
                    <Play aria-hidden="true" />
                    Try
                </Button>
            )}
            <ModelMenu model={model} on={on} />
        </div>
    );
}

function QualityCell({ model, on }: { model: FlowModel; on: Handlers }) {
    const scored = scoredVersions(model);
    const headline = headlineVersion(model);
    if (model.kind === "base" || !headline) {
        return <Muted>{model.kind === "base" ? "Not scored" : "—"}</Muted>;
    }
    const live = liveVersion(model);
    return (
        <button
            type="button"
            aria-label={`Quick look at ${model.name}`}
            onClick={() => on.peek(model)}
            className="relative z-10 -mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-1 text-left hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
            <Sparkline
                points={scored.map((version) => ({
                    key: String(version.number),
                    label: `v${version.number}${version.number === live?.number ? " live" : ""}`,
                    value: version.scores?.[0] ?? 0,
                    marked: version.number === live?.number,
                }))}
                width={64}
                height={24}
                label={`${model.name} score over versions`}
                format={pct}
            />
            <span className="flex flex-col tabular-nums">
                <span>{pct(headline.scores?.[0])}</span>
                <span className="text-sm text-muted-foreground">
                    {live ? `v${live.number} live` : `v${headline.number}, not live`}
                </span>
            </span>
        </button>
    );
}

const STATUS_TONES = {
    canary: "info",
    candidate: "success",
    failed: "destructive",
    training: "info",
    update: "info",
} as const;

function ModelStatus({ model }: { model: FlowModel }) {
    const line = statusLine(model);
    const failed =
        line.kind === "failed" ? model.versions.find((v) => v.number === line.version) : undefined;
    const body = (() => {
        if (line.kind === "on") {
            return <LiveStatus machines={model.replicas} />;
        }
        if (line.kind === "off" || line.kind === "setup" || line.kind === "idle") {
            return <Muted>{line.text}</Muted>;
        }
        if (failed?.error) {
            return (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button type="button" className="relative z-10 rounded-sm text-left">
                            <StatusText tone="destructive">{line.text}</StatusText>
                        </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm whitespace-normal">
                        {failed.error}
                    </TooltipContent>
                </Tooltip>
            );
        }
        return (
            <StatusText tone={STATUS_TONES[line.kind]}>
                <span className="tabular-nums">{line.text}</span>
            </StatusText>
        );
    })();
    const version = line.version;
    return (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            {body}
            {line.kind === "failed" &&
                version !== undefined &&
                /memory/i.test(failed?.error ?? "") && (
                    <>
                        <span aria-hidden="true" className="text-faint">
                            ·
                        </span>
                        <button
                            type="button"
                            onClick={() => retryWithQLoRA(model.slug, version)}
                            className="relative z-10 rounded-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                            Retry with QLoRA
                        </button>
                    </>
                )}
            {line.kind === "candidate" && version !== undefined && (
                <>
                    <span aria-hidden="true" className="text-faint">
                        ·
                    </span>
                    <button
                        type="button"
                        onClick={() =>
                            openIntent({
                                kind: "make-live",
                                slug: model.slug,
                                number: version,
                            })
                        }
                        className="relative z-10 rounded-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                        Make live
                    </button>
                </>
            )}
            {model.autopilot && <AutopilotBadge />}
        </span>
    );
}

function baseFacts(model: FlowModel): string {
    const live = model.variants.filter((item) => item.live).length;
    return `${plural(model.variants.length, "variant")} · ${live} deployed`;
}

export type Hint = { text: string; action: string; href: string };

export function ModelRow({
    model,
    expanded,
    onToggle,
    on,
    hint,
    ...props
}: RowProps & {
    model: FlowModel;
    expanded: boolean;
    onToggle: () => void;
    on: Handlers;
    hint?: Hint;
}) {
    const children = props.nested
        ? model.kind === "base"
            ? model.variants.length
            : model.versions.length
        : 0;
    const liveVariants = model.variants.filter((item) => item.live);
    return (
        <li
            {...rowEvents(props, false)}
            aria-expanded={children > 0 ? expanded : undefined}
            aria-label={model.name}
            className={cn(ROW_GRID, ROW_STATE, "gap-y-1 py-3")}
        >
            <div className="flex min-w-0 items-center gap-2">
                {props.nested && (
                    <Chevron
                        name={model.name}
                        expandable={children > 0}
                        expanded={expanded}
                        noun={model.kind === "base" ? "variants" : "versions"}
                        onToggle={onToggle}
                    />
                )}
                <ModelAvatar model={model} />
                <div className="ml-1 flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                        <Link
                            href={flowHref(model.slug)}
                            tabIndex={-1}
                            className="truncate font-semibold text-foreground hover:underline"
                        >
                            {model.name}
                        </Link>
                        {model.pinned && (
                            <Pin
                                aria-label="Pinned"
                                className="size-3.5 shrink-0 text-muted-foreground"
                            />
                        )}
                    </span>
                    <span className="truncate text-sm text-muted-foreground tabular-nums">
                        {model.kind === "custom" ? `On ${model.base}` : baseFacts(model)}
                    </span>
                </div>
            </div>
            <Cells
                columns={props.columns}
                cells={{
                    quality: <QualityCell model={model} on={on} />,
                    requests: (
                        <div className="relative z-10">
                            <Requests
                                usage={usageOf(model.traffic, model.previous, model.deployed)}
                                live={model.deployed}
                            />
                        </div>
                    ),
                    cost:
                        model.kind === "base" ? (
                            <span className="flex flex-col whitespace-nowrap tabular-nums">
                                {liveVariants.length > 0 ? (
                                    <>
                                        <span>
                                            {gpuSeconds(
                                                Math.min(
                                                    ...liveVariants.map((item) => item.gpuSeconds),
                                                ),
                                            )}
                                        </span>
                                        <span className="text-sm text-muted-foreground">
                                            cheapest live
                                        </span>
                                    </>
                                ) : (
                                    <Muted />
                                )}
                            </span>
                        ) : (
                            <span className="whitespace-nowrap tabular-nums">
                                {gpuSeconds(model.gpuSeconds)}
                            </span>
                        ),
                    p95: model.deployed ? (
                        <span className="tabular-nums">{`${model.p95} ms`}</span>
                    ) : (
                        <Muted />
                    ),
                }}
            />
            <div className="min-w-0">
                <ModelStatus model={model} />
            </div>
            <ModelActions model={model} on={on} />
            {hint && (
                <p
                    className={cn(
                        "col-span-full text-sm text-muted-foreground",
                        props.nested ? "pl-[4.75rem]" : "pl-[2.75rem]",
                    )}
                >
                    {hint.text}{" "}
                    <Link
                        href={hint.href}
                        className="relative z-10 text-primary hover:underline"
                        tabIndex={-1}
                    >
                        {`${hint.action} →`}
                    </Link>
                </p>
            )}
        </li>
    );
}

function ChildBox({
    label,
    selected,
    onSelect,
}: {
    label: string;
    selected: boolean;
    onSelect: (on: boolean) => void;
}) {
    return (
        <>
            <span aria-hidden="true" className="size-6 shrink-0" />
            <label className="relative z-10 -my-2 flex w-8 shrink-0 cursor-pointer items-center justify-center self-stretch">
                <Checkbox
                    tabIndex={-1}
                    aria-label={label}
                    checked={selected}
                    onCheckedChange={(value) => onSelect(value === true)}
                />
            </label>
        </>
    );
}

function ScoreCell({ model, version }: { model: FlowModel; version: FlowVersion }) {
    if (!version.scores) {
        return <Muted />;
    }
    return (
        <span className="flex items-center gap-2 tabular-nums">
            <span>{pct(version.scores[0])}</span>
            <ScoreBadge model={model} version={version} />
        </span>
    );
}

function VersionStatusCell({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const share = liveShare(model, version.number);
    if (share !== null && version.status === "ready") {
        return (
            <LiveStatus
                machines={model.replicas}
                text={share === 100 ? "Live" : `Live · ${share}%`}
            />
        );
    }
    if (version.status === "failed") {
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <button type="button" className="relative z-10 rounded-sm text-left">
                        <VersionStatus model={model} version={version} />
                    </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm whitespace-normal">
                    {version.error}
                </TooltipContent>
            </Tooltip>
        );
    }
    return <VersionStatus model={model} version={version} />;
}

function VersionMenu({
    model,
    version,
    on,
}: {
    model: FlowModel;
    version: FlowVersion;
    on: Handlers;
}) {
    const live = liveVersion(model);
    const isLive = live?.number === version.number;
    const target = live && !isLive && live.scores && version.scores ? live : undefined;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`More actions for ${model.name} v${version.number}`}
                >
                    <MoreHorizontal />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem onSelect={() => on.open(flowHref(model.slug, version.number))}>
                    <Eye />
                    {`Open v${version.number}`}
                </DropdownMenuItem>
                {target && (
                    <DropdownMenuItem
                        onSelect={() =>
                            on.open(
                                compareHref(
                                    model.slug,
                                    Math.min(target.number, version.number),
                                    Math.max(target.number, version.number),
                                ),
                            )
                        }
                    >
                        <GitCompare />
                        {`Compare with live v${target.number}`}
                    </DropdownMenuItem>
                )}
                {version.status === "ready" && (
                    <DropdownMenuItem
                        onSelect={() => on.open(playgroundHref(model.slug, version.number))}
                    >
                        <Play />
                        {`Try ${model.slug}@${version.number}`}
                    </DropdownMenuItem>
                )}
                {version.status === "ready" && (
                    <DropdownMenuItem
                        onSelect={() => on.open(cardHref(model.slug, version.number))}
                    >
                        <FileText />
                        Model card
                    </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    variant="destructive"
                    disabled={isLive}
                    onSelect={() => on.removeVersions([{ model, version }])}
                >
                    <Trash2 />
                    {isLive ? `v${version.number} is live` : `Delete v${version.number}`}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function VersionRow({
    model,
    version,
    on,
    ...props
}: RowProps & { model: FlowModel; version: FlowVersion; on: Handlers }) {
    const live = liveVersion(model)?.number === version.number;
    return (
        <li
            {...rowEvents(props, true)}
            aria-label={`${model.name} v${version.number}`}
            className={cn(ROW_GRID, ROW_STATE, "py-1.5")}
        >
            <div className="flex min-w-0 items-center gap-2 self-stretch">
                <ChildBox
                    label={`Select ${model.name} v${version.number}`}
                    selected={props.selected}
                    onSelect={props.onSelect}
                />
                <span className="ml-1 flex min-w-0 items-center gap-2">
                    <span
                        aria-hidden="true"
                        className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            live ? "bg-success" : "bg-transparent",
                        )}
                    />
                    <Link
                        href={flowHref(model.slug, version.number)}
                        tabIndex={-1}
                        className="font-medium text-foreground tabular-nums hover:underline"
                    >
                        <VersionName version={version} />
                    </Link>
                    <span className="truncate text-sm text-muted-foreground">
                        {shortAgo(version)}
                    </span>
                </span>
            </div>
            <Cells
                columns={props.columns}
                cells={{ quality: <ScoreCell model={model} version={version} /> }}
            />
            <div className="min-w-0">
                <VersionStatusCell model={model} version={version} />
            </div>
            <div className="relative z-10 flex items-center justify-end gap-1">
                <MakeLiveButton model={model} version={version} variant="secondary" />
                <VersionMenu model={model} version={version} on={on} />
            </div>
        </li>
    );
}

function VariantStatus({ variant }: { variant: BaseVariant }) {
    return (
        <span className="flex min-w-0 flex-col items-start">
            {variant.live ? (
                <LiveStatus machines={variant.replicas} />
            ) : (
                <Muted>Not deployed</Muted>
            )}
            {variant.update && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            className="relative z-10 rounded-sm text-left text-sm text-info"
                        >
                            Update available
                        </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs whitespace-normal">
                        {variant.update}
                    </TooltipContent>
                </Tooltip>
            )}
        </span>
    );
}

export function VariantRow({
    model,
    variant,
    on,
    ...props
}: RowProps & { model: FlowModel; variant: BaseVariant; on: Handlers }) {
    const key = variantKey(model.slug, variant.id);
    return (
        <li
            {...rowEvents(props, true)}
            aria-label={`${model.name} ${variant.format}`}
            className={cn(ROW_GRID, ROW_STATE, "py-1.5")}
        >
            <div className="flex min-w-0 items-center gap-2 self-stretch">
                <ChildBox
                    label={`Select ${model.name} ${variant.format}`}
                    selected={props.selected}
                    onSelect={props.onSelect}
                />
                <span className="ml-1 flex min-w-0 items-center gap-2">
                    <span
                        aria-hidden="true"
                        className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            variant.live ? "bg-success" : "bg-transparent",
                        )}
                    />
                    <span className="flex min-w-0 flex-col">
                        <span className="flex items-baseline gap-2 whitespace-nowrap">
                            <span className="font-medium">{variant.format}</span>
                            <span className="text-sm text-muted-foreground tabular-nums">
                                {`${variant.size} · ${variant.trainable ? "Trainable" : "Serve-only"}`}
                            </span>
                        </span>
                        <span className="truncate font-mono text-sm text-muted-foreground">
                            {variant.apiName}
                        </span>
                    </span>
                </span>
            </div>
            <Cells
                columns={props.columns}
                cells={{
                    requests: variant.live ? (
                        <div className="relative z-10">
                            <Requests
                                usage={usageOf(variant.traffic, variant.previous, true)}
                                live
                            />
                        </div>
                    ) : null,
                    cost: (
                        <span className="whitespace-nowrap tabular-nums">
                            {gpuSeconds(variant.gpuSeconds)}
                        </span>
                    ),
                    p95: variant.p95 ? (
                        <span className="tabular-nums">{`${variant.p95} ms`}</span>
                    ) : (
                        <Muted />
                    ),
                }}
            />
            <div className="min-w-0">
                <VariantStatus variant={variant} />
            </div>
            <div className="relative z-10 flex items-center justify-end gap-1">
                {variant.live ? (
                    <Button variant="outline" onClick={() => on.undeployVariants([key])}>
                        Undeploy
                    </Button>
                ) : (
                    <Button variant="secondary" onClick={() => on.deployVariants([key])}>
                        Deploy
                    </Button>
                )}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`More actions for ${model.name} ${variant.format}`}
                        >
                            <MoreHorizontal />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-60">
                        <DropdownMenuItem onSelect={() => on.open(playgroundHref(model.slug))}>
                            <Play />
                            {`Try ${variant.format}`}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            variant="destructive"
                            disabled={variant.live}
                            onSelect={() => on.removeVariants([key])}
                        >
                            <Trash2 />
                            {variant.live ? `${variant.format} is live` : "Delete files"}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </li>
    );
}

export function MoreRow({
    model,
    shown,
    searching,
}: {
    model: FlowModel;
    shown: number;
    searching: boolean;
}) {
    return (
        <li className="col-span-full flex items-center gap-3 py-1.5 pr-4 pl-[5.75rem] text-sm">
            <span className="text-muted-foreground tabular-nums">
                {searching
                    ? `${shown} of ${plural(model.versions.length, "version")} match`
                    : `Showing ${shown} of ${model.versions.length}`}
            </span>
            <Link href={flowHref(model.slug)} className="text-primary hover:underline">
                {`All ${model.versions.length} versions →`}
            </Link>
        </li>
    );
}
