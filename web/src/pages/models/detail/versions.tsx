import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
    GitCompare,
    History,
    Logs,
    MoreHorizontal,
    Repeat,
    Rocket,
    RotateCcw,
    Trash2,
    X,
} from "lucide-react";
import {
    Badge,
    Button,
    Checkbox,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    Link,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    useToast,
} from "obp-ui";
import { useState } from "react";
import {
    type JobInfo,
    type ModelDetail,
    type ModelRow,
    type VersionInfo,
    api,
    unwrap,
} from "~/api/client";
import { useJobs } from "~/api/queries";
import { PanelSection, PanelSections } from "~/components/Section";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import { useCan } from "~/lib/access";
import { percent } from "~/lib/format";
import { durationText, jobSeconds } from "~/lib/jobs";
import { metricName } from "~/lib/metrics";
import { jobHref, modelCompareHref, modelVersionHref, trainHref } from "~/lib/modelLinks";
import { relativeTime } from "~/lib/time";
import { ConfirmAction, type Confirmation } from "../dialogs";
import { Tip, isDeployed } from "./header";
import {
    DeployVersionDialog,
    canGoLive,
    isBaseline,
    liveBlock,
    liveOf,
    points,
    ruleReason,
    versionLabel,
} from "./makeLive";
import { ScoredBy } from "./scoredBy";
import { labelOf, startFrom } from "./train/recipe";

export function versionStatus(row: ModelRow, version: VersionInfo): { tone: Tone; label: string } {
    if (version.current && isDeployed(row)) {
        return { tone: "success", label: "Deployed" };
    }
    if (version.status === "training") {
        const progress = version.job?.progress ?? 0;
        return { tone: "info", label: `Training ${Math.round(progress * 100)}%` };
    }
    if (version.status === "evaluating") {
        return { tone: "info", label: "Scoring" };
    }
    if (version.status === "queued") {
        return { tone: "neutral", label: "Queued" };
    }
    if (version.status === "failed") {
        return { tone: "destructive", label: "Failed" };
    }
    if (version.status === "deleting") {
        return { tone: "neutral", label: "Deleting" };
    }
    if (version.live_at) {
        return { tone: "neutral", label: "Was deployed" };
    }
    return { tone: "neutral", label: "Ready" };
}

export function VersionStatus({ row, version }: { row: ModelRow; version: VersionInfo }) {
    const status = versionStatus(row, version);
    const text = (
        <StatusText tone={status.tone}>
            <span className="tabular-nums">{status.label}</span>
        </StatusText>
    );
    const error = version.status === "failed" ? version.job?.error : null;
    return error ? <Tip tip={error}>{text}</Tip> : text;
}

function RunStatus({ row, version }: { row: ModelRow; version: VersionInfo }) {
    const job = version.job;
    if (version.status === "training" && job?.status === "queued") {
        return <StatusText tone="neutral">Queued</StatusText>;
    }
    if (version.status === "training") {
        return (
            <span className="flex items-center gap-2">
                <VersionStatus row={row} version={version} />
                <ProgressBar
                    value={job?.progress ?? 0}
                    label={`v${version.number} training`}
                    className="w-16"
                />
            </span>
        );
    }
    if (version.status === "failed" && job) {
        return (
            <Tip tip={job.error ?? "No reason was recorded."}>
                <Link href={jobHref(job)} className="hover:underline">
                    <StatusText tone="destructive">{`Failed · job #${job.id}`}</StatusText>
                </Link>
            </Tip>
        );
    }
    return <VersionStatus row={row} version={version} />;
}

const PRESET_SETTINGS = new Set(["rank", "epochs", "learning_rate", "max_rows", "seed"]);

export function trainingText(version: VersionInfo): string {
    if (version.kind === "prompt") {
        return "Instructions";
    }
    const recipe = version.recipe as Record<string, unknown>;
    const overrides = Array.isArray(recipe.overrides) ? (recipe.overrides as string[]) : [];
    if (overrides.length === 0) {
        return "Default";
    }
    const start = startFrom(recipe);
    if (start.custom || overrides.some((name) => !PRESET_SETTINGS.has(name))) {
        return "Custom";
    }
    return labelOf(start.basis);
}

export function recipeText(version: VersionInfo): string {
    const data =
        version.dataset_version_number !== null && version.dataset_version_number !== undefined
            ? `data v${version.dataset_version_number}`
            : "no data";
    if (version.kind === "prompt") {
        return `Instructions only · ${data}`;
    }
    const recipe = version.recipe as { strategy?: string; rank?: number };
    const adapter = recipe.strategy === "qlora" ? "QLoRA" : "LoRA";
    return `SFT · ${adapter}${recipe.rank ? ` r${recipe.rank}` : ""} · ${data}`;
}

