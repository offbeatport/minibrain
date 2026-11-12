import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Eye, GitCompare, History, Rocket, RotateCcw, Trash2, X } from "lucide-react";
import {
    Badge,
    Button,
    Checkbox,
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
import { type ModelRow, type VersionInfo, api, unwrap } from "~/api/client";
import { PanelSection, PanelSections } from "~/components/Section";
import { StatusText, type Tone } from "~/components/models/StatusText";
import { useCan } from "~/lib/access";
import { percent } from "~/lib/format";
import { metricName } from "~/lib/metrics";
import { jobHref, modelCompareHref, modelVersionHref } from "~/lib/modelLinks";
import { relativeTime } from "~/lib/time";
import { ConfirmAction, type Confirmation } from "../dialogs";
import { Tip, isDeployed } from "./header";
import {
    MakeLiveDialog,
    canGoLive,
    isBaseline,
    liveBlock,
    liveOf,
    points,
    ruleReason,
    versionLabel,
} from "./makeLive";

export function versionStatus(row: ModelRow, version: VersionInfo): { tone: Tone; label: string } {
    if (version.current && isDeployed(row)) {
        return { tone: "success", label: "Live" };
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
        return { tone: "neutral", label: "Was live" };
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

export function recipeText(version: VersionInfo): string {
    const data =
        version.dataset_version_number !== null && version.dataset_version_number !== undefined
            ? `data v${version.dataset_version_number}`
            : "no data";
    if (version.kind === "prompt") {
        return `Prompt only · ${data}`;
    }
    const recipe = version.recipe as { strategy?: string; rank?: number };
    const adapter = recipe.strategy === "qlora" ? "QLoRA" : "LoRA";
    return `SFT · ${adapter}${recipe.rank ? ` r${recipe.rank}` : ""} · ${data}`;
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

function VersionRow({
    row,
    version,
    versions,
    picked,
    onPick,
    onLive,
    newest,
}: {
    row: ModelRow;
    version: VersionInfo;
    versions: VersionInfo[];
    picked: boolean;
    onPick: (on: boolean) => void;
    onLive: () => void;
    newest: boolean;
}) {
    const can = useCan();
    const router = useRouter();
    const client = useQueryClient();
    const again = useMutation({
        mutationFn: retry,
        onSuccess: async (job) => {
            await client.invalidateQueries();
            router.history.push(jobHref(job));
        },
    });
    const jobId = version.job?.id;
    const live = canGoLive(row, version);
    const blocked = live ? liveBlock(row, version) : null;
    return (
        <TableRow data-state={picked ? "selected" : undefined}>
            <TableCell className="w-10 pl-4">
                <Checkbox
                    aria-label={`Select v${version.number}`}
                    checked={picked}
                    onCheckedChange={(value) => onPick(value === true)}
                />
            </TableCell>
            <TableCell>
                <span className="flex min-w-0 flex-col">
                    <Link
                        href={modelVersionHref(row.key, version.number)}
                        className="font-medium tabular-nums hover:underline"
                    >
                        {versionLabel(version)}
                    </Link>
                    <span className="truncate text-sm text-muted-foreground tabular-nums">
                        {recipeText(version)}
                    </span>
                </span>
            </TableCell>
            <TableCell>
                <VersionStatus row={row} version={version} />
            </TableCell>
            <TableCell className="text-right tabular-nums">
                {version.score === null ? "–" : percent(version.score)}
            </TableCell>
            <TableCell>
                <ScoreBadge row={row} version={version} versions={versions} />
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums">
                {relativeTime(version.created_at)}
            </TableCell>
            <TableCell className="pr-4 text-right">
                <span className="inline-flex items-center gap-2">
                    {(version.status === "training" || version.status === "evaluating") &&
                        jobId && (
                            <Button variant="outline" asChild>
                                <Link href={jobHref(version.job ?? { id: jobId, kind: "train" })}>
                                    <Eye aria-hidden="true" />
                                    Watch
                                </Link>
                            </Button>
                        )}
                    {can.build && version.status === "failed" && newest && jobId && (
                        <Button
                            variant="outline"
                            disabled={again.isPending}
                            onClick={() => again.mutate(jobId)}
                        >
                            <RotateCcw aria-hidden="true" />
                            Retry
                        </Button>
                    )}
                    {can.build && live && !blocked && (
                        <Button variant="outline" onClick={onLive}>
                            <Rocket aria-hidden="true" />
                            {`Make v${version.number} live`}
                        </Button>
                    )}
                </span>
            </TableCell>
        </TableRow>
    );
}

function deleteVersions(row: ModelRow, numbers: number[]) {
    return Promise.all(
        numbers.map((number) =>
            unwrap(
                api.DELETE("/api/models/{slug}/versions/{number}", {
                    params: { path: { slug: row.key, number }, query: { cancel_jobs: true } },
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
    const deletable = chosen.filter((version) => version.number !== liveNumber);
    const every = ordered.length > 0 && ordered.every((version) => picked.includes(version.number));
    const metric = metricName(versions.find((version) => version.main_metric)?.main_metric);
    const pick = (number: number, on: boolean) =>
        setPicked(
            on
                ? [...picked.filter((n) => n !== number), number]
                : picked.filter((n) => n !== number),
        );
    const remove = () =>
        setConfirmation({
            title:
                deletable.length === 1
                    ? `Delete v${deletable[0].number} of ${row.name}?`
                    : `Delete ${deletable.length} versions of ${row.name}?`,
            description: (
                <p>
                    {`${deletable.map((version) => `${row.key}@${version.number}`).join(", ")} stop answering; adapters, scores and cards are removed, and their running jobs are cancelled.`}
                    {chosen.length > deletable.length && ` Live v${liveNumber} is kept.`}
                </p>
            ),
            confirmLabel: deletable.length === 1 ? "Delete version" : "Delete versions",
            destructive: true,
            run: async () => {
                await deleteVersions(
                    row,
                    deletable.map((version) => version.number),
                );
                await client.invalidateQueries();
                setPicked([]);
                toast({
                    title: `Deleted ${deletable.length} ${deletable.length === 1 ? "version" : "versions"}`,
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
                                        ? "The live version cannot be deleted."
                                        : null
                                }
                            >
                                <Button
                                    variant="destructive"
                                    disabled={deletable.length === 0}
                                    onClick={remove}
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
                <p className="p-panel text-muted-foreground">
                    No versions yet. Add training data on the Training tab and v0 · Baseline is
                    scored at once.
                </p>
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
                            <TableHead>Against live</TableHead>
                            <TableHead>Created</TableHead>
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
                                picked={picked.includes(version.number)}
                                onPick={(on) => pick(version.number, on)}
                                onLive={() => setPromoting(version.number)}
                                newest={index === 0}
                            />
                        ))}
                    </TableBody>
                </Table>
            )}
            <MakeLiveDialog
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

export function VersionsTab({ row, versions }: { row: ModelRow; versions: VersionInfo[] }) {
    return (
        <PanelSections>
            <VersionsTable row={row} versions={versions} />
        </PanelSections>
    );
}
