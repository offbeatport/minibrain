import { ExternalLink } from "lucide-react";
import { Button, Checkbox, InfoTip, Label, RadioGroup, RadioGroupItem, cn } from "obp-ui";
import type { ReactNode } from "react";
import type { CatalogEntry, CatalogResponse, CatalogVariantInfo } from "~/api/client";
import { PublisherLogo } from "~/components/PublisherLogo";
import { StatusText } from "~/components/models/StatusText";
import { bytes } from "~/lib/time";
import type { SourcePlan } from "./BaseSource";
import { ComputeHelp, DiskLine, type DiskNeed } from "./BaseSummary";
import { licenceUseLabel } from "./DiscoverFilters";
import { DiskGauge, MemoryGauge } from "./ResourceGauges";
import { type BaseOption, logoPublisher, trainableVariant } from "./baseOptions";
import { FormatHelp, fileType, formatName, formatUse, scheme, trainable } from "./formats";
import { trainMemory } from "./runsHere";

function Block({
    title,
    info,
    children,
}: {
    title?: string;
    info?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-3 px-panel py-4">
            {title && (
                <span className="flex items-center gap-1.5 font-medium">
                    {title}
                    {info}
                </span>
            )}
            {children}
        </div>
    );
}

function FormatCard({ variant, control }: { variant: CatalogVariantInfo; control?: ReactNode }) {
    return (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-baseline justify-between gap-3">
                <span className="flex items-center gap-2 font-medium">
                    {control}
                    {formatName(variant)}
                </span>
                <span className="text-sm tabular-nums">{bytes(variant.size_bytes)}</span>
            </span>
            <span className="text-sm text-muted-foreground">
                {[
                    fileType(variant),
                    formatUse(variant),
                    `${bytes(variant.fit.needed_bytes)} to run`,
                    trainMemory(variant) === null
                        ? null
                        : `${bytes(trainMemory(variant))} to train`,
                ]
                    .filter(Boolean)
                    .join(" · ")}
            </span>
        </span>
    );
}

const CARD = "flex rounded-lg border px-3 py-2.5 leading-snug";

const TRAIN_TONES = { fits: "success", insufficient: "destructive" } as const;

function TrainLine({ variant }: { variant: CatalogVariantInfo | null }) {
    const fit = variant?.train_fit;
    if (!fit || fit.qlora_bytes === null) {
        return null;
    }
    const level = fit.level === "fits" || fit.level === "insufficient" ? fit.level : null;
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 font-medium">
                    Memory to train (QLoRA)
                    <InfoTip label="Memory to train">{fit.basis}</InfoTip>
                </span>
                <span className="tabular-nums">{bytes(fit.qlora_bytes)}</span>
            </div>
            {level && (
                <StatusText tone={TRAIN_TONES[level]}>
                    {level === "fits" ? "Trains on your compute" : "Too large to train"}
                </StatusText>
            )}
        </div>
    );
}

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
    return <span className="text-muted-foreground">As installed</span>;
}

function installed(entry: CatalogEntry, variant: CatalogVariantInfo): boolean {
    return entry.added.some(
        (added) => added.variant_id === variant.id && added.availability.state === "available",
    );
}

function ServeOnlyNotice({
    entry,
    variant,
    onVariant,
    onPickAnother,
}: {
    entry: CatalogEntry | null;
    variant: CatalogVariantInfo;
    onVariant: (variant: string) => void;
    onPickAnother: () => void;
}) {
    const full = entry ? trainableVariant(entry) : undefined;
    const next = full ? (
        entry && installed(entry, full) ? (
            `${scheme(full)} is already on this install.`
        ) : (
            <>
                {`Switching downloads ${scheme(full)}, `}
                <span className="whitespace-nowrap tabular-nums">{bytes(full.size_bytes)}</span>.
            </>
        )
    ) : (
        "The catalogue has no full-precision format of this model."
    );
    const still = full
        ? `You can still give it instructions, score it and serve it under its own name; train it later by switching to ${entry?.name ?? "the model"} ${scheme(full)}.`
        : "You can still give it instructions, score it and serve it under its own name.";
    return (
        <div className="flex flex-col gap-2.5">
            <StatusText tone="warning">{`${scheme(variant)} can't be fine-tuned`}</StatusText>
            <p className="text-sm text-muted-foreground">
                Quantized formats serve only; training needs full precision. {next}
            </p>
            <p className="text-sm text-muted-foreground">{still}</p>
            <div>
                {full ? (
                    <Button type="button" variant="outline" onClick={() => onVariant(full.id)}>
                        {`Use ${formatName(full)}`}
                    </Button>
                ) : (
                    <Button type="button" variant="outline" onClick={onPickAnother}>
                        Pick another
                    </Button>
                )}
            </div>
        </div>
    );
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
    id,
    option,
    plan,
    accepted,
    onAccepted,
    error,
}: {
    id?: string;
    option: BaseOption | null;
    plan: SourcePlan;
    accepted: boolean;
    onAccepted: (accepted: boolean) => void;
    error?: string | null;
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
            <Label className="flex items-start gap-2 leading-snug font-normal">
                <Checkbox
                    id={id}
                    checked={accepted}
                    onCheckedChange={(value) => onAccepted(value === true)}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error && id ? `${id}-error` : undefined}
                    className="mt-px"
                />
                <span>
                    {`I accept the ${entry.license_name} for this install. `}
                    <ReadLink href={entry.license_url} />
                    <span className="mt-0.5 block text-muted-foreground">{use}</span>
                    {error && (
                        <span
                            id={id ? `${id}-error` : undefined}
                            className="mt-1 block text-destructive"
                        >
                            {error}
                        </span>
                    )}
                </span>
            </Label>
        );
    }
    return (
        <p className="leading-snug">
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
    const entry = plan.target.kind === "catalogue" ? plan.target.entry : (option?.entry ?? null);
    const onDisk = need ? null : (variant?.size_bytes ?? option?.size ?? null);
    const facts = [option?.publisher, option?.params, option?.entry?.license_name].filter(Boolean);
    return (
        <section
            aria-label="Summary"
            className="flex flex-1 flex-col divide-y rounded-xl border bg-card text-card-foreground"
        >
            <div className="flex items-center gap-3 px-panel py-4">
                <PublisherLogo publisher={logoPublisher(option)} name={option?.name ?? "Model"} />
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
            <Block
                title="Format"
                info={
                    <InfoTip label="What the formats mean">
                        <FormatHelp />
                    </InfoTip>
                }
            >
                <Formats plan={plan} variant={variant} onVariant={onVariant} />
                {variant && !trainable(variant) && (
                    <ServeOnlyNotice
                        entry={entry}
                        variant={variant}
                        onVariant={onVariant}
                        onPickAnother={onPickAnother}
                    />
                )}
            </Block>
            <Block>
                <DiskGauge
                    need={need}
                    free={free}
                    total={catalog?.store_total_bytes}
                    onDisk={onDisk}
                    store={{
                        kind: catalog?.store_kind ?? "folder",
                        label: catalog?.store_label ?? "Main server disk",
                        stagingFree: catalog?.staging_free_bytes,
                    }}
                />
                <MemoryGauge variant={variant} memoryLabel={catalog?.hardware.memory_label} />
                <TrainLine variant={variant} />
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
