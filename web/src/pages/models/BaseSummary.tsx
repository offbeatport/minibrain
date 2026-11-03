import { Button, Link } from "obp-ui";
import type { CatalogEntry, CatalogResponse } from "~/api/client";
import { useCatalog } from "~/api/queries";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { bytes } from "~/lib/time";
import { PathResult, type SourcePlan, VariantLicence } from "./BaseSource";
import { type BaseOption, addedKey, gigabytes } from "./baseOptions";

const LOW_SPACE = 5 * 1024 ** 3;

export type CopySource = {
    slug: string;
    name: string;
    datasetName: string | null;
    recipe: { rows: number; epochs: number; version: number } | null;
};

export type DiskNeed = { size: number; free: number | null; verb: string } | null;

export function diskNeed(
    option: BaseOption | null,
    plan: SourcePlan,
    free: number | null | undefined,
): DiskNeed {
    const room = free ?? null;
    if (option?.kind === "catalogue" && !plan.installedKey && plan.variant) {
        return { size: plan.variant.size_bytes, free: room, verb: "download" };
    }
    if (!option && plan.target.kind === "path" && plan.found?.ok && plan.found.size_bytes) {
        return { size: plan.found.size_bytes, free: room, verb: "import" };
    }
    return null;
}

export function diskBlocks(need: DiskNeed): boolean {
    return need !== null && need.free !== null && need.size > need.free;
}

function DiskLine({
    option,
    need,
    onPickAnother,
}: {
    option: BaseOption | null;
    need: DiskNeed;
    onPickAnother: () => void;
}) {
    const state = option?.added?.availability.state;
    if (option && !need) {
        if (state === "downloading" || state === "importing") {
            return <StatusText tone="info">Downloading now; nothing more to download</StatusText>;
        }
        if (state === "missing") {
            return (
                <span className="flex flex-wrap items-center gap-2">
                    <StatusText tone="warning" className="whitespace-normal">
                        On this install, but its files are missing
                    </StatusText>
                    {option.baseKey && (
                        <Button asChild variant="outline" size="sm">
                            <Link href={`/models/base/${encodeURIComponent(option.baseKey)}`}>
                                Repair it
                            </Link>
                        </Button>
                    )}
                    <Button type="button" variant="ghost" size="sm" onClick={onPickAnother}>
                        Pick another
                    </Button>
                </span>
            );
        }
        return null;
    }
    if (!need) {
        return null;
    }
    const large = need.size >= 1024 ** 3;
    const size = large ? `${gigabytes(need.size)} GB` : bytes(need.size);
    const share = large ? gigabytes(need.size) : bytes(need.size);
    if (need.free === null) {
        return null;
    }
    const free = gigabytes(need.free);
    if (need.size > need.free) {
        return (
            <StatusText tone="destructive" className="whitespace-normal">
                {`Not enough disk space: a ${size} ${need.verb}, and only ${free} GB is free. Free up space on the model files disk first.`}
            </StatusText>
        );
    }
    const left = need.free - need.size;
    if (left >= LOW_SPACE) {
        return null;
    }
    return (
        <StatusText tone="warning" className="whitespace-normal tabular-nums">
            {`${size} ${need.verb}, uses ${share} of ${free} GB free; only ${gigabytes(left)} GB left after it`}
        </StatusText>
    );
}

function PoolFit({
    pool,
    entry,
    variant,
}: { pool: { name: string; label: string }; entry: CatalogEntry; variant: string }) {
    const catalog = useCatalog(pool.name);
    const found = catalog.data?.entries.find((item) => item.id === entry.id);
    const fit = found?.variants.find((item) => item.id === variant)?.fit.level;
    if (!fit) {
        return <li className="text-muted-foreground">{`Checking ${pool.label}…`}</li>;
    }
    const fits = fit === "fits" || fit === "limited";
    return (
        <li>
            <StatusText tone={fits ? "success" : "neutral"} className="whitespace-normal">
                {fits
                    ? `Fits the ${pool.label} pool: train and serve it there.`
                    : `Does not fit the ${pool.label} pool either.`}
            </StatusText>
        </li>
    );
}

