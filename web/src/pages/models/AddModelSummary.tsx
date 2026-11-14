import {
    Archive,
    ExternalLink,
    GraduationCap,
    HardDrive,
    type LucideIcon,
    MemoryStick,
    Play,
} from "lucide-react";
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
import type { ReactNode } from "react";
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
import { PoolLink } from "~/components/PoolLink";
import { StatusText } from "~/components/models/StatusText";
import { bytes } from "~/lib/time";
import type { SourcePlan } from "./BaseSource";
import { ComputeHelp, DiskLine, type DiskNeed } from "./BaseSummary";
import { licenceUseLabel } from "./DiscoverFilters";
import { DiskGauge, MAIN_POOL, MemoryGauge, PoolStatus } from "./ResourceGauges";
import { type BaseOption, trainableVariant } from "./baseOptions";
import { formatUse, scheme, trainable } from "./formats";
import { type PoolFits, usePoolFits } from "./runsHere";

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

function Amount({ icon: Icon, value }: { icon: LucideIcon; value: string }) {
    return (
        <span className="inline-flex items-center gap-1.5">
            <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {value}
        </span>
    );
}

function Requirements({
    fit,
    trainFit,
    servesOnly,
    storage,
}: {
    fit: FitInfo | null;
    trainFit: TrainFitInfo | null;
    servesOnly: boolean;
    storage: number | null;
}) {
    const train = servesOnly ? (
        "Can't be trained"
    ) : trainFit?.qlora_bytes ? (
        <Amount icon={MemoryStick} value={`${bytes(trainFit.qlora_bytes)} (QLoRA)`} />
    ) : (
        "Unknown"
    );
    return (
        <SummaryFacts>
            <SummaryFact icon={Play} label="Run">
                {fit ? <Amount icon={MemoryStick} value={bytes(fit.needed_bytes)} /> : "Unknown"}
            </SummaryFact>
            <SummaryFact icon={GraduationCap} label="Train">
                {train}
            </SummaryFact>
            <SummaryFact icon={Archive} label="Storage">
                {storage ? <Amount icon={HardDrive} value={bytes(storage)} /> : "Unknown"}
            </SummaryFact>
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
    const switching = full ? (
        entry && installed(entry, full) ? (
            `Switch to ${scheme(full)} when you want to train; it's already on this install.`
        ) : (
            <>
                {`Switch to ${scheme(full)} when you want to train (a `}
                <span className="whitespace-nowrap tabular-nums">{bytes(full.size_bytes)}</span>
                {" download)."}
            </>
        )
    ) : (
        "This model has no full-precision format to train."
    );
    return (
        <div className="flex flex-col gap-2.5">
            <StatusText tone="warning">{`${scheme(variant)} can't be trained`}</StatusText>
            <p className="text-muted-foreground">
                {"Quantized formats can only serve. You can still score and deploy it. "}
                {switching}
            </p>
            <div>
                {full ? (
                    <Button type="button" variant="outline" onClick={() => onVariant(full.id)}>
                        {`Use ${scheme(full)}`}
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

function summaryPool(catalog: CatalogResponse | undefined, fits: PoolFits): string {
    const home = catalog?.pool ?? MAIN_POOL;
    if (fits.serve.length === 0 || fits.serve.includes(home)) {
        return home;
    }
    return fits.serve[0] ?? home;
}

function Gauge({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            <span className="text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}

export function AddModelSummary({
    option,
    plan,
    need,
    free,
    catalog,
    outcome,
    blocked,
}: {
    option: BaseOption | null;
    plan: SourcePlan;
    need: DiskNeed;
    free: number | null | undefined;
    catalog: CatalogResponse | undefined;
    outcome: string;
    blocked: string[];
}) {
    const variant = plan.variant ?? option?.variant ?? null;
    const entry = plan.target.kind === "catalogue" ? plan.target.entry : (option?.entry ?? null);
    const found = option ? undefined : plan.found;
    const onDisk = need ? null : (variant?.size_bytes ?? option?.size ?? null);
    const local = option?.kind === "local";
    const homeFit = local ? null : (variant?.fit ?? found?.fit ?? null);
    const trainFit = local ? null : (variant?.train_fit ?? found?.train_fit ?? null);
    const servesOnly = servesOnlyOf(option, plan);
    const storage = need?.size ?? onDisk ?? (found?.size_bytes || null);
    const fits = usePoolFits(catalog, local ? null : entry?.id, local ? null : variant?.id);
    const pool = summaryPool(catalog, fits);
    const fit = fits.fit[pool] ?? homeFit;
    const compute = catalog ? { pool } : null;
    return (
        <SummaryCard>
            <SummarySection title="System requirements">
                <Requirements
                    fit={homeFit}
                    trainFit={trainFit}
                    servesOnly={servesOnly}
                    storage={storage}
                />
            </SummarySection>
            <SummarySection
                title="Pool"
                info={
                    <span className="ml-auto font-normal">
                        <PoolLink name={pool} />
                    </span>
                }
            >
                <div className="flex flex-col gap-4">
                    <Gauge label="Memory">
                        <MemoryGauge fit={fit} compute={compute} />
                    </Gauge>
                    <Gauge label="Disk">
                        <DiskGauge
                            need={need}
                            free={free}
                            total={catalog?.store_total_bytes}
                            onDisk={storage}
                            pool={pool}
                            store={{
                                kind: catalog?.store_kind ?? "folder",
                                label: catalog?.store_label ?? "Main server disk",
                                stagingFree: catalog?.staging_free_bytes,
                            }}
                        />
                    </Gauge>
                    <PoolStatus
                        fit={fit}
                        trainFit={servesOnly ? null : trainFit}
                        compute={compute}
                        fits={entry && variant && !local ? fits : null}
                    />
                </div>
            </SummarySection>
            <SummarySection title="Result">
                <p className="tabular-nums">{outcome}</p>
            </SummarySection>
            <BlockedReasons reasons={blocked} />
        </SummaryCard>
    );
}

export function AddModelNotices({
    option,
    plan,
    need,
    catalog,
    onVariant,
    onPickAnother,
}: {
    option: BaseOption | null;
    plan: SourcePlan;
    need: DiskNeed;
    catalog: CatalogResponse | undefined;
    onVariant: (variant: string) => void;
    onPickAnother: () => void;
}) {
    const variant = plan.variant ?? option?.variant ?? null;
    const entry = plan.target.kind === "catalogue" ? plan.target.entry : (option?.entry ?? null);
    const tooLarge = variant?.fit.level === "insufficient" && option && catalog;
    const serveOnly = variant && !trainable(variant);
    return (
        <div className="mt-auto flex flex-col gap-6 empty:hidden">
            {tooLarge && (
                <ComputeHelp
                    option={{ ...option, variant }}
                    catalog={catalog}
                    onPickAnother={onPickAnother}
                />
            )}
            <DiskLine option={option} need={need} onPickAnother={onPickAnother} />
            {serveOnly && (
                <ServeOnlyNotice
                    entry={entry}
                    variant={variant}
                    onVariant={onVariant}
                    onPickAnother={onPickAnother}
                />
            )}
        </div>
    );
}
