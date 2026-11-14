import { HardDrive, type LucideIcon, Server } from "lucide-react";
import { cn } from "obp-ui";
import type { ReactNode } from "react";
import type { FitInfo, TrainFitInfo } from "~/api/client";
import { SummaryLine } from "~/components/CreateLayout";
import { PoolLink } from "~/components/PoolLink";
import { StatusText } from "~/components/models/StatusText";
import { bytes } from "~/lib/time";
import type { DiskNeed } from "./BaseSummary";
import { type PoolFit, runnable } from "./runsHere";

const LOW_SPACE = 5 * 1024 ** 3;
const TICKS = [25, 50, 75];

type Tone = "normal" | "warning" | "destructive";

const TONE_FILL: Record<Tone, string> = {
    normal: "bg-primary",
    warning: "bg-warning",
    destructive: "bg-destructive",
};

type Segment = { id: string; value: number; fill: string };

function percent(value: number, total: number): number {
    return total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
}

export function ResourceBar({
    label,
    total,
    segments,
    size = "md",
}: { label: string; total: number; segments: Segment[]; size?: "sm" | "md" }) {
    const used = segments.reduce((sum, segment) => sum + segment.value, 0);
    return (
        <div
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent(used, total))}
            className={cn(
                "relative overflow-hidden rounded-sm border bg-secondary",
                size === "sm" ? "h-3 p-px" : "h-7 p-[3px]",
            )}
        >
            <div className="flex h-full">
                {segments.map((segment) => (
                    <div
                        key={segment.id}
                        className={segment.fill}
                        style={{
                            width: `${percent(segment.value, total)}%`,
                            minWidth: segment.value > 0 ? 4 : 0,
                        }}
                    />
                ))}
            </div>
            {TICKS.map((tick) => (
                <span
                    key={tick}
                    aria-hidden="true"
                    className={cn(
                        "absolute w-px bg-background",
                        size === "sm" ? "inset-y-px" : "inset-y-[3px]",
                    )}
                    style={{ left: `${tick}%` }}
                />
            ))}
        </div>
    );
}

function Figures({ icon, children }: { icon: LucideIcon; children: ReactNode }) {
    return (
        <SummaryLine icon={icon} className="tabular-nums">
            {children}
        </SummaryLine>
    );
}

function Where({ children }: { children: ReactNode }) {
    return (
        <SummaryLine icon={Server} className="text-muted-foreground">
            {children}
        </SummaryLine>
    );
}

export type WeightsStore = {
    kind: "folder" | "s3";
    label: string;
    stagingFree: number | null | undefined;
};

export const MAIN_POOL = "local";

function FolderPlace({ label }: { label: string }) {
    return (
        <Where>
            {`${label} in `}
            <PoolLink name={MAIN_POOL} />
        </Where>
    );
}

export function DiskGauge({
    need,
    free,
    total,
    onDisk,
    store,
}: {
    need: DiskNeed;
    free: number | null | undefined;
    total: number | null | undefined;
    onDisk: number | null;
    store: WeightsStore;
}) {
    const place = <FolderPlace label={store.label} />;
    const size = need?.size ?? onDisk;
    const amount = size === null ? "Size unknown" : `${bytes(size)} ${need ? "needed" : "on disk"}`;
    if (store.kind === "s3") {
        const staging =
            store.stagingFree === null || store.stagingFree === undefined
                ? null
                : `${bytes(store.stagingFree)} free on main's disk to pass through`;
        return (
            <>
                <Figures icon={HardDrive}>{[amount, staging].filter(Boolean).join(" · ")}</Figures>
                <Where>{`${store.label}: S3 reports no free space, so the bucket's quota is the limit.`}</Where>
            </>
        );
    }
    if (free === null || free === undefined || !total) {
        return (
            <>
                <Figures icon={HardDrive}>{`${amount} · free space unknown`}</Figures>
                {place}
            </>
        );
    }
    const download = need?.size ?? 0;
    const here = need ? 0 : (onDisk ?? 0);
    const others = Math.max(0, total - free - here);
    const after = free - download;
    const tone: Tone = after < 0 ? "destructive" : after < LOW_SPACE ? "warning" : "normal";
    return (
        <>
            <ResourceBar
                label="Storage for model files"
                total={total}
                segments={[
                    { id: "used", value: others, fill: "bg-faint" },
                    {
                        id: "model",
                        value: Math.min(download || here, free + here),
                        fill: TONE_FILL[tone],
                    },
                ]}
            />
            <Figures icon={HardDrive}>{`${amount} · ${bytes(free)} free`}</Figures>
            {place}
        </>
    );
}

type Verdict = { text: string; tone: "success" | "warning" | "destructive" | "muted" };

function verdict(fit: FitInfo | null, trainFit: TrainFitInfo | null, servesOnly: boolean): Verdict {
    if (!fit || !fit.available_bytes || fit.level === "unknown") {
        return { text: "Not checked", tone: "muted" };
    }
    if (!runnable(fit.level)) {
        return { text: "Too small", tone: "destructive" };
    }
    if (servesOnly) {
        return { text: "Runs", tone: fit.level === "limited" ? "warning" : "success" };
    }
    if (trainFit?.level === "fits") {
        return { text: "Runs and trains", tone: "success" };
    }
    return { text: "Runs only", tone: "warning" };
}

function PoolRow({ pool, servesOnly }: { pool: PoolFit; servesOnly: boolean }) {
    const { fit } = pool;
    const result = verdict(fit, pool.trainFit, servesOnly);
    const available = fit?.available_bytes ?? 0;
    const needed = fit?.needed_bytes ?? 0;
    const short = needed > available;
    const tone: Tone = short ? "destructive" : fit?.level === "limited" ? "warning" : "normal";
    return (
        <li className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between gap-3">
                <PoolLink name={pool.name} />
                {result.tone === "muted" ? (
                    <span className="text-muted-foreground">{result.text}</span>
                ) : (
                    <StatusText tone={result.tone}>{result.text}</StatusText>
                )}
            </span>
            {available > 0 && (
                <>
                    <ResourceBar
                        label={`Memory in pool ${pool.name}`}
                        total={available}
                        size="sm"
                        segments={[
                            {
                                id: "needs",
                                value: Math.min(needed, available),
                                fill: TONE_FILL[tone],
                            },
                        ]}
                    />
                    <span className="text-sm text-muted-foreground tabular-nums">
                        {short
                            ? `Needs ${bytes(needed)} · has ${bytes(available)}`
                            : `${bytes(needed)} of ${bytes(available)} memory`}
                    </span>
                </>
            )}
        </li>
    );
}

export function PoolFitList({ pools, servesOnly }: { pools: PoolFit[]; servesOnly: boolean }) {
    if (pools.length === 0) {
        return <span className="text-muted-foreground">Unknown</span>;
    }
    return (
        <ul className="flex flex-col gap-4">
            {pools.map((pool) => (
                <PoolRow key={pool.name} pool={pool} servesOnly={servesOnly} />
            ))}
        </ul>
    );
}
