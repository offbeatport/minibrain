import {
    Button,
    CodeBlock,
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
import { StatusText } from "~/components/models/StatusText";
import { modelPageHref } from "~/lib/modelLinks";
import { PathResult, type SourcePlan } from "./BaseSource";
import { type BaseOption, addedKey, gigabytes } from "./baseOptions";
import { runnable } from "./runsHere";

const LOW_SPACE = 5 * 1024 ** 3;

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
                            <Link href={modelPageHref(option.baseKey)}>Repair it</Link>
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
    if (need.free === null) {
        return null;
    }
    if (need.size > need.free) {
        return (
            <StatusText tone="destructive" className="whitespace-normal">
                {`Not enough disk space, short by ${gigabytes(need.size - need.free)} GB. Free up space on the model files disk first.`}
            </StatusText>
        );
    }
    const left = need.free - need.size;
    if (left >= LOW_SPACE) {
        return null;
    }
    return (
        <StatusText tone="warning" className="whitespace-normal tabular-nums">
            {`Low on disk space: only ${gigabytes(left)} GB left after this ${need.verb}`}
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
                <div className="flex min-w-0 flex-col gap-5">
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
                        <CodeBlock code={commands} language="bash" copyLabel="Copy the commands" />
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
            <p className="text-muted-foreground">
                Add it now and run it on a machine that fits, or pick a smaller one.
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

export function BaseSummary({ option, plan }: { option: BaseOption | null; plan: SourcePlan }) {
    if (option) {
        return null;
    }
    return (
        <div className="flex flex-col gap-3" aria-live="polite">
            <PathResult plan={plan} />
        </div>
    );
}
