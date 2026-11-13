import { GraduationCap, HardDrive, type LucideIcon, MemoryStick, Play, Server } from "lucide-react";
import type { ReactNode } from "react";
import type { FitInfo, TrainFitInfo } from "~/api/client";
import { SummaryLine } from "~/components/CreateLayout";
import { PoolLink, PoolList } from "~/components/PoolLink";
import { StatusText } from "~/components/models/StatusText";
import { bytes } from "~/lib/time";
import type { DiskNeed } from "./BaseSummary";
import { type PoolFits, runnable } from "./runsHere";

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
}: { label: string; total: number; segments: Segment[] }) {
    const used = segments.reduce((sum, segment) => sum + segment.value, 0);
    return (
        <div
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent(used, total))}
            className="relative h-7 overflow-hidden rounded-sm border bg-secondary p-[3px]"
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
                    className="absolute inset-y-[3px] w-px bg-background"
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
                <FolderPlace label={store.label} />
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
            <Figures
                icon={HardDrive}
            >{`${amount} · ${bytes(free)} free of ${bytes(total)}`}</Figures>
            <FolderPlace label={store.label} />
        </>
    );
}

export type ComputeInfo = { memoryLabel: string; pool: string };

function servePools(fit: FitInfo, compute: ComputeInfo | null, fits: PoolFits | null): string[] {
    if (fits) {
        return fits.serve;
    }
    return compute && runnable(fit.level) ? [compute.pool] : [];
}

function trainPools(
    trainFit: TrainFitInfo,
    compute: ComputeInfo | null,
    fits: PoolFits | null,
): string[] {
    if (fits) {
        return fits.train;
    }
    return compute && trainFit.level === "fits" ? [compute.pool] : [];
}

function ServeStatus({
    fit,
    compute,
    fits,
}: {
    fit: FitInfo;
    compute: ComputeInfo | null;
    fits: PoolFits | null;
}) {
    const pools = servePools(fit, compute, fits);
    if (pools.length > 0) {
        return (
            <SummaryLine icon={Play}>
                <StatusText tone="success" className="whitespace-normal">
                    <span>
                        {"Runs on "}
                        <PoolList names={pools} />
                    </span>
                </StatusText>
            </SummaryLine>
        );
    }
    if (fit.level !== "insufficient" || (fits && !fits.checked)) {
        return null;
    }
    return (
        <SummaryLine icon={Play}>
            <StatusText tone="destructive" className="whitespace-normal">
                Too large for every pool
            </StatusText>
        </SummaryLine>
    );
}

function TrainStatus({
    trainFit,
    compute,
    fits,
}: {
    trainFit: TrainFitInfo;
    compute: ComputeInfo | null;
    fits: PoolFits | null;
}) {
    const pools = trainPools(trainFit, compute, fits);
    if (pools.length > 0) {
        return (
            <SummaryLine icon={GraduationCap}>
                <StatusText tone="success" className="whitespace-normal">
                    <span>
                        {"Trains on "}
                        <PoolList names={pools} />
                    </span>
                </StatusText>
            </SummaryLine>
        );
    }
    if (trainFit.level !== "insufficient" || (fits && !fits.checked)) {
        return null;
    }
    return (
        <SummaryLine icon={GraduationCap}>
            <StatusText tone="destructive" className="whitespace-normal">
                Too large to train in every pool
            </StatusText>
        </SummaryLine>
    );
}

export function MemoryGauge({
    fit,
    trainFit,
    compute,
    fits,
}: {
    fit: FitInfo | null;
    trainFit: TrainFitInfo | null;
    compute: ComputeInfo | null;
    fits: PoolFits | null;
}) {
    const available = fit?.available_bytes;
    if (!fit || !available || fit.level === "unknown") {
        return (
            <SummaryLine icon={MemoryStick} className="text-muted-foreground">
                {fit ? "Not checked: no machine has reported its memory yet" : "Unknown"}
            </SummaryLine>
        );
    }
    const needed = fit.needed_bytes;
    const short = needed > available;
    const tone: Tone = short ? "destructive" : fit.level === "limited" ? "warning" : "normal";
    const label = compute?.memoryLabel ?? "memory";
    return (
        <>
            <ResourceBar
                label={compute ? `${label} in pool ${compute.pool}` : label}
                total={available}
                segments={[
                    { id: "needs", value: Math.min(needed, available), fill: TONE_FILL[tone] },
                ]}
            />
            <Figures icon={MemoryStick}>
                {short
                    ? `${bytes(needed)} needed · only ${bytes(available)} ${label}`
                    : `${bytes(needed)} of ${bytes(available)} ${label}`}
                {compute && (
                    <>
                        {" in "}
                        <PoolLink name={compute.pool} />
                    </>
                )}
            </Figures>
            <span className="flex flex-col gap-1">
                <ServeStatus fit={fit} compute={compute} fits={fits} />
                {trainFit && <TrainStatus trainFit={trainFit} compute={compute} fits={fits} />}
            </span>
        </>
    );
}