function ComputeHelp({ option, catalog }: { option: BaseOption; catalog: CatalogResponse }) {
    const { entry, variant } = option;
    if (!entry || !variant) {
        return null;
    }
    const origin = window.location.origin;
    const others = catalog.pools.filter((pool) => pool.name !== catalog.pool);
    const model = option.baseKey ?? addedKey(entry, variant);
    return (
        <div className="flex flex-col gap-3 rounded-md border px-3 py-3 text-sm">
            <div className="flex flex-col gap-0.5">
                <StatusText tone="info" className="whitespace-normal">
                    Needs more compute than this machine has
                </StatusText>
                <span className="text-muted-foreground tabular-nums">
                    {variant.fit.available_bytes
                        ? `It needs about ${bytes(variant.fit.needed_bytes)} of memory; ${catalog.hardware.machine} has ${bytes(variant.fit.available_bytes)}.`
                        : `It needs about ${bytes(variant.fit.needed_bytes)} of memory.`}
                </span>
            </div>
            <ol className="flex list-decimal flex-col gap-3 pl-5">
                <li className="flex flex-col gap-1.5">
                    <span className="font-medium">Use a compute pool that fits</span>
                    {others.length > 0 ? (
                        <ul className="flex flex-col gap-1">
                            {others.map((pool) => (
                                <PoolFit
                                    key={pool.name}
                                    pool={pool}
                                    entry={entry}
                                    variant={variant.id}
                                />
                            ))}
                        </ul>
                    ) : (
                        <span className="text-muted-foreground">
                            No other compute pool has a machine online yet.
                        </span>
                    )}
                </li>
                <li className="flex flex-col gap-1.5">
                    <span className="font-medium">Add a GPU machine to a compute pool</span>
                    <span className="text-muted-foreground">
                        Install minibrain on it, and set MINIBRAIN_WORKER_TOKEN and
                        MINIBRAIN_GATEWAY_TOKEN from secrets/worker_token and secrets/gateway_token
                        in this install's home folder. Then start a worker for training and an
                        engine for serving:
                    </span>
                    <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-sm">
                        {`minibrain worker --api-url ${origin} --pool gpu\nminibrain engine --model ${model} --main-url ${origin} --pool gpu --host 0.0.0.0`}
                    </pre>
                    <span>
                        <Link
                            href="/infrastructure/machines"
                            className="text-primary hover:underline"
                        >
                            See machines and pools in Infrastructure
                        </Link>
                    </span>
                </li>
                <li className="flex flex-col gap-0.5">
                    <span className="font-medium">Or add it now, and run it later</span>
                    <span className="text-muted-foreground">
                        The weights download to this install; train or serve it once a machine that
                        fits has joined a pool.
                    </span>
                </li>
            </ol>
        </div>
    );
}

function CopyNote({ copy, onClear }: { copy: CopySource; onClear: () => void }) {
    const data = copy.datasetName ? `its training data (${copy.datasetName})` : null;
    const recipe = copy.recipe
        ? `its training settings from version ${copy.recipe.version} (${count(copy.recipe.rows)} rows, ${copy.recipe.epochs} ${copy.recipe.epochs === 1 ? "epoch" : "epochs"}), filled in on the Training page`
        : "default training settings, as it has no trained version yet";
    return (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border bg-info-soft px-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
                {`Starts from ${copy.name}: the same base model, ${data ? `${data}, and ` : ""}${recipe}.`}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={onClear}>
                Start fresh
            </Button>
        </div>
    );
}

export function BaseSummary({
    option,
    plan,
    catalog,
    need,
    accepted,
    onAccepted,
    onVariant,
    copy,
    onClearCopy,
    onPickAnother,
}: {
    option: BaseOption | null;
    plan: SourcePlan;
    catalog: CatalogResponse | undefined;
    need: DiskNeed;
    accepted: boolean;
    onAccepted: (accepted: boolean) => void;
    onVariant: (variant: string) => void;
    copy: CopySource | null;
    onClearCopy: () => void;
    onPickAnother: () => void;
}) {
    const variant = option?.kind === "catalogue" ? plan.variant : null;
    const fit = variant?.fit.level ?? option?.fit;
    return (
        <div className="flex flex-col gap-3 text-sm" aria-live="polite">
            {copy && <CopyNote copy={copy} onClear={onClearCopy} />}
            {!option && <PathResult plan={plan} />}
            <DiskLine option={option} need={need} onPickAnother={onPickAnother} />
            {variant?.format === "gguf" && (
                <StatusText tone="warning" className="whitespace-normal">
                    Compressed format: it serves but can't be trained. Pick Full precision to train
                    it.
                </StatusText>
            )}
            {option?.kind === "catalogue" && (
                <VariantLicence
                    plan={plan}
                    accepted={accepted}
                    onAccepted={onAccepted}
                    onVariant={onVariant}
                />
            )}
            {fit === "insufficient" && option && variant && catalog && (
                <ComputeHelp option={{ ...option, variant }} catalog={catalog} />
            )}
        </div>
    );
}
