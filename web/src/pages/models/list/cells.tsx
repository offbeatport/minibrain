import { Badge, Link, Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import type { ReactNode } from "react";
import type { ModelRow, ModelVersionRow } from "~/api/client";
import { PoolLink } from "~/components/PoolLink";
import { PublisherLogo } from "~/components/PublisherLogo";
import { HealthStatus } from "~/components/models/HealthStatus";
import { ProgressBar, StatusText } from "~/components/models/StatusText";
import { TeardownStatus } from "~/components/models/TeardownStatus";
import { jobHref } from "~/lib/modelLinks";
import {
    BASELINE_HINT,
    type CostShown,
    type ListModel,
    type Replica,
    type StatusLine,
    isBaseline,
    pct,
    points,
    scoreNote,
    versionState,
} from "./model";

export function Muted({ children = "—" }: { children?: ReactNode }) {
    return <span className="text-muted-foreground">{children}</span>;
}

export const ESTIMATE_HINT =
    "Measured when this version was scored; there were no requests in the last 7 days.";

export function CostCell({ shown }: { shown: CostShown }) {
    if (!shown) {
        return <Muted />;
    }
    const text = <span className="whitespace-nowrap tabular-nums">{shown.text}</span>;
    if (!shown.estimated) {
        return text;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="relative z-10 whitespace-nowrap text-muted-foreground tabular-nums">
                    {shown.text}
                </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{ESTIMATE_HINT}</TooltipContent>
        </Tooltip>
    );
}

export function ModelAvatar({ model, size = "md" }: { model: ListModel; size?: "md" | "lg" }) {
    return (
        <PublisherLogo
            publisher={model.kind === "base" ? model.row.publisher : null}
            name={model.name}
            size={size}
            custom={model.kind === "custom"}
            avatar={model.row.avatar}
        />
    );
}

export function Tip({ tip, children }: { tip: ReactNode; children: ReactNode }) {
    if (!tip) {
        return children;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex">{children}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{tip}</TooltipContent>
        </Tooltip>
    );
}

function PoolSuffix({ pool, joiner = "on" }: { pool?: string | null; joiner?: string }) {
    if (!pool) {
        return null;
    }
    return (
        <span className="max-w-full truncate text-sm text-muted-foreground">
            {`${joiner} `}
            <PoolLink name={pool} className="relative z-10" />
        </span>
    );
}

export function LiveStatus({
    replicas,
    text = "Deployed",
    pool,
}: { replicas: Replica[]; text?: string; pool?: string | null }) {
    const here = pool ? replicas.filter((replica) => replica.pool === pool) : replicas;
    return (
        <span className="flex min-w-0 flex-col items-start">
            <ReplicaStatus replicas={here} text={text} />
            <PoolSuffix pool={pool} />
        </span>
    );
}

function ReplicaStatus({ replicas, text }: { replicas: Replica[]; text: string }) {
    const label = (
        <StatusText tone="success">
            {text}
            {replicas.length > 1 && (
                <span className="tabular-nums">{` · ${replicas.length} replicas`}</span>
            )}
        </StatusText>
    );
    if (replicas.length === 0) {
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
                        {replicas.length === 1 ? "Served on" : `${replicas.length} replicas on`}
                    </span>
                    {replicas.map((replica) => (
                        <span key={`${replica.pool}/${replica.host}`}>
                            {`Pool ${replica.pool} · `}
                            <span className="font-mono">{replica.host}</span>
                        </span>
                    ))}
                </span>
            </TooltipContent>
        </Tooltip>
    );
}

function Explained({ detail, children }: { detail?: string; children: ReactNode }) {
    if (!detail) {
        return children;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="relative z-10 rounded-sm text-left">
                    {children}
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-normal">{detail}</TooltipContent>
        </Tooltip>
    );
}

export function StatusLineText({
    line,
    name,
    replicas,
}: {
    line: StatusLine;
    name: string;
    replicas: Replica[];
}) {
    if (line.kind === "teardown" && line.row.teardown) {
        return (
            <span className="relative z-10">
                <TeardownStatus teardown={line.row.teardown} name={name} />
            </span>
        );
    }
    if (line.kind === "health" && line.row.health) {
        return (
            <span className="relative z-10">
                <HealthStatus health={line.row.health} />
            </span>
        );
    }
    if (line.kind === "on") {
        return <LiveStatus replicas={replicas} pool={line.row.deployment.pool} />;
    }
    if (line.tone === null) {
        return <Muted>{line.text}</Muted>;
    }
    const text = (
        <StatusText tone={line.tone}>
            <span className="tabular-nums">{line.text}</span>
        </StatusText>
    );
    if (line.kind === "starting") {
        return (
            <span className="flex min-w-0 flex-col items-start">
                {text}
                <PoolSuffix
                    pool={line.row.deployment.pool}
                    joiner={line.row.deployment.waiting ? "in" : "on"}
                />
            </span>
        );
    }
    if (line.kind === "training" || line.kind === "transfer") {
        return (
            <span className="flex items-center gap-2">
                {line.job ? (
                    <Link href={jobHref(line.job)} className="relative z-10 hover:underline">
                        {text}
                    </Link>
                ) : (
                    text
                )}
                <ProgressBar
                    value={line.progress}
                    label={`${name} ${line.text}`}
                    className="w-12"
                />
            </span>
        );
    }
    return <Explained detail={line.detail}>{text}</Explained>;
}

export function VersionName({ version }: { version: Pick<ModelVersionRow, "number" | "kind"> }) {
    if (!isBaseline(version)) {
        return <span className="tabular-nums">{`v${version.number}`}</span>;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="relative z-10 tabular-nums">
                    {`v${version.number} · Baseline`}
                </span>
            </TooltipTrigger>
            <TooltipContent>{BASELINE_HINT}</TooltipContent>
        </Tooltip>
    );
}

export function ScoreBadge({ model, version }: { model: ListModel; version: ModelVersionRow }) {
    const note = scoreNote(model, version);
    if (!note) {
        return null;
    }
    if (note.kind === "beats") {
        return <Badge variant="success">{`beats live ${points(note.delta)}`}</Badge>;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Badge variant="neutral" className="relative z-10" tabIndex={0}>
                    below rule
                </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{note.reason}</TooltipContent>
        </Tooltip>
    );
}

export function VersionStatus({
    version,
    replicas,
}: {
    version: ModelVersionRow;
    replicas: Replica[];
}) {
    if (version.health) {
        return (
            <span className="relative z-10">
                <HealthStatus health={version.health} />
            </span>
        );
    }
    const state = versionState(version);
    if (version.live) {
        return <LiveStatus replicas={replicas} text="Live" />;
    }
    if (version.status === "training" || version.status === "evaluating") {
        const share =
            version.progress === null || version.progress === undefined
                ? ""
                : ` · ${Math.round(version.progress * 100)}%`;
        return (
            <span className="flex items-center gap-2 whitespace-nowrap">
                <StatusText tone="info">
                    <span className="tabular-nums">{`${state.label}${share}`}</span>
                </StatusText>
                {version.job_id && (
                    <Link
                        href={jobHref({
                            id: version.job_id,
                            kind: version.status === "training" ? "train" : "eval",
                        })}
                        className="relative z-10 text-sm text-muted-foreground tabular-nums hover:text-foreground hover:underline"
                    >
                        {`Job #${version.job_id}`}
                    </Link>
                )}
            </span>
        );
    }
    const text = <StatusText tone={state.tone}>{state.label}</StatusText>;
    if (version.status === "failed") {
        return (
            <Explained detail={version.error || "The job failed without a message."}>
                {text}
            </Explained>
        );
    }
    return text;
}

export function datasetHref(key: string): string {
    return `/data?item=${encodeURIComponent(`dataset:${key}`)}`;
}

export function DataCell({ dataset }: { dataset: ModelRow["dataset"] }) {
    if (!dataset) {
        return <Muted />;
    }
    const newer = dataset.latest !== null && dataset.latest !== (dataset.version ?? 0);
    return (
        <div className="flex min-w-0 flex-col">
            <Link
                href={datasetHref(dataset.key)}
                className="relative z-10 truncate text-foreground hover:underline"
            >
                {dataset.name}
            </Link>
            <span className="truncate text-sm text-muted-foreground tabular-nums">
                {dataset.version !== null ? `v${dataset.version}` : "not trained yet"}
                {newer && <span className="text-warning">{` · v${dataset.latest} available`}</span>}
            </span>
        </div>
    );
}

export function ScoreGain({ value, versus }: { value: number; versus: string }) {
    const tone =
        value > 0.0005
            ? "text-success"
            : value < -0.0005
              ? "text-destructive"
              : "text-muted-foreground";
    return (
        <span className="text-sm text-muted-foreground tabular-nums">
            <span className={tone}>{points(value)}</span>
            {` vs ${versus}`}
        </span>
    );
}

export function ScoreFacts({ rows }: { rows: [string, number | null | undefined][] }) {
    return (
        <span className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 tabular-nums">
            {rows.map(([label, value]) => (
                <span key={label} className="contents">
                    <span>{label}</span>
                    <span className="text-right">{pct(value)}</span>
                </span>
            ))}
        </span>
    );
}
