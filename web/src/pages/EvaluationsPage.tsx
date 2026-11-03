import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
    Button,
    CheckboxSelect,
    DataGrid,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    InfoTip,
    Link,
} from "obp-ui";
import { useMemo } from "react";
import { type ModelRow, type ModelVersionRow, type VersionInfo, api, unwrap } from "~/api/client";
import { useModels, useVersions } from "~/api/queries";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, Stat } from "~/components/Section";
import {
    VERSION_STATES,
    VersionState,
    versionState,
    versionStateLabel,
} from "~/components/StatusBadge";
import { costSortValue, costText, deviceTime, headline, measuredOn, priced } from "~/lib/cost";
import { count, milliseconds, percent } from "~/lib/format";
import { listHref, splitList, useListSearch } from "~/lib/listSearch";
import { modelCardHref } from "~/lib/modelLinks";
import { relativeTime } from "~/lib/time";
import { DataVersus } from "./data/versionData";
import { Updated } from "./models/MyModels";

const PATH = "/evaluations";
const KEYS = ["model", "status", "version"] as const;

const KIND_NAMES: Record<string, string> = { lora: "Trained", prompt: "Prompt-only" };

type Line = { model: ModelRow; version: ModelVersionRow; live: ModelVersionRow | undefined };

type Target = { slug: string; number: number };

function linesOf(rows: ModelRow[]): Line[] {
    return rows
        .filter((row) => row.kind === "custom")
        .flatMap((model) => {
            const versions = model.versions ?? [];
            const live = versions.find((version) => version.live);
            return versions.map((version) => ({ model, version, live }));
        });
}

function lineKey(line: Line): string {
    return `${line.model.key}@${line.version.number}`;
}

function readTarget(value: string | undefined): Target | null {
    const at = value?.lastIndexOf("@") ?? -1;
    const number = Number(value?.slice(at + 1));
    return value && at > 0 && Number.isInteger(number)
        ? { slug: value.slice(0, at), number }
        : null;
}

function change(line: Line): number | null {
    const { version, live } = line;
    if (!live || live === version || version.accuracy === null || live.accuracy === null) {
        return null;
    }
    return version.accuracy - live.accuracy;
}

function Change({ line }: { line: Line }) {
    const delta = change(line);
    if (delta === null) {
        return <span className="text-muted-foreground">–</span>;
    }
    const points = Math.abs(delta * 100).toFixed(1);
    if (points === "0.0") {
        return <span className="tabular-nums text-muted-foreground">Same</span>;
    }
    return delta > 0 ? (
        <span className="tabular-nums text-success">{`+${points} pts`}</span>
    ) : (
        <span className="tabular-nums text-destructive">{`−${points} pts`}</span>
    );
}

const COST_INFO =
    "Measured GPU time per 1,000 held-out requests, times the pool's price per hour from Settings. Without a price, the GPU time itself.";

function baselineOf(line: Line): ModelVersionRow | undefined {
    const earlier = (line.model.versions ?? []).filter(
        (version) =>
            version.number < line.version.number &&
            version.status === "ready" &&
            version.accuracy !== null,
    );
    const prompts = earlier
        .filter((version) => version.kind === "prompt")
        .sort((a, b) => a.number - b.number);
    return earlier.find((version) => version.number === 0) ?? prompts[0];
}

function lineHeadline(line: Line): string | null {
    const base = baselineOf(line);
    return base ? headline(base, line.version) : null;
}

function versionColumns(href: (line: Line) => string): ColumnDef<Line, unknown>[] {
    return [
        {
            id: "model",
            header: "Model",
            enableHiding: false,
            accessorFn: (line) => line.model.name.toLowerCase(),
            cell: ({ row }) => (
                <Link
                    href={href(row.original)}
                    className="block truncate font-semibold text-foreground"
                >
                    {row.original.model.name}
                </Link>
            ),
        },
        {
            id: "version",
            header: "Version",
            accessorFn: (line) => line.version.number,
            cell: ({ row }) => (
                <span className="tabular-nums">{`v${row.original.version.number}`}</span>
            ),
        },
        {
            id: "kind",
            header: "Kind",
            accessorFn: (line) => KIND_NAMES[line.version.kind] ?? line.version.kind,
        },
        {
            id: "accuracy",
            header: "Held-out accuracy",
            accessorFn: (line) => line.version.accuracy ?? -1,
            cell: ({ row }) => (
                <span className="tabular-nums">{percent(row.original.version.accuracy)}</span>
            ),
        },
        {
            id: "change",
            header: "vs live",
            accessorFn: (line) => change(line) ?? Number.NEGATIVE_INFINITY,
            cell: ({ row }) => <Change line={row.original} />,
        },
        {
            id: "p50",
            header: "p50",
            accessorFn: (line) => line.version.latency_p50_ms ?? Number.POSITIVE_INFINITY,
            cell: ({ row }) => (
                <span className="tabular-nums">
                    {milliseconds(row.original.version.latency_p50_ms)}
                </span>
            ),
        },
        {
            id: "p95",
            header: "p95",
            accessorFn: (line) => line.version.latency_p95_ms ?? Number.POSITIVE_INFINITY,
            cell: ({ row }) => (
                <span className="tabular-nums">
                    {milliseconds(row.original.version.latency_p95_ms)}
                </span>
            ),
        },
        {
            id: "cost",
            header: "Cost per 1,000",
            meta: { info: COST_INFO },
            accessorFn: (line) => costSortValue(line.version.cost),
            cell: ({ row }) => (
                <span className="tabular-nums">{costText(row.original.version.cost)}</span>
            ),
        },
        {
            id: "created",
            header: "Created",
            accessorFn: (line) => line.version.created_at,
            cell: ({ row }) => <Updated value={row.original.version.created_at} />,
        },
        {
            id: "status",
            header: "Status",
            accessorFn: (line) => versionState(line.version),
            cell: ({ row }) => <VersionState version={row.original.version} />,
        },
    ];
}

