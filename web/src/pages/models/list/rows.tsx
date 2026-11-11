import {
    ArrowRightLeft,
    ChevronRight,
    CircleX,
    Copy,
    Eye,
    FileText,
    GitCompare,
    GraduationCap,
    MoreHorizontal,
    PanelRight,
    Pencil,
    Play,
    Plug,
    PowerOff,
    Rocket,
    RotateCcw,
    Trash2,
    Wrench,
} from "lucide-react";
import {
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
import type { ModelRow, ModelVersionRow } from "~/api/client";
import { Sparkline } from "~/components/Sparkline";
import type { HealthAction } from "~/components/models/HealthStatus";
import { Requests } from "~/components/models/ModelMetrics";
import type { Abilities } from "~/lib/access";
import { costText } from "~/lib/cost";
import { modelCardHref, modelPageHref, playgroundHref, trainingHref } from "~/lib/modelLinks";
import { RETRY_LABELS, REVIEW_LABEL, busyTearingDown, needsReview } from "~/lib/teardown";
import { bytes, relativeTime } from "~/lib/time";
import type { Entry } from "../entries";
import {
    LiveStatus,
    ModelAvatar,
    Muted,
    ScoreBadge,
    StatusLineText,
    VersionName,
    VersionStatus,
} from "./cells";
import { COLUMNS, type Column } from "./filters";
import {
    type ListModel,
    canMakeLive,
    childCount,
    costOf,
    deployed,
    headlineOf,
    hrefOf,
    isDeployed,
    liveOf,
    pct,
    plural,
    replicasOf,
    scoredVersions,
    statusLine,
    usageOf,
    variantLine,
} from "./model";

export type Handlers = {
    open: (href: string) => void;
    peek: (model: ListModel) => void;
    makeLive: (model: ListModel, version: ModelVersionRow) => void;
    compare: (model: ListModel, numbers: [number, number]) => void;
    edit: (row: ModelRow) => void;
    duplicate: (row: ModelRow) => void;
    switchBase: (row: ModelRow, preferred: string | null) => void;
    createFrom: (row: ModelRow) => void;
    deploy: (rows: ModelRow[]) => void;
    undeploy: (rows: ModelRow[]) => void;
    remove: (entries: Entry[]) => void;
    health: (row: ModelRow, action: HealthAction) => void;
    retryTeardown: (row: ModelRow) => void;
    retryDownload: (row: ModelRow) => void;
    cancelTransfer: (row: ModelRow) => void;
};

export type RowProps = {
    id: string;
    nested: boolean;
    focused: boolean;
    selected: boolean;
    selecting: boolean;
    selectable: boolean;
    peeked: boolean;
    columns: Column[];
    can: Abilities;
    onFocus: () => void;
    onKey: (event: KeyboardEvent<HTMLLIElement>) => void;
    onSelect: (on: boolean) => void;
    open: () => void;
};

const ROW_STATE =
    "relative cursor-pointer outline-none hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[state=selected]:bg-accent data-[peeked=true]:bg-accent";
export const ROW_GRID = "col-span-full grid grid-cols-subgrid items-center px-4";

function fromControl(event: MouseEvent): boolean {
    return (event.target as HTMLElement).closest("a,button,label,input,[role=menuitem]") !== null;
}

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
            if (child && props.selecting && props.selectable) {
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

function Milliseconds({ value }: { value: number | null | undefined }) {
    if (value === null || value === undefined) {
        return <Muted />;
    }
    return <span className="tabular-nums">{`${Math.round(value)} ms`}</span>;
}

function QualityCell({ model, on }: { model: ListModel; on: Handlers }) {
    const headline = headlineOf(model);
    if (model.kind === "base" || !headline) {
        return <Muted>{model.kind === "base" ? "Not scored" : "—"}</Muted>;
    }
    const live = liveOf(model);
    return (
        <button
            type="button"
            aria-label={`Quick look at ${model.name}`}
            onClick={() => on.peek(model)}
            className="relative z-10 -mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-1 text-left hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
            <Sparkline
                points={scoredVersions(model).map((version) => ({
                    key: String(version.number),
                    label: `v${version.number}${version.live ? " live" : ""}`,
                    value: version.score ?? 0,
                    marked: version.live,
                }))}
                width={64}
                height={24}
                label={`${model.name} score over versions`}
                format={pct}
            />
            <span className="flex flex-col tabular-nums">
                <span>{pct(headline.score)}</span>
                <span className="text-sm text-muted-foreground">
                    {live ? `v${live.number} live` : `v${headline.number}, not live`}
                </span>
            </span>
        </button>
    );
}

function MakeLiveLink({
    model,
    number,
    on,
}: {
    model: ListModel;
    number: number;
    on: Handlers;
}) {
    const version = model.versions.find((item) => item.number === number);
    if (!version || !canMakeLive(model, version)) {
        return null;
    }
    return (
        <>
            <span aria-hidden="true" className="text-faint">
                ·
            </span>
            <button
                type="button"
                onClick={() => on.makeLive(model, version)}
                className="relative z-10 rounded-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
                {`Make v${number} live`}
            </button>
        </>
    );
}

function ModelStatus({ model, on, can }: { model: ListModel; on: Handlers; can: Abilities }) {
    const line = statusLine(model);
    const prefix =
        model.kind === "base" && model.variants.length > 1 && line.kind !== "update"
            ? line.row.variant_label
            : null;
    return (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            {prefix && line.kind !== "on" && line.kind !== "off" && (
                <span className="text-sm text-muted-foreground">{prefix}</span>
            )}
            <StatusLineText line={line} name={model.name} replicas={replicasOf(model)} />
            {can.build &&
                (line.kind === "candidate" || line.kind === "ready") &&
                line.version !== undefined && (
                    <MakeLiveLink model={model} number={line.version} on={on} />
                )}
        </span>
    );
}

function TrainItem({
    label,
    blocked,
    onSelect,
}: {
    label: string;
    blocked: string | null;
    onSelect: () => void;
}) {
    if (!blocked) {
        return (
            <DropdownMenuItem onSelect={onSelect}>
                <GraduationCap />
                {label}
            </DropdownMenuItem>
        );
    }
    return (
        <DropdownMenuItem disabled className="items-start">
            <GraduationCap className="mt-0.5" />
            <span className="flex flex-col">
                <span>{label}</span>
                <span className="max-w-60 text-sm whitespace-normal text-muted-foreground">
                    {blocked}
                </span>
            </span>
        </DropdownMenuItem>
    );
}

function HealthItems({
    row,
    on,
    can,
}: {
    row: ModelRow;
    on: Handlers;
    can: Abilities;
}) {
    const manages = can.admin || row.kind === "custom";
    const fixes = (row.health?.actions ?? []).filter(
        (action) => manages && action.kind !== "remove",
    );
    const retryable = row.teardown?.state === "failed" ? row.teardown : null;
    return (
        <>
            {retryable && (manages || retryable.kind === "undeploy") && (
                <DropdownMenuItem onSelect={() => on.retryTeardown(row)}>
                    <RotateCcw />
                    {needsReview(retryable) ? REVIEW_LABEL : RETRY_LABELS[retryable.kind]}
                </DropdownMenuItem>
            )}
            {fixes.map((action) => (
                <DropdownMenuItem key={action.kind} onSelect={() => on.health(row, action)}>
                    <Wrench />
                    {action.label}
                </DropdownMenuItem>
            ))}
        </>
    );
}

function CustomItems({ model, on, can }: { model: ListModel; on: Handlers; can: Abilities }) {
    const row = model.row;
    const limit = row.serve_only;
    const blocked =
        row.health?.state === "base_unusable"
            ? `Fix the base model first: ${row.health.label}`
            : (limit?.reason ?? null);
    return (
        <>
            <HealthItems row={row} on={on} can={can} />
            <DropdownMenuItem onSelect={() => on.edit(row)}>
                <Pencil />
                Edit
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => on.duplicate(row)}>
                <Copy />
                Duplicate
            </DropdownMenuItem>
            <TrainItem
                label="Train"
                blocked={blocked}
                onSelect={() => on.open(trainingHref(row.key))}
            />
            <DropdownMenuItem onSelect={() => on.switchBase(row, limit?.switch_to?.key ?? null)}>
                <ArrowRightLeft />
                {limit?.switch_to ? `Move to ${limit.switch_to.name}` : "Switch base"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {isDeployed(row) && (
                <DropdownMenuItem variant="destructive" onSelect={() => on.undeploy([row])}>
                    <PowerOff />
                    Undeploy
                </DropdownMenuItem>
            )}
            <DropdownMenuItem
                variant="destructive"
                onSelect={() =>
                    on.remove([{ key: `custom:${row.key}`, model: row, version: null }])
                }
            >
                <Trash2 />
                Delete model and all versions
            </DropdownMenuItem>
        </>
    );
}

function moving(row: ModelRow): boolean {
    return row.kind === "base" && ["running", "queued"].includes(row.activity.state);
}

function BaseItems({ model, on, can }: { model: ListModel; on: Handlers; can: Abilities }) {
    const lead = model.row;
    const single = model.variants.length === 1;
    const ready = lead.availability.state === "available";
    const live = model.variants.filter(isDeployed);
    const transferring = model.variants.filter((row) => moving(row) && row.activity.job_id);
    return (
        <>
            {single && <HealthItems row={lead} on={on} can={can} />}
            {can.admin && single && (
                <DropdownMenuItem onSelect={() => on.edit(lead)}>
                    <Pencil />
                    Edit
                </DropdownMenuItem>
            )}
            {ready && (
                <TrainItem
                    label="Train a model on it"
                    blocked={lead.health ? `Fix the base model first: ${lead.health.label}` : null}
                    onSelect={() => on.createFrom(lead)}
                />
            )}
            {single && ready && !lead.health && !isDeployed(lead) && (
                <DropdownMenuItem onSelect={() => on.deploy([lead])}>
                    <Rocket />
                    Deploy
                </DropdownMenuItem>
            )}
            {can.admin &&
                single &&
                lead.activity.state === "failed" &&
                lead.availability.state === "not_downloaded" && (
                    <DropdownMenuItem onSelect={() => on.retryDownload(lead)}>
                        <RotateCcw />
                        Retry download
                    </DropdownMenuItem>
                )}
            {can.admin &&
                transferring.map((row) => (
                    <DropdownMenuItem key={row.key} onSelect={() => on.cancelTransfer(row)}>
                        <CircleX />
                        {single ? "Cancel download" : `Cancel ${row.variant_label ?? row.name}`}
                    </DropdownMenuItem>
                ))}
            {(live.length > 0 || can.admin) && <DropdownMenuSeparator />}
            {live.length > 0 && (
                <DropdownMenuItem variant="destructive" onSelect={() => on.undeploy(live)}>
                    <PowerOff />
                    {single ? "Undeploy" : "Undeploy every format"}
                </DropdownMenuItem>
            )}
            {can.admin && (
                <DropdownMenuItem
                    variant="destructive"
                    onSelect={() =>
                        on.remove(
                            model.variants.map((row) => ({
                                key: `base:${row.key}`,
                                model: row,
                                version: null,
                            })),
                        )
                    }
                >
                    <Trash2 />
                    {single ? "Delete model" : "Delete model and every format"}
                </DropdownMenuItem>
            )}
        </>
    );
}

function ModelMenu({ model, on, can }: { model: ListModel; on: Handlers; can: Abilities }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    disabled={busyTearingDown(model.row)}
                    aria-label={`More actions for ${model.name}`}
                >
                    <MoreHorizontal />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem onSelect={() => on.open(hrefOf(model))}>
                    <Eye />
                    View details
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => on.peek(model)}>
                    <PanelRight />
                    Quick look
                </DropdownMenuItem>
                {can.build && model.kind === "custom" && (
                    <CustomItems model={model} on={on} can={can} />
                )}
                {can.build && model.kind === "base" && (
                    <BaseItems model={model} on={on} can={can} />
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function primaryOf(model: ListModel, on: Handlers, can: Abilities) {
    const row = model.row;
    const teardown = row.teardown;
    if (teardown) {
        const manages = can.admin || row.kind === "custom";
        return teardown.state === "failed" && can.build && (manages || teardown.kind === "undeploy")
            ? {
                  label: needsReview(teardown) ? REVIEW_LABEL : RETRY_LABELS[teardown.kind],
                  icon: <RotateCcw aria-hidden="true" />,
                  run: () => on.retryTeardown(row),
              }
            : null;
    }
    const fix = row.health?.actions[0];
    if (fix) {
        const manages = can.admin || (can.build && row.kind === "custom");
        return manages
            ? {
                  label: fix.label,
                  icon: <Wrench aria-hidden="true" />,
                  run: () => on.health(row, fix),
              }
            : null;
    }
    if (deployed(model)) {
        return {
            label: "Connect",
            icon: <Plug aria-hidden="true" />,
            run: () => on.open(modelPageHref(row.key, "api")),
        };
    }
    const runnable =
        model.kind === "custom" ? row.can_test : row.availability.state === "available";
    return runnable
        ? {
              label: "Try",
              icon: <Play aria-hidden="true" />,
              run: () => on.open(playgroundHref(row.key)),
          }
        : null;
}

function ModelActions({ model, on, can }: { model: ListModel; on: Handlers; can: Abilities }) {
    const primary = primaryOf(model, on, can);
    return (
        <div className="relative z-10 flex items-center justify-end gap-1">
            {primary && (
                <Button variant="secondary" onClick={primary.run}>
                    {primary.icon}
                    {primary.label}
                </Button>
            )}
            <ModelMenu model={model} on={on} can={can} />
        </div>
    );
}

function baseFacts(model: ListModel): string {
    if (model.variants.length === 1) {
        const row = model.row;
        const size = row.size_bytes ? bytes(row.size_bytes) : null;
        return (
            [row.variant_label, size, row.serve_only ? "Serve-only" : null]
                .filter(Boolean)
                .join(" · ") || "Base model"
        );
    }
    const live = model.variants.filter(isDeployed).length;
    return `${plural(model.variants.length, "variant")} · ${live} deployed`;
}

export function ModelLine({
    model,
    expanded,
    onToggle,
    on,
    ...props
}: RowProps & {
    model: ListModel;
    expanded: boolean;
    onToggle: () => void;
    on: Handlers;
}) {
    const children = props.nested ? childCount(model) : 0;
    const usage = usageOf(model);
    const live = deployed(model);
    const cost = costOf(model);
    const deleting =
        model.row.teardown?.kind === "delete" && model.row.teardown.state === "running";
    return (
        <li
            {...rowEvents(props, false)}
            aria-expanded={children > 0 ? expanded : undefined}
            aria-label={model.name}
            className={cn(ROW_GRID, ROW_STATE, "gap-y-1 py-3", deleting && "opacity-60")}
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
                    <Link
                        href={hrefOf(model)}
                        tabIndex={-1}
                        className="truncate font-semibold text-foreground hover:underline"
                    >
                        {model.name}
                    </Link>
                    <span className="truncate text-sm text-muted-foreground tabular-nums">
                        {model.kind === "custom" ? `On ${model.baseName}` : baseFacts(model)}
                    </span>
                </div>
            </div>
            <Cells
                columns={props.columns}
                cells={{
                    quality: <QualityCell model={model} on={on} />,
                    requests: (
                        <div className="relative z-10">
                            <Requests usage={usage} live={live} />
                        </div>
                    ),
                    cost: cost ? (
                        <span className="whitespace-nowrap tabular-nums">{costText(cost)}</span>
                    ) : (
                        <Muted />
                    ),
                    p95: live ? <Milliseconds value={usage?.p95_ms} /> : <Muted />,
                }}
            />
            <div className="min-w-0">
                <ModelStatus model={model} on={on} can={props.can} />
            </div>
            <ModelActions model={model} on={on} can={props.can} />
        </li>
    );
}

function ChildBox({
    label,
    selected,
    selectable,
    onSelect,
}: {
    label: string;
    selected: boolean;
    selectable: boolean;
    onSelect: (on: boolean) => void;
}) {
    return (
        <>
            <span aria-hidden="true" className="size-6 shrink-0" />
            {selectable ? (
                <label className="relative z-10 -my-2 flex w-8 shrink-0 cursor-pointer items-center justify-center self-stretch">
                    <Checkbox
                        tabIndex={-1}
                        aria-label={label}
                        checked={selected}
                        onCheckedChange={(value) => onSelect(value === true)}
                    />
                </label>
            ) : (
                <span aria-hidden="true" className="w-8 shrink-0" />
            )}
        </>
    );
}

function LiveDot({ live }: { live: boolean }) {
    return (
        <span
            aria-hidden="true"
            className={cn("size-1.5 shrink-0 rounded-full", live ? "bg-success" : "bg-transparent")}
        />
    );
}

function VersionMenu({
    model,
    version,
    on,
    can,
}: {
    model: ListModel;
    version: ModelVersionRow;
    on: Handlers;
    can: Abilities;
}) {
    const live = liveOf(model);
    const versus =
        live && !version.live && live.score != null && version.score != null ? live : undefined;
    const ready = version.status === "ready";
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
            <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem onSelect={() => on.open(modelPageHref(model.key, "versions"))}>
                    <Eye />
                    {`Open v${version.number}`}
                </DropdownMenuItem>
                {versus && (
                    <DropdownMenuItem
                        onSelect={() => on.compare(model, [versus.number, version.number])}
                    >
                        <GitCompare />
                        {`Compare with live v${versus.number}`}
                    </DropdownMenuItem>
                )}
                {ready && (
                    <DropdownMenuItem
                        onSelect={() => on.open(playgroundHref(`${model.key}@${version.number}`))}
                    >
                        <Play />
                        {`Try ${model.key}@${version.number}`}
                    </DropdownMenuItem>
                )}
                {ready && (
                    <DropdownMenuItem
                        onSelect={() => on.open(modelCardHref(model.key, version.number))}
                    >
                        <FileText />
                        Model card
                    </DropdownMenuItem>
                )}
                {can.build && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            variant="destructive"
                            disabled={version.live || version.status === "deleting"}
                            onSelect={() =>
                                on.remove([
                                    {
                                        key: `custom:${model.key}@${version.number}`,
                                        model: model.row,
                                        version,
                                    },
                                ])
                            }
                        >
                            <Trash2 />
                            {version.live
                                ? `v${version.number} is live`
                                : `Delete v${version.number}`}
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function VersionLine({
    model,
    version,
    on,
    ...props
}: RowProps & { model: ListModel; version: ModelVersionRow; on: Handlers }) {
    const replicas = replicasOf(model);
    const older = (liveOf(model)?.number ?? -1) > version.number;
    return (
        <li
            {...rowEvents(props, true)}
            aria-label={`${model.name} v${version.number}`}
            className={cn(
                ROW_GRID,
                ROW_STATE,
                "py-1.5",
                version.status === "deleting" && "opacity-60",
            )}
        >
            <div className="flex min-w-0 items-center gap-2 self-stretch">
                <ChildBox
                    label={`Select ${model.name} v${version.number}`}
                    selected={props.selected}
                    selectable={props.selectable}
                    onSelect={props.onSelect}
                />
                <span className="ml-1 flex min-w-0 items-center gap-2">
                    <LiveDot live={version.live} />
                    <Link
                        href={modelPageHref(model.key, "versions")}
                        tabIndex={-1}
                        className="shrink-0 whitespace-nowrap font-medium text-foreground tabular-nums hover:underline"
                    >
                        <VersionName version={version} />
                    </Link>
                    <span className="truncate text-sm text-muted-foreground">
                        {relativeTime(version.created_at)}
                    </span>
                </span>
            </div>
            <Cells
                columns={props.columns}
                cells={{
                    quality:
                        version.score == null ? (
                            <Muted />
                        ) : (
                            <span className="flex items-center gap-2 tabular-nums">
                                <span>{pct(version.score)}</span>
                                <ScoreBadge model={model} version={version} />
                            </span>
                        ),
                    requests: version.usage ? (
                        <div className="relative z-10">
                            <Requests usage={version.usage} live={version.live} />
                        </div>
                    ) : null,
                    cost: version.cost ? (
                        <span className="whitespace-nowrap tabular-nums">
                            {costText(version.cost)}
                        </span>
                    ) : null,
                    p95: version.live ? <Milliseconds value={version.usage?.p95_ms} /> : null,
                }}
            />
            <div className="min-w-0">
                <VersionStatus version={version} replicas={replicas} />
            </div>
            <div className="relative z-10 flex items-center justify-end gap-1">
                {props.can.build && canMakeLive(model, version) && (
                    <Button
                        variant={
                            older || version.promotion?.passed === false ? "outline" : "secondary"
                        }
                        onClick={() => on.makeLive(model, version)}
                    >
                        {`Make v${version.number} live`}
                    </Button>
                )}
                <VersionMenu model={model} version={version} on={on} can={props.can} />
            </div>
        </li>
    );
}

function VariantStatus({ row }: { row: ModelRow }) {
    const line = variantLine(row);
    return (
        <span className="flex min-w-0 flex-col items-start">
            {line.kind === "on" ? (
                <LiveStatus replicas={row.replicas ?? []} />
            ) : (
                <StatusLineText line={line} name={row.name} replicas={row.replicas ?? []} />
            )}
            {row.update_available && (
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
                        A newer revision of these weights is in the catalogue. Discover downloads
                        it.
                    </TooltipContent>
                </Tooltip>
            )}
        </span>
    );
}

export function VariantLine({
    model,
    row,
    on,
    ...props
}: RowProps & { model: ListModel; row: ModelRow; on: Handlers }) {
    const label = row.variant_label ?? row.name;
    const live = isDeployed(row);
    const ready = row.availability.state === "available" && !row.health && !row.teardown;
    return (
        <li
            {...rowEvents(props, true)}
            aria-label={`${model.name} ${label}`}
            className={cn(ROW_GRID, ROW_STATE, "py-1.5")}
        >
            <div className="flex min-w-0 items-center gap-2 self-stretch">
                <ChildBox
                    label={`Select ${model.name} ${label}`}
                    selected={props.selected}
                    selectable={props.selectable}
                    onSelect={props.onSelect}
                />
                <span className="ml-1 flex min-w-0 items-center gap-2">
                    <LiveDot live={live} />
                    <span className="flex min-w-0 flex-col">
                        <span className="flex items-baseline gap-2 whitespace-nowrap">
                            <span className="font-medium">{label}</span>
                            <span className="text-sm text-muted-foreground tabular-nums">
                                {[
                                    row.size_bytes ? bytes(row.size_bytes) : null,
                                    row.serve_only ? "Serve-only" : "Trainable",
                                ]
                                    .filter(Boolean)
                                    .join(" · ")}
                            </span>
                        </span>
                        <span className="truncate font-mono text-sm text-muted-foreground">
                            {row.key}
                        </span>
                    </span>
                </span>
            </div>
            <Cells
                columns={props.columns}
                cells={{
                    requests: row.usage ? (
                        <div className="relative z-10">
                            <Requests usage={row.usage} live={live} />
                        </div>
                    ) : null,
                    p95: live ? <Milliseconds value={row.usage?.p95_ms} /> : null,
                }}
            />
            <div className="min-w-0">
                <VariantStatus row={row} />
            </div>
            <div className="relative z-10 flex items-center justify-end gap-1">
                {props.can.build && live && (
                    <Button variant="outline" onClick={() => on.undeploy([row])}>
                        Undeploy
                    </Button>
                )}
                {props.can.build && !live && ready && (
                    <Button variant="secondary" onClick={() => on.deploy([row])}>
                        Deploy
                    </Button>
                )}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`More actions for ${model.name} ${label}`}
                        >
                            <MoreHorizontal />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
                        <DropdownMenuItem onSelect={() => on.open(modelPageHref(row.key))}>
                            <Eye />
                            {`Open ${label}`}
                        </DropdownMenuItem>
                        {row.availability.state === "available" && (
                            <DropdownMenuItem onSelect={() => on.open(playgroundHref(row.key))}>
                                <Play />
                                {`Try ${label}`}
                            </DropdownMenuItem>
                        )}
                        {props.can.admin && (
                            <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                    variant="destructive"
                                    disabled={live}
                                    onSelect={() =>
                                        on.remove([
                                            { key: `base:${row.key}`, model: row, version: null },
                                        ])
                                    }
                                >
                                    <Trash2 />
                                    {live ? `${label} is live` : "Delete files"}
                                </DropdownMenuItem>
                            </>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </li>
    );
}

export function MoreLine({
    model,
    shown,
    searching,
}: {
    model: ListModel;
    shown: number;
    searching: boolean;
}) {
    const total = model.versions.length;
    return (
        <li className="col-span-full flex items-center gap-3 py-1.5 pr-4 pl-[5.75rem] text-sm">
            <span className="text-muted-foreground tabular-nums">
                {searching
                    ? `${shown} of ${plural(total, "version")} match`
                    : `Showing ${shown} of ${total}`}
            </span>
            <Link
                href={modelPageHref(model.key, "versions")}
                className="text-primary hover:underline"
            >
                {`All ${total} versions →`}
            </Link>
        </li>
    );
}
