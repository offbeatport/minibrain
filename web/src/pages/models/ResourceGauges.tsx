import type { ReactNode } from "react";
import type { FitInfo, TrainFitInfo } from "~/api/client";
import { StatusText } from "~/components/models/StatusText";
import { bytes } from "~/lib/time";
import type { DiskNeed } from "./BaseSummary";

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

function Figures({ children }: { children: ReactNode }) {
    return <span className="tabular-nums">{children}</span>;
}

function Where({ children }: { children: ReactNode }) {
    return <span className="text-sm text-muted-foreground">{children}</span>;
}

export type WeightsStore = {
    kind: "folder" | "s3";
    label: string;
    stagingFree: number | null | undefined;
};

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
                <Figures>{[amount, staging].filter(Boolean).join(" · ")}</Figures>
                <Where>{`${store.label}: S3 reports no free space, so the bucket's quota is the limit.`}</Where>
            </>
        );
    }
    if (free === null || free === undefined || !total) {
        return (
            <>
                <Figures>{`${amount} · free space unknown`}</Figures>
                <Where>{store.label}</Where>
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
                label="Storage on your compute"
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
            <Figures>{`${amount} · ${bytes(free)} free of ${bytes(total)}`}</Figures>
            <Where>{store.label}</Where>
        </>
    );
}

const SERVE_STATUS: Record<
    FitInfo["level"],
    { tone: "success" | "destructive"; text: string } | null
> = {
    fits: { tone: "success", text: "Fits your compute" },
    limited: { tone: "success", text: "Fits your compute" },
    insufficient: { tone: "destructive", text: "Too large to serve on your compute" },
    unknown: null,
};

const TRAIN_STATUS: Partial<
    Record<TrainFitInfo["level"], { tone: "success" | "destructive"; text: string }>
> = {
    fits: { tone: "success", text: "Trains on your compute" },
    insufficient: { tone: "destructive", text: "Too large to train" },
};

export type ComputeInfo = { memoryLabel: string; machine: string; pool: string | null };

export function MemoryGauge({
    fit,
    trainFit,
    compute,
}: {
    fit: FitInfo | null;
    trainFit: TrainFitInfo | null;
    compute: ComputeInfo | null;
}) {
    const available = fit?.available_bytes;
    if (!fit || !available || fit.level === "unknown") {
        return (
            <span className="text-muted-foreground">
                {fit ? "Not checked: no machine has reported its memory yet" : "Unknown"}
            </span>
        );
    }
    const needed = fit.needed_bytes;
    const short = needed > available;
    const tone: Tone = short ? "destructive" : fit.level === "limited" ? "warning" : "normal";
    const serve = SERVE_STATUS[fit.level];
    const train = trainFit ? TRAIN_STATUS[trainFit.level] : undefined;
    const where = compute
        ? [`${compute.memoryLabel} on ${compute.machine}`, compute.pool && `Pool: ${compute.pool}`]
              .filter(Boolean)
              .join(" · ")
        : null;
    return (
        <>
            <ResourceBar
                label="Memory on your compute"
                total={available}
                segments={[
                    { id: "needs", value: Math.min(needed, available), fill: TONE_FILL[tone] },
                ]}
            />
            <Figures>
                {short
                    ? `${bytes(needed)} needed · only ${bytes(available)} available`
                    : `${bytes(needed)} of ${bytes(available)} available`}
            </Figures>
            {where && <Where>{where}</Where>}
            {(serve || train) && (
                <span className="flex flex-col gap-1">
                    {serve && (
                        <StatusText tone={serve.tone} className="whitespace-normal">
                            {serve.text}
                        </StatusText>
                    )}
                    {train && (
                        <StatusText tone={train.tone} className="whitespace-normal">
                            {train.text}
                        </StatusText>
                    )}
                </span>
            )}
        </>
    );
}
