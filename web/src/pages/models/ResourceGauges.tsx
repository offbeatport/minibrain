import { cn } from "obp-ui";
import type { ReactNode } from "react";
import type { CatalogVariantInfo } from "~/api/client";
import { bytes } from "~/lib/time";
import type { DiskNeed } from "./BaseSummary";

const LOW_SPACE = 5 * 1024 ** 3;
const TICKS = [25, 50, 75];

type Tone = "normal" | "warning" | "destructive";

const TONE_TEXT: Record<Tone, string> = {
    normal: "text-foreground",
    warning: "text-warning",
    destructive: "text-destructive",
};

const TONE_FILL: Record<Tone, string> = {
    normal: "bg-primary",
    warning: "bg-warning",
    destructive: "bg-destructive",
};

type Segment = { id: string; label: string; value: number; fill: string };

type Row = { id: string; label: string; value: string; swatch: string | null; tone?: Tone };

function percent(value: number, total: number): number {
    return total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;
}

function Bar({ label, total, segments }: { label: string; total: number; segments: Segment[] }) {
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

function Legend({ rows }: { rows: Row[] }) {
    return (
        <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1">
            {rows.map((row) => (
                <div key={row.id} className="contents">
                    <span
                        aria-hidden="true"
                        className={cn("size-2.5", row.swatch ?? "border bg-secondary")}
                    />
                    <dt className="text-muted-foreground">{row.label}</dt>
                    <dd className={cn("text-right tabular-nums", row.tone && TONE_TEXT[row.tone])}>
                        {row.value}
                    </dd>
                </div>
            ))}
        </dl>
    );
}

function Gauge({
    title,
    headline,
    tone,
    children,
}: {
    title: string;
    headline: string;
    tone: Tone;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-2.5">
            <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{title}</span>
                <span className={cn("text-lg font-semibold tabular-nums", TONE_TEXT[tone])}>
                    {headline}
                </span>
            </div>
            {children}
        </div>
    );
}

export type WeightsStore = {
    kind: "folder" | "s3";
    label: string;
    stagingFree: number | null | undefined;
};

function BucketGauge({
    need,
    store,
    onDisk,
}: {
    need: DiskNeed;
    store: WeightsStore;
    onDisk: number | null;
}) {
    const size = need?.size ?? onDisk ?? 0;
    const verb = need?.verb === "import" ? "to import" : need ? "to download" : "in the bucket";
    const rows: Row[] = [
        {
            id: "model",
            label: `This model, ${verb}`,
            value: size ? bytes(size) : "–",
            swatch: null,
        },
        {
            id: "staging",
            label: "Free on main's disk",
            value:
                store.stagingFree === null || store.stagingFree === undefined
                    ? "–"
                    : bytes(store.stagingFree),
            swatch: null,
        },
    ];
    return (
        <Gauge title={store.label} headline="–" tone="normal">
            <Legend rows={rows} />
            <p className="text-sm text-muted-foreground">
                S3 reports no free space, so the bucket's own quota is the limit. Files pass through
                main's disk one at a time on the way in.
            </p>
        </Gauge>
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
    if (store.kind === "s3") {
        return <BucketGauge need={need} store={store} onDisk={onDisk} />;
    }
    if (free === null || free === undefined || !total) {
        return (
            <Gauge title={store.label} headline="–" tone="normal">
                <p className="text-muted-foreground">Free space unknown</p>
            </Gauge>
        );
    }
    const download = need?.size ?? 0;
    const here = need ? 0 : (onDisk ?? 0);
    const used = Math.max(0, total - free);
    const others = Math.max(0, used - here);
    const after = free - download;
    const tone: Tone = after < 0 ? "destructive" : after < LOW_SPACE ? "warning" : "normal";
    const model = download || here;
    const full = Math.round(((used + download) / total) * 100);
    const verb = need?.verb === "import" ? "to import" : "to download";
    const rows: Row[] = [
        { id: "used", label: "Used by other files", value: bytes(others), swatch: "bg-faint" },
        {
            id: "model",
            label: download ? `This model, ${verb}` : "This model, on disk",
            value: model ? bytes(model) : "–",
            swatch: TONE_FILL[tone],
        },
        after < 0
            ? { id: "free", label: "Short by", value: bytes(-after), swatch: null, tone }
            : {
                  id: "free",
                  label: download ? "Free after" : "Free",
                  value: bytes(after),
                  swatch: null,
                  tone: tone === "warning" ? tone : undefined,
              },
    ];
    return (
        <Gauge
            title={store.label}
            headline={after < 0 ? "Does not fit" : `${Math.min(full, 100)}% full`}
            tone={tone}
        >
            <Bar
                label={store.label}
                total={total}
                segments={[
                    { id: "used", label: "Used", value: others, fill: "bg-faint" },
                    {
                        id: "model",
                        label: "This model",
                        value: Math.min(model, free + here),
                        fill: TONE_FILL[tone],
                    },
                ]}
            />
            <Legend rows={rows} />
            <p className="text-sm text-muted-foreground tabular-nums">{`${bytes(total)} disk`}</p>
        </Gauge>
    );
}

const MEMORY_TITLES: Record<string, string> = {
    "GPU memory": "GPU memory",
    "GPU-usable unified memory": "Unified memory",
    RAM: "RAM",
};

export function MemoryGauge({
    variant,
    memoryLabel,
}: {
    variant: CatalogVariantInfo | null;
    memoryLabel: string | undefined;
}) {
    const fit = variant?.fit;
    if (!fit || !fit.available_bytes) {
        return null;
    }
    const available = fit.available_bytes;
    const needed = fit.needed_bytes;
    const tone: Tone =
        fit.level === "insufficient"
            ? "destructive"
            : fit.level === "limited"
              ? "warning"
              : "normal";
    const short = needed - available;
    const title = MEMORY_TITLES[memoryLabel ?? ""] ?? "Memory";
    const rows: Row[] = [
        { id: "needs", label: "Memory to run", value: bytes(needed), swatch: TONE_FILL[tone] },
        short > 0
            ? { id: "left", label: "Short by", value: bytes(short), swatch: null, tone }
            : { id: "left", label: "Left over", value: bytes(available - needed), swatch: null },
    ];
    return (
        <Gauge title={title} headline={`${Math.round((needed / available) * 100)}%`} tone={tone}>
            <Bar
                label={title}
                total={available}
                segments={[
                    {
                        id: "needs",
                        label: "Needs",
                        value: Math.min(needed, available),
                        fill: TONE_FILL[tone],
                    },
                ]}
            />
            <Legend rows={rows} />
            <p className="text-sm text-muted-foreground tabular-nums">
                {memoryLabel === "GPU-usable unified memory"
                    ? `${bytes(available)} of unified memory usable by the GPU`
                    : `${bytes(available)} ${memoryLabel ?? "memory"}`}
            </p>
        </Gauge>
    );
}
