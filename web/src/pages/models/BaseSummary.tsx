import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Link,
} from "obp-ui";
import { useState } from "react";
import type { CatalogEntry, CatalogResponse } from "~/api/client";
import { useCatalog } from "~/api/queries";
import { CopyButton } from "~/components/CopyButton";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { bytes } from "~/lib/time";
import { PathResult, type SourcePlan } from "./BaseSource";
import { type BaseOption, addedKey, gigabytes } from "./baseOptions";
import { runnable } from "./runsHere";

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

export function DiskLine({
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
    const fits = runnable(fit);
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

function RunElsewhere({
    option,
    catalog,
    open,
    onOpenChange,
}: {
    option: BaseOption;
    catalog: CatalogResponse;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const { entry, variant } = option;
    if (!entry || !variant) {
        return null;
    }
    const origin = window.location.origin;
    const others = catalog.pools.filter((pool) => pool.name !== catalog.pool);
    const model = option.baseKey ?? addedKey(entry, variant);
    const commands = `minibrain worker --api-url ${origin} --pool gpu\nminibrain engine --model ${model} --main-url ${origin} --pool gpu --host 0.0.0.0`;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{`Where to run ${option.name}`}</DialogTitle>
                    <DialogDescription>
                        You can add it now either way: the weights download to this install, and it
                        trains or serves once a machine that fits joins a pool.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-5 text-sm">
                    <section className="flex min-w-0 flex-col gap-1.5">
                        <h3 className="font-medium">A compute pool that fits</h3>
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
                            <p className="text-muted-foreground">
                                No other compute pool has a machine online yet.
                            </p>
                        )}
                    </section>
                    <section className="flex min-w-0 flex-col gap-1.5">
                        <h3 className="font-medium">A GPU machine in a new pool</h3>
                        <p className="text-muted-foreground">
                            Install minibrain on it and set MINIBRAIN_WORKER_TOKEN and
                            MINIBRAIN_GATEWAY_TOKEN from secrets/worker_token and
                            secrets/gateway_token in this install's home folder. Then start a worker
                            for training and an engine for serving:
                        </p>
                        <div className="flex items-start gap-2 rounded-md border bg-muted px-3 py-2">
                            <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-sm">
                                {commands}
                            </pre>
                            <CopyButton value={commands} label="Copy the commands" />
                        </div>
                        <Link
                            href="/infrastructure/machines"
                            className="w-fit text-primary hover:underline"
                        >
                            See machines and pools in Infrastructure
                        </Link>
                    </section>
                </div>
            </DialogContent>
        </Dialog>
    );
}

export function ComputeHelp({
    option,
    catalog,
    onPickAnother,
}: {
    option: BaseOption;
    catalog: CatalogResponse;
    onPickAnother: () => void;
}) {
    const [open, setOpen] = useState(false);
    return (
        <div className="flex flex-col gap-2.5">
            <p className="text-sm text-muted-foreground">
                {`Too big for ${catalog.hardware.machine}. Add it now and run it on a machine that fits, or pick a smaller one.`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
                    Where to run it
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={onPickAnother}>
                    Pick a smaller one
                </Button>
            </div>
            <RunElsewhere option={option} catalog={catalog} open={open} onOpenChange={setOpen} />
        </div>
    );
}

function CopyNote({ copy, onClear }: { copy: CopySource; onClear: () => void }) {
    const data = copy.datasetName ? `its training data (${copy.datasetName})` : null;
    const recipe = copy.recipe
        ? `its training settings from version ${copy.recipe.version} (${count(copy.recipe.rows)} rows, ${copy.recipe.epochs} ${copy.recipe.epochs === 1 ? "epoch" : "epochs"}), used when you train it`
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
    copy,
    onClearCopy,
}: {
    option: BaseOption | null;
    plan: SourcePlan;
    copy: CopySource | null;
    onClearCopy: () => void;
}) {
    if (!copy && option) {
        return null;
    }
    return (
        <div className="flex flex-col gap-3 text-sm" aria-live="polite">
            {copy && <CopyNote copy={copy} onClear={onClearCopy} />}
            {!option && <PathResult plan={plan} />}
        </div>
    );
}
