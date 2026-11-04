import { ExternalLink } from "lucide-react";
import { Checkbox, Label, RadioGroup, RadioGroupItem, cn } from "obp-ui";
import type { ReactNode } from "react";
import type { CatalogResponse, CatalogVariantInfo } from "~/api/client";
import { PublisherLogo } from "~/components/PublisherLogo";
import { StatusText } from "~/components/models/StatusText";
import { bytes } from "~/lib/time";
import { FIT_TEXT, type SourcePlan } from "./BaseSource";
import { ComputeHelp, DiskLine, type DiskNeed } from "./BaseSummary";
import { licenceUseLabel } from "./DiscoverFilters";
import type { BaseOption } from "./baseOptions";

const LOW_SPACE = 5 * 1024 ** 3;

type Tone = "normal" | "warning" | "destructive";

const FILL: Record<Tone, string> = {
    normal: "bg-primary",
    warning: "bg-warning",
    destructive: "bg-destructive",
};

const TEXT: Record<Tone, string> = {
    normal: "text-muted-foreground",
    warning: "text-warning",
    destructive: "text-destructive",
};

function Meter({
    label,
    share,
    tone,
    caption,
}: {
    label: string;
    share: number | null;
    tone: Tone;
    caption: string;
}) {
    const width = share === null ? 0 : Math.max(2, Math.min(100, share * 100));
    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium">{label}</span>
                <span className={cn("text-sm tabular-nums", TEXT[tone])}>{caption}</span>
            </div>
            <div
                role="meter"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(width)}
                className="h-1.5 overflow-hidden rounded-full bg-secondary"
            >
                <div
                    className={cn("h-full rounded-full", FILL[tone])}
                    style={{ width: `${width}%` }}
                />
            </div>
        </div>
    );
}

function Block({ title, children }: { title?: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-3 px-panel py-4">
            {title && <span className="text-sm font-medium">{title}</span>}
            {children}
        </div>
    );
}

function formatTitle(variant: CatalogVariantInfo): string {
    return variant.format === "gguf" ? "Compressed" : "Full precision";
}

function formatUse(variant: CatalogVariantInfo): string {
    return variant.format === "gguf" ? "Serve only" : "Trainable";
}

function FormatCard({ variant, control }: { variant: CatalogVariantInfo; control?: ReactNode }) {
    return (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-baseline justify-between gap-3">
                <span className="flex items-center gap-2 font-medium">
                    {control}
                    {formatTitle(variant)}
                </span>
                <span className="text-sm tabular-nums">{bytes(variant.size_bytes)}</span>
            </span>
            <span className="text-sm text-muted-foreground">
                {`${variant.label.replace(/\s*safetensors/i, "")} · ${formatUse(variant)} · ${FIT_TEXT[variant.fit.level] ?? ""}`}
            </span>
        </span>
    );
}

const CARD = "flex rounded-lg border px-3 py-2.5 text-sm leading-snug";

function Formats({
    plan,
    variant,
    onVariant,
}: {
    plan: SourcePlan;
    variant: CatalogVariantInfo | null;
    onVariant: (variant: string) => void;
}) {
    if (plan.target.kind === "catalogue" && plan.variant) {
        return (
            <RadioGroup
                aria-label="Format"
                value={plan.variant.id}
                onValueChange={(value) => onVariant(String(value))}
                className="gap-2"
            >
                {plan.target.entry.variants.map((choice) => {
                    const id = `format-${choice.id}`;
                    return (
                        <Label
                            key={choice.id}
                            htmlFor={id}
                            className={cn(
                                CARD,
                                "cursor-pointer font-normal hover:bg-secondary",
                                "has-[[data-checked]]:border-primary has-[[data-checked]]:bg-accent",
                            )}
                        >
                            <FormatCard
                                variant={choice}
                                control={<RadioGroupItem value={choice.id} id={id} />}
                            />
                        </Label>
                    );
                })}
            </RadioGroup>
        );
    }
    if (variant) {
        return (
            <div className={CARD}>
                <FormatCard variant={variant} />
            </div>
        );
    }
    return <span className="text-sm text-muted-foreground">As installed</span>;
}

function diskMeter(need: DiskNeed, free: number | null | undefined) {
    if (free === null || free === undefined) {
        return { share: null, tone: "normal" as Tone, caption: "Free space unknown" };
    }
    if (!need) {
        return {
            share: 0,
            tone: "normal" as Tone,
            caption: `Nothing to download · ${bytes(free)} free`,
        };
    }
    const after = free - need.size;
    const tone: Tone = after < 0 ? "destructive" : after < LOW_SPACE ? "warning" : "normal";
    return {
        share: free > 0 ? need.size / free : 1,
        tone,
        caption:
            after < 0
                ? `${bytes(need.size)}, only ${bytes(free)} free`
                : `${bytes(need.size)} of ${bytes(free)} free`,
    };
}

