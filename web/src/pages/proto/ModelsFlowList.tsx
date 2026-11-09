import { useRouter } from "@tanstack/react-router";
import {
    ArrowUpDown,
    ChevronRight,
    Eye,
    FileText,
    GitCompare,
    GraduationCap,
    MoreHorizontal,
    Play,
    Plug,
    PowerOff,
    Trash2,
    X,
} from "lucide-react";
import {
    Button,
    Checkbox,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    FilterMenu,
    KbdHint,
    Link,
    SearchInput,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Separator,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
    useToast,
} from "obp-ui";
import { type KeyboardEvent, type MouseEvent, type ReactNode, useMemo, useState } from "react";
import type { ModelUsage } from "~/api/client";
import { Requests } from "~/components/models/ModelMetrics";
import { StatusText } from "~/components/models/StatusText";
import {
    FLOW,
    type FlowModel,
    type FlowVersion,
    KIND_LABELS,
    attention,
    compareHref,
    deleteModels,
    deleteVersions,
    flowHref,
    liveVersion,
    modelHref,
    newestFirst,
    pct,
    scoreDelta,
    shortAgo,
    shownVersions,
    undeployModels,
    useFlowModels,
    versionKey,
    versionState,
} from "./modelsFlowData";
import {
    Delta,
    DeployDialog,
    type DeployIntent,
    ModelAvatar,
    VersionStatus,
    deployBlocked,
    deployLabel,
} from "./modelsFlowParts";

type Kind = "model" | "version";
type Selection = { kind: Kind; keys: string[] };
type Line =
    | { key: string; type: "model"; model: FlowModel; expanded: boolean }
    | { key: string; type: "version"; model: FlowModel; version: FlowVersion }
    | { key: string; type: "more"; model: FlowModel; shown: number; searching: boolean };
type Confirm = {
    title: string;
    description: ReactNode;
    label: string;
    run: () => void;
};

type Filters = { deployed: boolean; attention: boolean };
type SortKey = "attention" | "score" | "name";

const SORTS: { value: SortKey; label: string }[] = [
    { value: "attention", label: "Needs attention first" },
    { value: "score", label: "Score, high to low" },
    { value: "name", label: "Name, A to Z" },
];

function passes(model: FlowModel, filters: Filters): boolean {
    return (
        (!filters.deployed || model.deployed) && (!filters.attention || attention(model) !== null)
    );
}

function scoreOf(model: FlowModel): number {
    const live = liveVersion(model)?.scores?.[0];
    return live ?? Math.max(-1, ...model.versions.map((version) => version.scores?.[0] ?? -1));
}

function sortModels(models: FlowModel[], sort: SortKey): FlowModel[] {
    const sorted = [...models];
    if (sort === "score") {
        return sorted.sort((a, b) => scoreOf(b) - scoreOf(a));
    }
    if (sort === "name") {
        return sorted.sort((a, b) => a.name.localeCompare(b.name));
    }
    return sorted.sort((a, b) => Number(attention(b) !== null) - Number(attention(a) !== null));
}

const EXPANDED_KEY = "minibrain.proto.flow.expanded";
const LIST_GRID =
    "grid grid-cols-[auto_minmax(14rem,1fr)_minmax(7rem,auto)_minmax(9rem,auto)_minmax(9rem,auto)_auto] gap-x-4";
const ROW_GRID = "col-span-full grid grid-cols-subgrid items-center px-4";
const EMPTY_SELECTION: Selection = { kind: "model", keys: [] };

function readExpanded(): Record<string, boolean> {
    try {
        const raw = window.localStorage.getItem(EXPANDED_KEY);
        return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
        return {};
    }
}

function writeExpanded(value: Record<string, boolean>) {
    try {
        window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(value));
    } catch {
        return;
    }
}

export function forgetExpanded() {
    try {
        window.localStorage.removeItem(EXPANDED_KEY);
    } catch {
        return;
    }
}

function lineId(key: string): string {
    return `flow-line-${key}`;
}

function modelText(model: FlowModel): string {
    return `${model.name} ${model.description} ${model.base ?? ""} ${model.slug}`.toLowerCase();
}

