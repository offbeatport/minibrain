import { Download, ExternalLink, GraduationCap, HardDrive, Play } from "lucide-react";
import {
    Button,
    Checkbox,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "obp-ui";
import type {
    CatalogEntry,
    CatalogResponse,
    CatalogVariantInfo,
    FitInfo,
    TrainFitInfo,
} from "~/api/client";
import {
    BlockedReasons,
    SummaryCard,
    SummaryFact,
    SummaryFacts,
    SummarySection,
} from "~/components/CreateLayout";
import { StatusText } from "~/components/models/StatusText";
import { bytes } from "~/lib/time";
import type { SourcePlan } from "./BaseSource";
import { ComputeHelp, DiskLine, type DiskNeed } from "./BaseSummary";
import { licenceUseLabel } from "./DiscoverFilters";
import { DiskGauge, MemoryGauge } from "./ResourceGauges";
import { type BaseOption, trainableVariant } from "./baseOptions";
import { formatName, formatUse, scheme, trainable } from "./formats";

function variantLabel(variant: CatalogVariantInfo): string {
    const name = variant.format === "gguf" ? `GGUF ${scheme(variant)}` : scheme(variant);
    return [name, bytes(variant.size_bytes), formatUse(variant)].join(" · ");
}

export function Formats({
    plan,
    variant,
    servesOnly,
    onVariant,
}: {
    plan: SourcePlan;
    variant: CatalogVariantInfo | null;
    servesOnly: boolean;
    onVariant: (variant: string) => void;
}) {
    if (plan.target.kind === "catalogue" && plan.variant) {
        return (
            <Select
                value={plan.variant.id}
                onValueChange={(value) => value && onVariant(String(value))}
            >
                <SelectTrigger id="create-format" className="w-full tabular-nums">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {plan.target.entry.variants.map((choice) => (
                        <SelectItem key={choice.id} value={choice.id} className="tabular-nums">
                            {variantLabel(choice)}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        );
    }
    if (variant) {
        return <span className="tabular-nums">{variantLabel(variant)}</span>;
    }
    return (
        <span className="text-muted-foreground">
            {servesOnly ? "Quantized · Serve only" : "Unknown"}
        </span>
    );
}

function Requirements({
    fit,
    trainFit,
    servesOnly,
    storage,
    download,
}: {
    fit: FitInfo | null;
    trainFit: TrainFitInfo | null;
    servesOnly: boolean;
    storage: number | null;
    download: number | null;
}) {
    const train = servesOnly
        ? "Can't be trained"
        : trainFit?.qlora_bytes
          ? `${bytes(trainFit.qlora_bytes)} (QLoRA)`
          : "Unknown";
    return (
        <SummaryFacts>
            <SummaryFact icon={Play} label="Run">
                {fit ? bytes(fit.needed_bytes) : "Unknown"}
            </SummaryFact>
            <SummaryFact icon={GraduationCap} label="Train">
                {train}
            </SummaryFact>
            <SummaryFact icon={HardDrive} label="Storage">
                {storage ? bytes(storage) : "Unknown"}
            </SummaryFact>
            {download !== null && (
                <SummaryFact icon={Download} label="Download">
                    {bytes(download)}
                </SummaryFact>
            )}
        </SummaryFacts>
    );
}

function installed(entry: CatalogEntry, variant: CatalogVariantInfo): boolean {
    return entry.added.some(
        (added) => added.variant_id === variant.id && added.availability.state === "available",
    );
}

export function ServeOnlyNotice({
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

export function servesOnlyOf(option: BaseOption | null, plan: SourcePlan): boolean {
    const variant = plan.variant ?? option?.variant ?? null;
    const local = option?.kind === "local";
    const found = option ? undefined : plan.found;
    const trainFit = local ? null : (variant?.train_fit ?? found?.train_fit ?? null);
    return variant
        ? !trainable(variant)
        : Boolean(found?.quantized) || trainFit?.level === "unsupported";
}

export function AddModelSummary({
    option,
    plan,
    need,
    free,
    catalog,
    outcome,
    blocked,
    onVariant,
    onPickAnother,
}: {
    option: BaseOption | null;
    plan: SourcePlan;
    need: DiskNeed;
    free: number | null | undefined;
    catalog: CatalogResponse | undefined;
    outcome: string;
    blocked: string[];
    onVariant: (variant: string) => void;
    onPickAnother: () => void;
}) {
    const variant = plan.variant ?? option?.variant ?? null;
    const entry = plan.target.kind === "catalogue" ? plan.target.entry : (option?.entry ?? null);
    const found = option ? undefined : plan.found;
    const onDisk = need ? null : (variant?.size_bytes ?? option?.size ?? null);
    const local = option?.kind === "local";
    const fit = local ? null : (variant?.fit ?? found?.fit ?? null);
    const trainFit = local ? null : (variant?.train_fit ?? found?.train_fit ?? null);
    const servesOnly = servesOnlyOf(option, plan);
    const storage = need?.size ?? onDisk ?? (found?.size_bytes || null);
    const pool = catalog?.pools.find((item) => item.name === catalog.pool)?.label ?? null;
    const compute = catalog
        ? { memoryLabel: catalog.hardware.memory_label, machine: catalog.hardware.machine, pool }
        : null;
    return (
        <SummaryCard>
            <SummarySection title="System requirements">
                <Requirements
                    fit={fit}
                    trainFit={trainFit}
                    servesOnly={servesOnly}
                    storage={storage}
                    download={need ? need.size : null}
                />
            </SummarySection>
            <SummarySection title="Memory on your compute">
                <MemoryGauge fit={fit} trainFit={servesOnly ? null : trainFit} compute={compute} />
                {variant?.fit.level === "insufficient" && option && catalog && (
                    <ComputeHelp
                        option={{ ...option, variant }}
                        catalog={catalog}
                        onPickAnother={onPickAnother}
                    />
                )}
            </SummarySection>
            <SummarySection title="Storage on your compute">
                <DiskGauge
                    need={need}
                    free={free}
                    total={catalog?.store_total_bytes}
                    onDisk={storage}
                    store={{
                        kind: catalog?.store_kind ?? "folder",
                        label: catalog?.store_label ?? "Main server disk",
                        stagingFree: catalog?.staging_free_bytes,
                    }}
                />
                <DiskLine option={option} need={need} onPickAnother={onPickAnother} />
            </SummarySection>
            <SummarySection title="Result">
                <p className="tabular-nums">{outcome}</p>
                {variant && !trainable(variant) && (
                    <ServeOnlyNotice
                        entry={entry}
                        variant={variant}
                        onVariant={onVariant}
                        onPickAnother={onPickAnother}
                    />
                )}
            </SummarySection>
            <BlockedReasons reasons={blocked} />
        </SummaryCard>
    );
}