export function runJob(version: VersionInfo, jobs: JobInfo[]): JobInfo | undefined {
    const own = jobs.filter((job) => job.version === version.number);
    const wanted = version.kind === "lora" ? "train" : "eval";
    return (
        own.find((job) => job.kind === wanted) ??
        own.find((job) => job.kind === "eval") ??
        version.job ??
        undefined
    );
}

export function ScoreBadge({
    row,
    version,
    versions,
}: { row: ModelRow; version: VersionInfo; versions: VersionInfo[] }) {
    if (isBaseline(version) || version.status !== "ready" || version.score === null) {
        return null;
    }
    const live = isDeployed(row) ? liveOf(versions) : undefined;
    if (live?.number === version.number) {
        return null;
    }
    if (version.promotion && !version.promotion.passed && !version.live_at) {
        return (
            <Tooltip>
                <TooltipTrigger asChild>
                    <Badge variant="neutral" tabIndex={0}>
                        below rule
                    </Badge>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs whitespace-normal">
                    {ruleReason(version)}
                </TooltipContent>
            </Tooltip>
        );
    }
    if (live && live.score !== null && version.score > live.score) {
        return (
            <Badge variant="success">{`beats live ${points(version.score - live.score)}`}</Badge>
        );
    }
    return null;
}

function newestFirst(versions: VersionInfo[]): VersionInfo[] {
    return [...versions].sort((a, b) => b.number - a.number);
}

function retry(jobId: number) {
    return unwrap(api.POST("/api/jobs/{job_id}/retry", { params: { path: { job_id: jobId } } }));
}

function busy(version: VersionInfo): boolean {
    return version.status === "training" || version.status === "evaluating";
}

function durationOf(job: JobInfo | undefined): string {
    const seconds = job ? jobSeconds(job) : -1;
    return seconds < 0 ? "–" : durationText(seconds);
}

