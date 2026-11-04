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
import { DiskGauge, MemoryGauge } from "./ResourceGauges";
import type { BaseOption } from "./baseOptions";

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
    const onDisk = need ? null : (variant?.size_bytes ?? option?.size ?? null);
    const facts = [option?.publisher, option?.params, option?.entry?.license_name].filter(Boolean);
    return (
        <section
            aria-label="Summary"
            className="flex flex-1 flex-col divide-y rounded-xl border bg-card text-card-foreground"
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
                <DiskGauge
                    need={need}
                    free={free}
                    total={catalog?.store_total_bytes}
                    onDisk={onDisk}
                />
                <MemoryGauge variant={variant} memoryLabel={catalog?.hardware.memory_label} />
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