function memoryMeter(variant: CatalogVariantInfo | null) {
    const fit = variant?.fit;
    if (!fit || !fit.available_bytes) {
        return null;
    }
    const tone: Tone =
        fit.level === "insufficient"
            ? "destructive"
            : fit.level === "limited"
              ? "warning"
              : "normal";
    return {
        share: fit.needed_bytes / fit.available_bytes,
        tone,
        caption: `Needs ${bytes(fit.needed_bytes)} of ${bytes(fit.available_bytes)}`,
    };
}

function ReadLink({ href }: { href: string }) {
    return (
        <a href={href} target="_blank" rel="noreferrer" className="text-primary hover:underline">
            Read it
            <ExternalLink className="ml-0.5 inline size-3.5" />
        </a>
    );
}

export function Licence({
    option,
    plan,
    accepted,
    onAccepted,
}: {
    option: BaseOption | null;
    plan: SourcePlan;
    accepted: boolean;
    onAccepted: (accepted: boolean) => void;
}) {
    const entry = plan.target.kind === "catalogue" ? plan.target.entry : option?.entry;
    if (!entry) {
        return null;
    }
    const use = `Commercial use: ${licenceUseLabel(entry.license_use).toLowerCase()}`;
    if (plan.target.kind === "catalogue" && plan.variant && !plan.installedKey) {
        if (plan.blocked) {
            return (
                <StatusText tone="warning" className="whitespace-normal">
                    {plan.blocked}
                </StatusText>
            );
        }
        return (
            <Label className="flex items-start gap-2 text-sm leading-snug font-normal">
                <Checkbox
                    checked={accepted}
                    onCheckedChange={(value) => onAccepted(value === true)}
                    className="mt-px"
                />
                <span>
                    {`I accept the ${entry.license_name} for this install. `}
                    <ReadLink href={entry.license_url} />
                    <span className="mt-0.5 block text-muted-foreground">{use}</span>
                </span>
            </Label>
        );
    }
    return (
        <p className="text-sm leading-snug">
            {`${entry.license_name}, already accepted on this install. `}
            <ReadLink href={entry.license_url} />
            <span className="mt-0.5 block text-muted-foreground">{use}</span>
        </p>
    );
}

export function AddModelSummary({
    option,
    plan,
    need,
    free,
    catalog,
    onVariant,
    onPickAnother,
}: {
    option: BaseOption | null;
    plan: SourcePlan;
    need: DiskNeed;
    free: number | null | undefined;
    catalog: CatalogResponse | undefined;
    onVariant: (variant: string) => void;
    onPickAnother: () => void;
}) {
    const variant = plan.variant ?? option?.variant ?? null;
    const disk = diskMeter(need, free);
    const memory = memoryMeter(variant);
    const facts = [option?.publisher, option?.params, option?.entry?.license_name].filter(Boolean);
    return (
        <section
            aria-label="Summary"
            className="flex flex-col divide-y rounded-xl border bg-card text-card-foreground"
        >
            <div className="flex items-center gap-3 px-panel py-4">
                <PublisherLogo publisher={option?.publisher} name={option?.name ?? "Model"} />
                <div className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold">
                        {option?.name ?? "Pick a base model"}
                    </span>
                    {facts.length > 0 && (
                        <span className="truncate text-sm text-muted-foreground">
                            {facts.join(" · ")}
                        </span>
                    )}
                </div>
            </div>
            <Block title="Format">
                <Formats plan={plan} variant={variant} onVariant={onVariant} />
                {variant?.format === "gguf" && (
                    <p className="text-sm text-muted-foreground">
                        Compressed formats serve but can't be trained. Pick Full precision to train
                        it.
                    </p>
                )}
            </Block>
            <Block>
                <Meter label="Disk" share={disk.share} tone={disk.tone} caption={disk.caption} />
                {memory && (
                    <Meter
                        label="Memory"
                        share={memory.share}
                        tone={memory.tone}
                        caption={memory.caption}
                    />
                )}
                <DiskLine option={option} need={need} onPickAnother={onPickAnother} />
                {variant?.fit.level === "insufficient" && option && catalog && (
                    <ComputeHelp
                        option={{ ...option, variant }}
                        catalog={catalog}
                        onPickAnother={onPickAnother}
                    />
                )}
            </Block>
        </section>
    );
}