function deployable(version: ModelVersionRow): boolean {
    return version.status === "ready" && !version.live;
}

function usePromote() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (target: Target) =>
            unwrap(
                api.POST("/api/minibrains/{slug}/versions/{number}/promote", {
                    params: { path: target },
                }),
            ),
        onSuccess: () => client.invalidateQueries(),
    });
}

type Mistake = VersionInfo["mistakes"][number];

const MISTAKE_COLUMNS: ColumnDef<Mistake, unknown>[] = [
    {
        header: "Input",
        accessorKey: "input",
        cell: (info) => (
            <span className="line-clamp-2 min-w-56 whitespace-normal">
                {String(info.getValue())}
            </span>
        ),
    },
    {
        header: "Expected",
        accessorKey: "gold",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
    {
        header: "Got",
        accessorKey: "output",
        cell: (info) => (
            <span className="font-mono text-destructive">{String(info.getValue())}</span>
        ),
    },
];

function VersionDetail({ line, onDone }: { line: Line; onDone: () => void }) {
    const versions = useVersions(line.model.key);
    const promote = usePromote();
    const info = versions.data?.find((item) => item.number === line.version.number);
    const { model, version } = line;
    const kind = KIND_NAMES[version.kind] ?? version.kind;
    const summary = lineHeadline(line);
    const cost = info?.cost ?? version.cost;
    return (
        <>
            <DialogHeader>
                <DialogTitle>{`${model.name} v${version.number}`}</DialogTitle>
                <DialogDescription>{`${kind} · created ${relativeTime(version.created_at)}`}</DialogDescription>
            </DialogHeader>
            {summary && <p className="text-base font-semibold tabular-nums">{summary}</p>}
            <div className="flex flex-wrap gap-x-8 gap-y-4">
                <Stat label="Status" value={<VersionState version={version} />} />
                <Stat label="Held-out" value={percent(info?.held_out?.accuracy)} />
                <Stat label="vs live" value={<Change line={line} />} />
                <Stat
                    label="Data vs live"
                    value={
                        <DataVersus
                            versions={versions.data}
                            number={version.number}
                            against={line.live?.number}
                        />
                    }
                />
                <Stat label="Test set" value={percent(info?.golden?.accuracy)} />
                <Stat label="Macro F1" value={info?.held_out?.macro_f1.toFixed(3) ?? "–"} />
                <Stat label="Invalid" value={percent(info?.held_out?.invalid_rate)} />
                <Stat label="p50" value={milliseconds(info?.latency_p50_ms)} />
                <Stat label="p95" value={milliseconds(info?.latency_p95_ms)} />
                <Stat
                    label="GPU time per 1,000"
                    value={
                        <span className="inline-flex items-center gap-1">
                            {deviceTime(cost)}
                            <InfoTip label="How cost is measured">{COST_INFO}</InfoTip>
                        </span>
                    }
                />
                {priced(cost) && <Stat label="Cost per 1,000" value={costText(cost)} />}
                <Stat label="Prompt tokens" value={count(info?.prompt_tokens)} />
                <Stat label="Output tokens" value={count(cost?.completion_tokens)} />
            </div>
            {cost?.device_name && (
                <p className="text-sm text-muted-foreground">{measuredOn(cost)}</p>
            )}
            {info && info.mistakes.length > 0 && (
                <div className="flex min-w-0 flex-col gap-2">
                    <div>
                        <h3 className="text-base font-semibold">Mistakes</h3>
                        <p className="text-sm text-muted-foreground">
                            Up to 20 held-out rows it got wrong.
                        </p>
                    </div>
                    <DataGrid columns={MISTAKE_COLUMNS} rows={info.mistakes} maxHeight="280px" />
                </div>
            )}
            <ErrorLine error={versions.error ?? promote.error} />
            <DialogFooter>
                <Button variant="outline" asChild>
                    <Link href={`/models/custom/${encodeURIComponent(model.key)}`}>
                        Model details
                    </Link>
                </Button>
                <Button variant="outline" asChild>
                    <Link href={modelCardHref(model.key, version.number)}>Model card</Link>
                </Button>
                {deployable(version) && (
                    <Button
                        disabled={promote.isPending}
                        onClick={() =>
                            promote.mutate(
                                { slug: model.key, number: version.number },
                                { onSuccess: onDone },
                            )
                        }
                    >
                        {`Deploy v${version.number}`}
                    </Button>
                )}
            </DialogFooter>
        </>
    );
}

function VersionDialog({
    target,
    line,
    loading,
    onClose,
}: {
    target: Target | null;
    line: Line | undefined;
    loading: boolean;
    onClose: () => void;
}) {
    return (
        <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-3xl">
                {line ? (
                    <VersionDetail line={line} onDone={onClose} />
                ) : (
                    <DialogHeader>
                        <DialogTitle>
                            {target ? `${target.slug} v${target.number}` : ""}
                        </DialogTitle>
                        <DialogDescription>
                            {loading ? "Loading…" : "This version is not on this install."}
                        </DialogDescription>
                    </DialogHeader>
                )}
            </DialogContent>
        </Dialog>
    );
}

export function EvaluationsPage() {
    const { search, update } = useListSearch(PATH, KEYS);
    const models = useModels();
    const promote = usePromote();
    const all = useMemo(() => linesOf(models.data ?? []), [models.data]);
    const chosenModels = splitList(search.model);
    const statuses = splitList(search.status);
    const visible = all.filter(
        (line) =>
            (chosenModels.length === 0 || chosenModels.includes(line.model.key)) &&
            (statuses.length === 0 || statuses.includes(versionState(line.version))),
    );
    const filtering = chosenModels.length + statuses.length > 0;
    const target = readTarget(search.version);
    const opened = target
        ? all.find(
              (line) => line.model.key === target.slug && line.version.number === target.number,
          )
        : undefined;
    const columns = useMemo(
        () => versionColumns((line) => listHref(PATH, { ...search, version: lineKey(line) })),
        [search],
    );
    const modelOptions = (models.data ?? [])
        .filter((row) => row.kind === "custom")
        .map((row) => ({
            value: row.key,
            label: row.name,
            count: row.versions?.length ?? 0,
        }));
    const statusOptions = VERSION_STATES.map((state) => ({
        value: state,
        label: versionStateLabel(state),
        count: all.filter((line) => versionState(line.version) === state).length,
    }));
    const clear = () => update({ model: "", status: "" });
    return (
        <Page wide>
            <PageHeader
                title="Evaluations"
                caption="Every version of every model, scored on its test set and held-out rows. Deploy the best one."
            />
            <div className="flex flex-wrap items-center gap-2">
                <CheckboxSelect
                    label="Model"
                    allLabel="All models"
                    noun="models"
                    options={modelOptions}
                    value={chosenModels}
                    onValueChange={(next) => update({ model: next.join(",") })}
                />
                <CheckboxSelect
                    label="Status"
                    allLabel="All statuses"
                    noun="statuses"
                    options={statusOptions}
                    value={statuses}
                    onValueChange={(next) => update({ status: next.join(",") })}
                />
                {filtering && (
                    <Button variant="ghost" onClick={clear}>
                        Clear filters
                    </Button>
                )}
            </div>
            <ErrorLine error={models.error ?? promote.error} />
            <DataGrid
                columns={columns}
                rows={visible}
                loading={models.isLoading}
                getRowId={lineKey}
                initialSort={[{ id: "created", desc: true }]}
                storageKey="minibrain.evaluations.columns"
                columnPicker
                onOpen={(line) => update({ version: lineKey(line) })}
                rowLabel={(line) =>
                    `${line.model.name} v${line.version.number}, ${percent(line.version.accuracy)} held-out, ${versionStateLabel(versionState(line.version))}`
                }
                rowActions={(line) =>
                    deployable(line.version) ? (
                        <Button
                            variant="outline"
                            size="xs"
                            disabled={promote.isPending}
                            onClick={() =>
                                promote.mutate({
                                    slug: line.model.key,
                                    number: line.version.number,
                                })
                            }
                        >
                            {`Deploy v${line.version.number}`}
                        </Button>
                    ) : null
                }
                empty={
                    filtering ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="text-muted-foreground">
                                No versions match these filters.
                            </p>
                            <Button variant="outline" onClick={clear}>
                                Clear filters
                            </Button>
                        </div>
                    ) : (
                        <p className="text-muted-foreground">
                            No versions yet. Score or train one from{" "}
                            <Link href="/training" className="text-primary hover:underline">
                                Training
                            </Link>
                            .
                        </p>
                    )
                }
                minWidth="min-w-[1000px]"
            />
            <VersionDialog
                target={target}
                line={opened}
                loading={models.isLoading}
                onClose={() => update({ version: "" })}
            />
        </Page>
    );
}
