import type { Placement, PoolPlacement } from "~/api/client";
import { FormRow } from "~/components/FormRows";
import { type PickOption, PickSelect } from "~/components/PickSelect";
import { PoolLink } from "~/components/PoolLink";
import { bytes } from "~/lib/time";

export const AUTO_POOL = "auto";

function gigabytes(value: number): string {
    const gib = value / 1024 ** 3;
    return gib.toFixed(gib >= 10 ? 0 : 1);
}

function shareText(pool: PoolPlacement): string | null {
    const { needed_bytes, available_bytes } = pool.fit;
    return available_bytes === null
        ? null
        : `${gigabytes(needed_bytes)} of ${gigabytes(available_bytes)} GB`;
}

export function fitText(pool: PoolPlacement): string {
    if (pool.fit.level === "insufficient") {
        return "Too small";
    }
    if (pool.machines === 0) {
        return "No machine online";
    }
    const share = shareText(pool);
    if (share === null) {
        return `Needs ${bytes(pool.fit.needed_bytes)}`;
    }
    return pool.fit.level === "limited" ? `Tight · ${share}` : `Runs · ${share}`;
}

function needsText(pool: PoolPlacement | undefined): string | null {
    if (!pool) {
        return null;
    }
    if (pool.machines === 0) {
        return "waits for a machine to come online";
    }
    const share = shareText(pool);
    return share ? `needs ${share}` : `needs ${bytes(pool.fit.needed_bytes)}`;
}

export function resolvedPool(placement: Placement | undefined, value: string): string | null {
    return value === AUTO_POOL ? (placement?.automatic ?? null) : value;
}

export function initialPool(placement: Placement | undefined): string {
    return placement?.pool ?? AUTO_POOL;
}

function options(placement: Placement): PickOption[] {
    const auto: PickOption = {
        value: AUTO_POOL,
        label: placement.automatic ? `Automatic · ${placement.automatic}` : "Automatic",
        meta: placement.automatic ? undefined : "Fits nowhere",
        disabled: !placement.automatic,
    };
    return [
        auto,
        ...placement.pools.map((pool, index) => ({
            value: pool.name,
            label: pool.name,
            meta: fitText(pool),
            disabled: pool.fit.level === "insufficient",
            separated: index === 0,
        })),
    ];
}

export function PoolRow({
    placement,
    value,
    onChange,
}: {
    placement: Placement | undefined;
    value: string;
    onChange: (value: string) => void;
}) {
    const target = resolvedPool(placement, value);
    const needs = needsText(placement?.pools.find((pool) => pool.name === target));
    return (
        <FormRow id="deploy-pool" label="Pool" align="start">
            <PickSelect
                id="deploy-pool"
                compact
                value={placement ? value : null}
                placeholder="Checking pools…"
                disabled={!placement}
                options={placement ? options(placement) : []}
                onChange={onChange}
            />
            {target && (
                <span className="text-sm text-muted-foreground">
                    {"Runs on "}
                    <PoolLink name={target} />
                    {needs && ` · ${needs}`}
                    {placement?.pool && placement.pool !== target && (
                        <>
                            {" · moves from "}
                            <PoolLink name={placement.pool} />
                        </>
                    )}
                </span>
            )}
        </FormRow>
    );
}