function RowMenu({
    row,
    version,
    versions,
    job,
    onDelete,
}: {
    row: ModelRow;
    version: VersionInfo;
    versions: VersionInfo[];
    job: JobInfo | undefined;
    onDelete: () => void;
}) {
    const can = useCan();
    const router = useRouter();
    const others = versions
        .filter(
            (item) =>
                item.number !== version.number && item.status === "ready" && item.score !== null,
        )
        .sort((a, b) => b.number - a.number);
    const comparable = version.status === "ready" && version.score !== null && others.length > 0;
    const isLive = isDeployed(row) && row.current_version === version.number;
    const baseline = version.number === 0;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`More actions for v${version.number}`}
                >
                    <MoreHorizontal />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={!comparable}>
                        <GitCompare />
                        Compare with…
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-48">
                        {others.map((item) => (
                            <DropdownMenuItem
                                key={item.number}
                                onSelect={() =>
                                    router.history.push(
                                        modelCompareHref(
                                            row.key,
                                            Math.min(item.number, version.number),
                                            Math.max(item.number, version.number),
                                        ),
                                    )
                                }
                            >
                                {versionLabel(item)}
                                {item.current && isDeployed(row) && (
                                    <span className="ml-auto text-sm text-muted-foreground">
                                        Deployed
                                    </span>
                                )}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
                {can.build && version.kind === "lora" && (
                    <DropdownMenuItem
                        disabled={busy(version)}
                        onSelect={() =>
                            router.history.push(trainHref(row.key, { from: version.number }))
                        }
                    >
                        <Repeat />
                        Train again
                    </DropdownMenuItem>
                )}
                <DropdownMenuItem
                    disabled={!job}
                    onSelect={() => job && router.history.push(jobHref(job))}
                >
                    <Logs />
                    {job ? `Logs · job #${job.id}` : "Logs"}
                </DropdownMenuItem>
                {can.build && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            variant="destructive"
                            disabled={isLive || baseline}
                            onSelect={onDelete}
                        >
                            <Trash2 />
                            {baseline
                                ? "Delete (v0 is the baseline)"
                                : isLive
                                  ? "Delete (deployed)"
                                  : "Delete"}
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function VersionRow({
    row,
    version,
    versions,
    job,
    picked,
    onPick,
    onLive,
    onDelete,
    newest,
}: {
    row: ModelRow;
    version: VersionInfo;
    versions: VersionInfo[];
    job: JobInfo | undefined;
    picked: boolean;
    onPick: (on: boolean) => void;
    onLive: () => void;
    onDelete: () => void;
    newest: boolean;
}) {
    const can = useCan();
    const router = useRouter();
    const client = useQueryClient();
    const toast = useToast();
    const again = useMutation({
        mutationFn: retry,
        onSuccess: async (started) => {
            await client.invalidateQueries();
            router.history.push(jobHref(started));
        },
        onError: async (error) => {
            toast({ title: "Retry failed", description: error.message, tone: "destructive" });
            await client.invalidateQueries();
        },
    });
    const failedJob = version.status === "failed" ? version.job : null;
    const live = canGoLive(row, version);
    const blocked = live ? liveBlock(row, version) : null;
    const data = version.dataset_version_number;
    return (
        <TableRow data-state={picked ? "selected" : undefined}>
            <TableCell className="w-10 pl-4">
                <Checkbox
                    aria-label={`Select v${version.number}`}
                    checked={picked}
                    onCheckedChange={(value) => onPick(value === true)}
                />
            </TableCell>
            <TableCell className="whitespace-nowrap">
                <Link
                    href={modelVersionHref(row.key, version.number)}
                    className="font-medium tabular-nums hover:underline"
                >
                    {versionLabel(version)}
                </Link>
                {isBaseline(version) && (
                    <span className="ml-2 text-sm text-muted-foreground">untrained</span>
                )}
            </TableCell>
            <TableCell>
                <RunStatus row={row} version={version} />
            </TableCell>
            <TableCell className="text-right">
                <span className="inline-flex items-center justify-end gap-2 tabular-nums">
                    <ScoreBadge row={row} version={version} versions={versions} />
                    {version.score === null ? "–" : percent(version.score)}
                </span>
            </TableCell>
            <TableCell className="tabular-nums">
                {data === null || data === undefined ? (
                    <span className="text-muted-foreground">–</span>
                ) : (
                    `v${data}`
                )}
            </TableCell>
            <TableCell className="whitespace-nowrap">{trainingText(version)}</TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                {relativeTime(job?.started_at ?? version.created_at)}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap tabular-nums">
                {durationOf(job)}
            </TableCell>
            <TableCell className="pr-4 text-right">
                <span className="inline-flex items-center gap-1">
                    {can.build && failedJob && newest && (
                        <Button
                            variant="outline"
                            disabled={again.isPending}
                            onClick={() => again.mutate(failedJob.id)}
                        >
                            <RotateCcw aria-hidden="true" />
                            Retry
                        </Button>
                    )}
                    {can.build && live && !blocked && (
                        <Button variant="outline" onClick={onLive}>
                            <Rocket aria-hidden="true" />
                            {`Deploy v${version.number}`}
                        </Button>
                    )}
                    <RowMenu
                        row={row}
                        version={version}
                        versions={versions}
                        job={job}
                        onDelete={onDelete}
                    />
                </span>
            </TableCell>
        </TableRow>
    );
}

function deleteVersions(row: ModelRow, numbers: number[]) {
    return Promise.all(
        numbers.map((number) =>
            unwrap(
                api.DELETE("/api/models/{name}/versions/{number}", {
                    params: { path: { name: row.key, number }, query: { cancel_jobs: true } },
                }),
            ),
        ),
    );
}

function VersionsTable({ row, versions }: { row: ModelRow; versions: VersionInfo[] }) {
    const router = useRouter();
    const toast = useToast();
    const client = useQueryClient();
    const can = useCan();
    const jobs = useJobs(row.key);
    const [picked, setPicked] = useState<number[]>([]);
    const [promoting, setPromoting] = useState<number | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const ordered = newestFirst(versions);
    const chosen = versions.filter((version) => picked.includes(version.number));
    const sorted = chosen
        .filter((version) => version.score !== null)
        .map((version) => version.number)
        .sort((a, b) => a - b);
    const liveNumber = isDeployed(row) ? row.current_version : null;
    const deletable = chosen.filter(
        (version) => version.number !== liveNumber && version.number !== 0,
    );
    const every = ordered.length > 0 && ordered.every((version) => picked.includes(version.number));
    const metric = metricName(versions.find((version) => version.main_metric)?.main_metric);
    const pick = (number: number, on: boolean) =>
        setPicked(
            on
                ? [...picked.filter((n) => n !== number), number]
                : picked.filter((n) => n !== number),
        );
    const keptText = (doomed: VersionInfo[]) => {
        const kept = chosen
            .filter((version) => !doomed.includes(version))
            .map((version) =>
                version.number === 0 ? "Baseline v0" : `Deployed v${version.number}`,
            );
        return kept.length > 0
            ? ` ${kept.join(" and ")} ${kept.length === 1 ? "is" : "are"} kept.`
            : "";
    };
    const remove = (doomed: VersionInfo[], kept: boolean) =>
        setConfirmation({
            title:
                doomed.length === 1
                    ? `Delete ${versionLabel(doomed[0])} of ${row.name}?`
                    : `Delete ${doomed.length} versions of ${row.name}?`,
            description: (
                <p>
                    {`${doomed.map((version) => `${row.key}@${version.number}`).join(", ")} ${doomed.length === 1 ? "stops" : "stop"} answering; adapters, scores and cards are removed, and their running jobs are cancelled.`}
                    {kept && keptText(doomed)}
                </p>
            ),
            confirmLabel: doomed.length === 1 ? "Delete version" : "Delete versions",
            destructive: true,
            run: async () => {
                const numbers = doomed.map((version) => version.number);
                await deleteVersions(row, numbers);
                await client.invalidateQueries();
                setPicked(picked.filter((number) => !numbers.includes(number)));
                toast({
                    title: `Deleted ${doomed.length} ${doomed.length === 1 ? "version" : "versions"}`,
                    tone: "success",
                });
            },
        });
    return (
        <PanelSection
            icon={History}
            title="Versions"
            actions={
                picked.length > 0 && (
                    <>
                        <Button variant="outline" onClick={() => setPicked([])}>
                            <X aria-hidden="true" />
                            Clear
                        </Button>
                        <Tip
                            tip={
                                sorted.length === 2
                                    ? null
                                    : "Tick two scored versions to compare them."
                            }
                        >
                            <Button
                                variant="outline"
                                disabled={sorted.length !== 2}
                                onClick={() =>
                                    router.history.push(
                                        modelCompareHref(row.key, sorted[0], sorted[1]),
                                    )
                                }
                            >
                                <GitCompare aria-hidden="true" />
                                {sorted.length === 2
                                    ? `Compare v${sorted[0]} and v${sorted[1]}`
                                    : "Compare"}
                            </Button>
                        </Tip>
                        {can.build && (
                            <Tip
                                tip={
                                    deletable.length === 0
                                        ? "v0 and the deployed version cannot be deleted."
                                        : null
                                }
                            >
                                <Button
                                    variant="destructive"
                                    disabled={deletable.length === 0}
                                    onClick={() =>
                                        remove(deletable, chosen.length > deletable.length)
                                    }
                                >
                                    <Trash2 aria-hidden="true" />
                                    {deletable.length > 0 ? `Delete ${deletable.length}` : "Delete"}
                                </Button>
                            </Tip>
                        )}
                    </>
                )
            }
            flush
        >
            {versions.length === 0 ? (
                <p className="p-panel text-muted-foreground">No versions yet.</p>
            ) : (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-10 pl-4">
                                <Checkbox
                                    aria-label="Select every version"
                                    checked={every}
                                    onCheckedChange={(value) =>
                                        setPicked(
                                            value === true
                                                ? ordered.map((version) => version.number)
                                                : [],
                                        )
                                    }
                                />
                            </TableHead>
                            <TableHead>Version</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">{metric}</TableHead>
                            <TableHead>Data</TableHead>
                            <TableHead>Training</TableHead>
                            <TableHead>Started</TableHead>
                            <TableHead className="text-right">Duration</TableHead>
                            <TableHead className="pr-4">
                                <span className="sr-only">Actions</span>
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {ordered.map((version, index) => (
                            <VersionRow
                                key={version.number}
                                row={row}
                                version={version}
                                versions={versions}
                                job={runJob(version, jobs.data ?? [])}
                                picked={picked.includes(version.number)}
                                onPick={(on) => pick(version.number, on)}
                                onLive={() => setPromoting(version.number)}
                                onDelete={() => remove([version], false)}
                                newest={index === 0}
                            />
                        ))}
                    </TableBody>
                </Table>
            )}
            <DeployVersionDialog
                row={row}
                versions={versions}
                number={promoting}
                onOpenChange={(open) => !open && setPromoting(null)}
            />
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
        </PanelSection>
    );
}

export function VersionsTab({
    row,
    detail,
    versions,
}: {
    row: ModelRow;
    detail: ModelDetail | undefined;
    versions: VersionInfo[];
}) {
    return (
        <>
            <ScoredBy detail={detail} />
            <PanelSections>
                <VersionsTable row={row} versions={versions} />
            </PanelSections>
        </>
    );
}