function versionMatches(model: FlowModel, version: FlowVersion, text: string): boolean {
    const number = /^v(\d+)$/.exec(text);
    if (number) {
        return version.number === Number(number[1]);
    }
    const state = versionState(model, version).label;
    return `${KIND_LABELS[version.kind]} ${state} job #${version.jobId}`
        .toLowerCase()
        .includes(text);
}

function usageOf(model: FlowModel): ModelUsage | null {
    const total = model.traffic.reduce((sum, value) => sum + value, 0);
    if (total === 0 && !model.deployed) {
        return null;
    }
    return {
        days: [],
        daily: model.traffic,
        total,
        previous: model.previous,
        failed: 0,
        last_at: new Date().toISOString(),
        p50_ms: null,
    };
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function fromControl(event: MouseEvent | KeyboardEvent): boolean {
    return (event.target as HTMLElement).closest("a,button,label,input,[role=menuitem]") !== null;
}

function useExpanded() {
    const [stored, setStored] = useState<Record<string, boolean>>(readExpanded);
    const toggle = (slug: string, next: boolean) => {
        const value = { ...stored, [slug]: next };
        setStored(value);
        writeExpanded(value);
    };
    return { stored, toggle };
}

function buildLines(
    models: FlowModel[],
    text: string,
    stored: Record<string, boolean>,
    searchToggles: Record<string, boolean>,
): Line[] {
    const lines: Line[] = [];
    for (const model of models) {
        const nameHit = !text || modelText(model).includes(text);
        const hits = text ? newestFirst(model).filter((v) => versionMatches(model, v, text)) : [];
        if (!nameHit && hits.length === 0) {
            continue;
        }
        const searching = hits.length > 0;
        const expanded =
            model.versions.length > 0 &&
            (searching
                ? (searchToggles[model.slug] ?? true)
                : (stored[model.slug] ?? attention(model) !== null));
        lines.push({ key: model.slug, type: "model", model, expanded });
        if (!expanded) {
            continue;
        }
        const shown = searching ? hits : shownVersions(model);
        for (const version of shown) {
            lines.push({
                key: versionKey(model.slug, version.number),
                type: "version",
                model,
                version,
            });
        }
        if (shown.length < model.versions.length) {
            lines.push({
                key: `${model.slug}:more`,
                type: "more",
                model,
                shown: shown.length,
                searching,
            });
        }
    }
    return lines;
}

function ModelActions({ model, on }: { model: FlowModel; on: Handlers }) {
    return (
        <div className="relative z-10 flex items-center justify-end gap-1">
            {model.deployed ? (
                <Button variant="secondary" onClick={() => on.open(modelHref(model.slug, "api"))}>
                    <Plug aria-hidden="true" />
                    Use API
                </Button>
            ) : (
                <Button
                    variant="secondary"
                    onClick={() => on.open(`${FLOW}/playground?model=${model.slug}`)}
                >
                    <Play aria-hidden="true" />
                    Test
                </Button>
            )}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`More actions for ${model.name}`}
                    >
                        <MoreHorizontal />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                    <DropdownMenuItem onSelect={() => on.open(flowHref(model.slug))}>
                        <Eye />
                        View details
                    </DropdownMenuItem>
                    {model.kind === "custom" && (
                        <DropdownMenuItem
                            disabled={model.serveOnly}
                            className={model.serveOnly ? "items-start" : undefined}
                            onSelect={() => on.open(modelHref(model.slug))}
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
                    <DropdownMenuSeparator />
                    {model.deployed && (
                        <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => on.undeploy([model])}
                        >
                            <PowerOff />
                            Undeploy
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => on.removeModels([model])}
                    >
                        <Trash2 />
                        {model.kind === "custom" ? "Delete model and all versions" : "Delete model"}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

function DisabledWithTip({ tip, children }: { tip: string; children: ReactNode }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex">{children}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{tip}</TooltipContent>
        </Tooltip>
    );
}

function compareTarget(model: FlowModel, version: FlowVersion): FlowVersion | undefined {
    const live = liveVersion(model);
    if (live && live.number !== version.number && live.scores) {
        return live;
    }
    return newestFirst(model).find(
        (other) => other.number < version.number && other.scores !== null,
    );
}

function VersionActions({
    model,
    version,
    on,
}: {
    model: FlowModel;
    version: FlowVersion;
    on: Handlers;
}) {
    const label = deployLabel(model, version);
    const blocked = deployBlocked(version);
    const target = version.scores ? compareTarget(model, version) : undefined;
    const live = liveVersion(model)?.number === version.number;
    const deploy = label && !blocked && (
        <Button variant="secondary" size="sm" onClick={() => on.deploy({ model, version })}>
            {label.startsWith("Deploy") ? "Deploy" : label}
        </Button>
    );
    return (
        <div className="relative z-10 flex items-center justify-end gap-1">
            {deploy}
            {target ? (
                <Button variant="outline" size="sm" asChild>
                    <Link
                        href={compareHref(model.slug, target.number, version.number)}
                        aria-label={`Compare v${version.number} with v${target.number}`}
                    >
                        Compare
                    </Link>
                </Button>
            ) : (
                <DisabledWithTip
                    tip={
                        version.scores
                            ? "No earlier scored version to compare with."
                            : "Nothing to compare until it is scored."
                    }
                >
                    <Button variant="outline" size="sm" disabled>
                        Compare
                    </Button>
                </DisabledWithTip>
            )}
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
                    <DropdownMenuItem
                        onSelect={() => on.open(flowHref(model.slug, version.number))}
                    >
                        <Eye />
                        {`Open v${version.number}`}
                    </DropdownMenuItem>
                    {version.status === "ready" && (
                        <DropdownMenuItem
                            onSelect={() => on.open(`${FLOW}/playground?model=${model.slug}`)}
                        >
                            <Play />
                            {`Test v${version.number}`}
                        </DropdownMenuItem>
                    )}
                    {version.status === "ready" && (
                        <DropdownMenuItem
                            onSelect={() => on.open(flowHref(model.slug, version.number, "card"))}
                        >
                            <FileText />
                            Model card
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        variant="destructive"
                        disabled={live}
                        onSelect={() => on.removeVersions([{ model, version }])}
                    >
                        <Trash2 />
                        {live ? `v${version.number} is live` : `Delete v${version.number}`}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

function Chevron({
    model,
    expanded,
    onToggle,
}: {
    model: FlowModel;
    expanded: boolean;
    onToggle: () => void;
}) {
    if (model.versions.length === 0) {
        return <span aria-hidden="true" className="size-6 shrink-0" />;
    }
    return (
        <Button
            variant="ghost"
            size="icon-xs"
            tabIndex={-1}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} versions of ${model.name}`}
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

function ModelStatus({ model }: { model: FlowModel }) {
    const reason = attention(model);
    return (
        <span className="flex min-w-0 flex-col">
            {model.deployed ? (
                <StatusText tone="success">Live</StatusText>
            ) : (
                <span className="text-muted-foreground">Not deployed</span>
            )}
            {reason && <span className="truncate text-sm text-muted-foreground">{reason}</span>}
        </span>
    );
}

function LiveCell({ model }: { model: FlowModel }) {
    const live = liveVersion(model);
    if (!live) {
        return <span className="text-muted-foreground">—</span>;
    }
    return (
        <span className="tabular-nums">
            {`v${live.number}`}
            <span className="text-muted-foreground">{` · ${pct(live.scores?.[0])}`}</span>
        </span>
    );
}

type Handlers = {
    open: (href: string) => void;
    deploy: (intent: DeployIntent) => void;
    undeploy: (models: FlowModel[]) => void;
    removeModels: (models: FlowModel[]) => void;
    removeVersions: (items: { model: FlowModel; version: FlowVersion }[]) => void;
};

type RowProps = {
    focused: boolean;
    selected: boolean;
    selecting: boolean;
    onFocus: () => void;
    onKey: (event: KeyboardEvent<HTMLLIElement>) => void;
    onSelect: (on: boolean) => void;
    open: () => void;
};

function rowEvents(props: RowProps) {
    return {
        tabIndex: props.focused ? 0 : -1,
        onFocus: props.onFocus,
        onKeyDown: props.onKey,
        onClick: (event: MouseEvent<HTMLLIElement>) => {
            if (fromControl(event)) {
                return;
            }
            if (props.selecting) {
                props.onSelect(!props.selected);
                return;
            }
            props.open();
        },
    };
}

const ROW_STATE =
    "relative cursor-pointer outline-none hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[state=selected]:bg-accent";

function ModelRow({
    model,
    expanded,
    onToggle,
    on,
    ...props
}: RowProps & {
    model: FlowModel;
    expanded: boolean;
    onToggle: () => void;
    on: Handlers;
}) {
    return (
        <li
            {...rowEvents(props)}
            id={lineId(model.slug)}
            aria-expanded={model.versions.length > 0 ? expanded : undefined}
            aria-label={model.name}
            data-state={props.selected ? "selected" : undefined}
            className={cn(ROW_GRID, ROW_STATE, "py-3")}
        >
            <label className="relative z-10 -my-3 -ml-4 flex cursor-pointer items-center self-stretch py-3 pr-2 pl-4">
                <Checkbox
                    tabIndex={-1}
                    aria-label={`Select ${model.name}`}
                    checked={props.selected}
                    onCheckedChange={(value) => props.onSelect(value === true)}
                />
            </label>
            <div className="flex min-w-0 items-center gap-2">
                <Chevron model={model} expanded={expanded} onToggle={onToggle} />
                <ModelAvatar model={model} />
                <div className="ml-1 flex min-w-0 flex-col">
                    <Link
                        href={flowHref(model.slug)}
                        tabIndex={-1}
                        className="truncate font-semibold text-foreground hover:underline"
                    >
                        {model.name}
                    </Link>
                    <span className="truncate text-sm text-muted-foreground">
                        {model.kind === "custom"
                            ? `On ${model.base}`
                            : `${model.serveOnly ? "Serve-only base" : "Base"} · ${model.size}`}
                    </span>
                </div>
            </div>
            <div className="min-w-0">
                <LiveCell model={model} />
            </div>
            <div className="relative z-10 min-w-0">
                <Requests usage={usageOf(model)} live={model.deployed} />
            </div>
            <div className="min-w-0">
                <ModelStatus model={model} />
            </div>
            <ModelActions model={model} on={on} />
        </li>
    );
}

function ScoreCell({ model, version }: { model: FlowModel; version: FlowVersion }) {
    if (!version.scores) {
        return <span className="text-muted-foreground">—</span>;
    }
    const live = liveVersion(model)?.number === version.number;
    return (
        <span className="flex items-baseline gap-2 tabular-nums">
            <span>{pct(version.scores[0])}</span>
            {live ? (
                <span className="text-sm text-muted-foreground">live</span>
            ) : (
                <span className="text-sm">
                    <Delta value={scoreDelta(model, version)} suffix="vs live" />
                </span>
            )}
        </span>
    );
}

function FailedStatus({ model, version }: { model: FlowModel; version: FlowVersion }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="relative z-10 rounded-sm text-left">
                    <VersionStatus model={model} version={version} />
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-normal">{version.error}</TooltipContent>
        </Tooltip>
    );
}

function VersionRow({
    model,
    version,
    on,
    ...props
}: RowProps & { model: FlowModel; version: FlowVersion; on: Handlers }) {
    const live = liveVersion(model)?.number === version.number;
    return (
        <li
            {...rowEvents(props)}
            id={lineId(versionKey(model.slug, version.number))}
            aria-label={`${model.name} v${version.number}`}
            data-state={props.selected ? "selected" : undefined}
            className={cn(ROW_GRID, ROW_STATE, "py-1.5")}
        >
            <label className="relative z-10 -my-1.5 -ml-4 flex cursor-pointer items-center self-stretch py-1.5 pr-2 pl-4">
                <Checkbox
                    tabIndex={-1}
                    aria-label={`Select ${model.name} v${version.number}`}
                    checked={props.selected}
                    onCheckedChange={(value) => props.onSelect(value === true)}
                />
            </label>
            <div className="flex min-w-0 items-center gap-2 self-stretch">
                <span aria-hidden="true" className="size-6 shrink-0" />
                <span
                    aria-hidden="true"
                    className="-my-1.5 flex w-8 shrink-0 justify-center self-stretch"
                >
                    <span className="w-px bg-border" />
                </span>
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
                        {`v${version.number}`}
                    </Link>
                    <span className="truncate text-sm text-muted-foreground">
                        {`${KIND_LABELS[version.kind]} · ${shortAgo(version)}`}
                    </span>
                </span>
            </div>
            <div className="min-w-0">
                <ScoreCell model={model} version={version} />
            </div>
            <div />
            <div className="min-w-0 text-muted-foreground">
                {version.status === "failed" ? (
                    <FailedStatus model={model} version={version} />
                ) : (
                    <span className="text-foreground">
                        <VersionStatus model={model} version={version} />
                    </span>
                )}
            </div>
            <VersionActions model={model} version={version} on={on} />
        </li>
    );
}

function MoreRow({
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

function ConfirmDialog({
    confirm,
    onClose,
}: {
    confirm: Confirm | null;
    onClose: () => void;
}) {
    if (!confirm) {
        return null;
    }
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{confirm.title}</DialogTitle>
                    <DialogDescription asChild>
                        <div>{confirm.description}</div>
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <DialogClose asChild>
                        <Button variant="outline">Cancel</Button>
                    </DialogClose>
                    <Button
                        variant="destructive"
                        onClick={() => {
                            confirm.run();
                            onClose();
                        }}
                    >
                        {confirm.label}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

type Picked = { model: FlowModel; version: FlowVersion };

function pickedVersions(models: FlowModel[], keys: string[]): Picked[] {
    return models.flatMap((model) =>
        model.versions
            .filter((version) => keys.includes(versionKey(model.slug, version.number)))
            .map((version) => ({ model, version })),
    );
}

function compareBlock(picked: Picked[]): string | null {
    if (picked.length !== 2) {
        return "Pick exactly two versions of one model to compare.";
    }
    if (picked[0].model.slug !== picked[1].model.slug) {
        return "The two versions belong to different models; pick two of one model.";
    }
    if (picked.some((item) => !item.version.scores)) {
        return "Both versions need a score to compare.";
    }
    return null;
}

function SelectionBar({
    selection,
    models,
    onClear,
    on,
}: {
    selection: Selection;
    models: FlowModel[];
    onClear: () => void;
    on: Handlers;
}) {
    const chosenModels = models.filter((model) => selection.keys.includes(model.slug));
    const picked = pickedVersions(models, selection.keys);
    const liveOnes = picked.filter(
        (item) => liveVersion(item.model)?.number === item.version.number,
    );
    const blocked = compareBlock(picked);
    const sorted = [...picked].sort((a, b) => a.version.number - b.version.number);
    const owners = [...new Set(picked.map((item) => item.model.name))];
    const count =
        selection.kind === "model"
            ? plural(chosenModels.length, "model")
            : plural(picked.length, "version");
    const compare = (
        <Button
            variant="outline"
            disabled={Boolean(blocked)}
            onClick={() =>
                on.open(
                    compareHref(
                        sorted[0].model.slug,
                        sorted[0].version.number,
                        sorted[1].version.number,
                    ),
                )
            }
        >
            <GitCompare aria-hidden="true" />
            Compare
        </Button>
    );
    return (
        <div className="flex min-h-8 flex-wrap items-center gap-2">
            <span className="font-medium tabular-nums">{`${count} selected`}</span>
            {selection.kind === "version" && owners.length === 1 && (
                <span className="text-muted-foreground">{`of ${owners[0]}`}</span>
            )}
            <Button variant="outline" onClick={onClear}>
                <X aria-hidden="true" />
                Clear selection
            </Button>
            {selection.kind === "version" && liveOnes.length > 0 && (
                <span className="text-sm text-muted-foreground">
                    {`${liveOnes.map((item) => `v${item.version.number} of ${item.model.name}`).join(", ")} ${liveOnes.length === 1 ? "is" : "are"} live and will not be deleted.`}
                </span>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
                {selection.kind === "version" ? (
                    blocked ? (
                        <DisabledWithTip tip={blocked}>{compare}</DisabledWithTip>
                    ) : (
                        compare
                    )
                ) : (
                    <Button
                        variant="outline"
                        disabled={!chosenModels.some((model) => model.deployed)}
                        onClick={() => on.undeploy(chosenModels.filter((model) => model.deployed))}
                    >
                        <PowerOff aria-hidden="true" />
                        Undeploy
                    </Button>
                )}
                <Separator
                    orientation="vertical"
                    className="mx-1 data-[orientation=vertical]:h-5"
                />
                <Button
                    variant="destructive"
                    disabled={selection.kind === "version" && liveOnes.length === picked.length}
                    onClick={() =>
                        selection.kind === "model"
                            ? on.removeModels(chosenModels)
                            : on.removeVersions(picked)
                    }
                >
                    <Trash2 aria-hidden="true" />
                    Delete
                </Button>
            </div>
        </div>
    );
}

function GroupHeading({ label, facts }: { label: string; facts: string }) {
    return (
        <li className="col-span-full flex items-baseline gap-2 px-4 pt-4 pb-1.5 text-sm text-muted-foreground">
            <span className="font-medium">{label}</span>
            <span className="tabular-nums">{facts}</span>
        </li>
    );
}

export function ModelsFlowList() {
    const models = useFlowModels();
    const router = useRouter();
    const toast = useToast();
    const expanded = useExpanded();
    const [query, setQuery] = useState("");
    const [searchToggles, setSearchToggles] = useState<Record<string, boolean>>({});
    const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
    const [focusKey, setFocusKey] = useState<string | null>(null);
    const [deploy, setDeploy] = useState<DeployIntent>(null);
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const [filters, setFilters] = useState<Filters>({ deployed: false, attention: false });
    const [sort, setSort] = useState<SortKey>("attention");
    const text = query.trim().toLowerCase();
    const lines = useMemo(
        () =>
            buildLines(
                sortModels(
                    models.filter((model) => passes(model, filters)),
                    sort,
                ),
                text,
                expanded.stored,
                searchToggles,
            ),
        [models, filters, sort, text, expanded.stored, searchToggles],
    );
    const rows = lines.filter((line) => line.type !== "more");
    const activeKey = rows.some((line) => line.key === focusKey) ? focusKey : rows[0]?.key;
    const clear = () => setSelection(EMPTY_SELECTION);
    const on: Handlers = {
        open: (href) => router.history.push(href),
        deploy: setDeploy,
        undeploy: (chosen) =>
            setConfirm({
                title:
                    chosen.length === 1
                        ? `Undeploy ${chosen[0].name}?`
                        : `Undeploy ${plural(chosen.length, "model")}?`,
                description: <p>Their APIs stop answering; versions, keys and files stay.</p>,
                label: "Undeploy",
                run: () => {
                    undeployModels(chosen.map((model) => model.slug));
                    clear();
                    toast({
                        title: `Undeployed ${chosen.map((model) => model.name).join(", ")}`,
                        tone: "success",
                    });
                },
            }),
        removeModels: (chosen) =>
            setConfirm({
                title:
                    chosen.length === 1
                        ? `Delete ${chosen[0].name}?`
                        : `Delete ${plural(chosen.length, "model")}?`,
                description: (
                    <p>
                        {`${chosen.map((model) => model.name).join(", ")} ${chosen.length === 1 ? "goes" : "go"} with every version, key and file.`}
                    </p>
                ),
                label: "Delete",
                run: () => {
                    deleteModels(chosen.map((model) => model.slug));
                    clear();
                    toast({ title: `Deleted ${plural(chosen.length, "model")}`, tone: "success" });
                },
            }),
        removeVersions: (items) => {
            const deletable = items.filter(
                (item) => liveVersion(item.model)?.number !== item.version.number,
            );
            const skipped = items.length - deletable.length;
            setConfirm({
                title: `Delete ${plural(deletable.length, "version")}?`,
                description: (
                    <div className="flex flex-col gap-2">
                        <p>
                            {deletable
                                .map((item) => `${item.model.name} v${item.version.number}`)
                                .join(", ")}
                        </p>
                        {skipped > 0 && (
                            <p>{`${plural(skipped, "live version")} skipped: undeploy or deploy another version first.`}</p>
                        )}
                    </div>
                ),
                label: "Delete",
                run: () => {
                    deleteVersions(
                        deletable.map((item) => versionKey(item.model.slug, item.version.number)),
                    );
                    clear();
                    toast({
                        title: `Deleted ${plural(deletable.length, "version")}`,
                        tone: "success",
                    });
                },
            });
        },
    };
    const select = (kind: Kind, key: string, on: boolean) => {
        if (on && selection.keys.length > 0 && selection.kind !== kind) {
            setSelection({ kind, keys: [key] });
            toast({
                title:
                    kind === "version"
                        ? "Selection switched to versions"
                        : "Selection switched to models",
                description: `A selection is all models or all versions, so the ${plural(selection.keys.length, selection.kind)} you had ticked ${selection.keys.length === 1 ? "was" : "were"} cleared.`,
            });
            return;
        }
        const keys = on
            ? [...new Set([...selection.keys, key])]
            : selection.keys.filter((item) => item !== key);
        setSelection({ kind, keys });
    };
    const toggle = (line: Extract<Line, { type: "model" }>) => {
        const next = !line.expanded;
        if (text && line.model.versions.some((v) => versionMatches(line.model, v, text))) {
            setSearchToggles({ ...searchToggles, [line.model.slug]: next });
        } else {
            expanded.toggle(line.model.slug, next);
        }
    };
    const focusLine = (key: string | undefined) => {
        if (!key) {
            return;
        }
        setFocusKey(key);
        requestAnimationFrame(() => document.getElementById(lineId(key))?.focus());
    };
    const hrefOf = (line: Line) =>
        line.type === "version"
            ? flowHref(line.model.slug, line.version.number)
            : flowHref(line.model.slug);
    const onKey = (line: Line) => (event: KeyboardEvent<HTMLLIElement>) => {
        if (event.target !== event.currentTarget) {
            return;
        }
        const index = rows.findIndex((row) => row.key === line.key);
        const keys: Record<string, () => void> = {
            ArrowDown: () => focusLine(rows[index + 1]?.key),
            ArrowUp: () => focusLine(rows[index - 1]?.key),
            Home: () => focusLine(rows[0]?.key),
            End: () => focusLine(rows.at(-1)?.key),
            Enter: () => on.open(hrefOf(line)),
            " ": () =>
                line.type !== "more" &&
                select(line.type, line.key, !selection.keys.includes(line.key)),
            ArrowRight: () => {
                if (line.type !== "model" || line.model.versions.length === 0) {
                    return;
                }
                if (line.expanded) {
                    focusLine(rows[index + 1]?.key);
                } else {
                    toggle(line);
                }
            },
            ArrowLeft: () => {
                if (line.type === "model" && line.expanded) {
                    toggle(line);
                } else if (line.type === "version") {
                    focusLine(line.model.slug);
                }
            },
        };
        const action = keys[event.key];
        if (action) {
            event.preventDefault();
            action();
        }
    };
    const rowProps = (line: Line): RowProps => ({
        focused: line.key === activeKey,
        selected: selection.keys.includes(line.key),
        selecting: selection.keys.length > 0,
        onFocus: () => setFocusKey(line.key),
        onKey: onKey(line),
        onSelect: (value) => line.type !== "more" && select(line.type, line.key, value),
        open: () => on.open(hrefOf(line)),
    });
    const custom = lines.filter((line) => line.model.kind === "custom");
    const bases = lines.filter((line) => line.model.kind === "base");
    const modelKeys = models.map((model) => model.slug);
    const allModels =
        selection.kind === "model" && selection.keys.length > 0
            ? selection.keys.length === modelKeys.length
                ? true
                : "indeterminate"
            : false;
    const render = (line: Line) => {
        if (line.type === "model") {
            return (
                <ModelRow
                    key={line.key}
                    model={line.model}
                    expanded={line.expanded}
                    onToggle={() => toggle(line)}
                    on={on}
                    {...rowProps(line)}
                />
            );
        }
        if (line.type === "version") {
            return (
                <VersionRow
                    key={line.key}
                    model={line.model}
                    version={line.version}
                    on={on}
                    {...rowProps(line)}
                />
            );
        }
        return (
            <MoreRow
                key={line.key}
                model={line.model}
                shown={line.shown}
                searching={line.searching}
            />
        );
    };
    const customCount = custom.filter((line) => line.type === "model").length;
    const baseCount = bases.filter((line) => line.type === "model").length;
    return (
        <div className="flex flex-col gap-3">
            {selection.keys.length > 0 ? (
                <SelectionBar selection={selection} models={models} onClear={clear} on={on} />
            ) : (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                    <SearchInput
                        aria-label="Search models and versions"
                        placeholder="Search models and versions"
                        value={query}
                        onValueChange={(value) => {
                            setQuery(value);
                            setSearchToggles({});
                        }}
                        className="w-full max-w-xs flex-1"
                    />
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                        <FilterMenu
                            sections={[
                                {
                                    kind: "toggle",
                                    key: "deployed",
                                    title: "Deployment",
                                    label: "Deployed",
                                    count: models.filter((model) => model.deployed).length,
                                    checked: filters.deployed,
                                    onCheckedChange: (deployed) =>
                                        setFilters({ ...filters, deployed }),
                                },
                                {
                                    kind: "toggle",
                                    key: "attention",
                                    title: "Attention",
                                    label: "Needs attention",
                                    count: models.filter((model) => attention(model) !== null)
                                        .length,
                                    checked: filters.attention,
                                    onCheckedChange: (value) =>
                                        setFilters({ ...filters, attention: value }),
                                },
                            ]}
                            onClear={() => setFilters({ deployed: false, attention: false })}
                        />
                        <Select value={sort} onValueChange={(value) => setSort(value as SortKey)}>
                            <SelectTrigger aria-label="Sort models" className="w-auto min-w-48">
                                <ArrowUpDown
                                    aria-hidden="true"
                                    className="size-4 text-muted-foreground"
                                />
                                <SelectValue className="flex-1 text-left" />
                            </SelectTrigger>
                            <SelectContent>
                                {SORTS.map((option) => (
                                    <SelectItem key={option.value} value={option.value}>
                                        {option.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            )}
            <div className={cn(LIST_GRID, "overflow-x-auto rounded-lg border bg-card")}>
                <div
                    className={cn(
                        ROW_GRID,
                        "h-9 border-b bg-secondary font-medium text-muted-foreground",
                    )}
                >
                    <label className="-ml-4 flex cursor-pointer items-center self-stretch pr-2 pl-4">
                        <Checkbox
                            aria-label="Select all models"
                            checked={allModels === true}
                            indeterminate={allModels === "indeterminate"}
                            onCheckedChange={(value) => {
                                if (value !== true) {
                                    clear();
                                    return;
                                }
                                if (selection.kind === "version" && selection.keys.length > 0) {
                                    toast({
                                        title: "Selection switched to models",
                                        description:
                                            "A selection is all models or all versions, so the ticked versions were cleared.",
                                    });
                                }
                                setSelection({ kind: "model", keys: modelKeys });
                            }}
                        />
                    </label>
                    <span>Model</span>
                    <span>Live version</span>
                    <span>Requests, 7 days</span>
                    <span>Status</span>
                    <span className="sr-only">Actions</span>
                </div>
                {lines.length === 0 ? (
                    <div className="col-span-full flex min-h-40 items-center justify-center gap-2 text-muted-foreground">
                        No models or versions match.
                    </div>
                ) : (
                    <ul
                        aria-label="Models"
                        className="col-span-full grid grid-cols-subgrid divide-y"
                    >
                        {customCount > 0 && (
                            <GroupHeading
                                label="Your models"
                                facts={plural(customCount, "model")}
                            />
                        )}
                        {custom.map(render)}
                        {baseCount > 0 && (
                            <GroupHeading label="Base models" facts={plural(baseCount, "model")} />
                        )}
                        {bases.map(render)}
                    </ul>
                )}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <KbdHint keys={["↑", "↓"]}>move</KbdHint>
                <KbdHint keys={["→"]}>expand</KbdHint>
                <KbdHint keys={["←"]}>collapse</KbdHint>
                <KbdHint keys={["Enter"]}>open</KbdHint>
                <KbdHint keys={["Space"]}>select</KbdHint>
            </div>
            <DeployDialog intent={deploy} onOpenChange={(open) => !open && setDeploy(null)} />
            <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
        </div>
    );
}
