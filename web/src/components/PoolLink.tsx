import { Link, Popover, PopoverContent, PopoverTrigger, cn } from "obp-ui";
import { type ReactNode, useRef, useState } from "react";
import { usePools } from "~/api/queries";
import type { components } from "~/api/schema";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { bytes } from "~/lib/time";

type PoolInfo = components["schemas"]["PoolInfo"];
type NodeInfo = components["schemas"]["NodeInfo"];

const MEMORY_LABELS: Record<string, string> = {
    cuda: "GPU memory",
    rocm: "GPU memory",
    xpu: "GPU memory",
    mps: "unified memory",
};

const ENGINE_LABELS: Record<string, string> = {
    sglang: "SGLang",
    vllm: "vLLM",
    mlx: "MLX",
    transformers: "Transformers",
    llamacpp: "llama.cpp",
};

export function poolHref(name: string): string {
    return `/infrastructure/machines#pool-${encodeURIComponent(name)}`;
}

function plural(value: number, noun: string): string {
    return `${count(value)} ${noun}${value === 1 ? "" : "s"}`;
}

function memoryOf(node: NodeInfo): string {
    if (node.usable_bytes === null) {
        return "memory not reported";
    }
    return `${bytes(node.usable_bytes)} ${MEMORY_LABELS[node.accelerator] ?? "RAM"}`;
}

function usedFor(pool: PoolInfo): string | null {
    const roles = new Set(pool.nodes.filter((node) => node.online).flatMap((node) => node.roles));
    const serving = roles.has("engine") || roles.has("main") || pool.engines.length > 0;
    const jobs = roles.has("worker");
    if (serving && jobs) {
        return "Serving and jobs";
    }
    if (serving) {
        return "Serving";
    }
    return jobs ? "Jobs" : null;
}

function engineText(pool: PoolInfo): string {
    if (pool.engines.length === 0) {
        return "No engines serving";
    }
    const names = [
        ...new Set(pool.engines.map((item) => ENGINE_LABELS[item.engine] ?? item.engine)),
    ];
    return `${plural(pool.engines.length, "engine")} serving · ${names.join(", ")}`;
}

function MachineRow({ node }: { node: NodeInfo }) {
    return (
        <li className="flex flex-col gap-0.5">
            <span className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-mono">{node.host}</span>
                <StatusText tone={node.online ? "success" : "warning"} className="text-sm">
                    {node.online ? "Online" : "Offline"}
                </StatusText>
            </span>
            <span className="truncate text-sm text-muted-foreground tabular-nums">
                {[node.accelerator_name || node.accelerator, memoryOf(node)]
                    .filter(Boolean)
                    .join(" · ")}
            </span>
        </li>
    );
}

export function PoolCard({
    name,
    pool,
    details,
}: {
    name: string;
    pool: PoolInfo | undefined;
    details?: ReactNode;
}) {
    const online = pool?.nodes.filter((node) => node.online).length ?? 0;
    const purpose = pool ? usedFor(pool) : null;
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
                <span className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{`Pool ${name}`}</span>
                    {pool && (
                        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                            {`${count(online)} of ${plural(pool.nodes.length, "machine")} online`}
                        </span>
                    )}
                </span>
                {pool && pool.label !== name && (
                    <span className="text-sm text-muted-foreground">{pool.label}</span>
                )}
            </div>
            {pool ? (
                <>
                    {pool.nodes.length > 0 && (
                        <ul className="flex flex-col gap-2">
                            {pool.nodes.map((node) => (
                                <MachineRow key={node.id} node={node} />
                            ))}
                        </ul>
                    )}
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                        {purpose && (
                            <>
                                <dt className="text-muted-foreground">Used for</dt>
                                <dd>{purpose}</dd>
                            </>
                        )}
                        <dt className="text-muted-foreground">Engines</dt>
                        <dd className="tabular-nums">{engineText(pool)}</dd>
                    </dl>
                </>
            ) : (
                <span className="text-sm text-muted-foreground">
                    No machine in this pool has reported yet.
                </span>
            )}
            {details && (
                <div className="flex flex-col gap-1 border-t pt-2 text-sm tabular-nums">
                    {details}
                </div>
            )}
            <Link href={poolHref(name)} className="text-sm text-primary hover:underline">
                Open in Infrastructure →
            </Link>
        </div>
    );
}

export function usePool(name: string | null | undefined): PoolInfo | undefined {
    const pools = usePools();
    return name ? pools.data?.find((item) => item.name === name) : undefined;
}

export function PoolLink({
    name,
    machine,
    details,
    align = "start",
    className,
}: {
    name: string;
    machine?: string | null;
    details?: ReactNode;
    align?: "start" | "center" | "end";
    className?: string;
}) {
    const pool = usePool(name);
    const [open, setOpen] = useState(false);
    const card = useRef<HTMLDivElement>(null);
    return (
        <span className={cn("inline-flex max-w-full min-w-0 items-baseline gap-1.5", className)}>
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger
                    openOnHover
                    delay={150}
                    nativeButton={false}
                    render={
                        <Link
                            href={poolHref(name)}
                            role="link"
                            onFocus={() => setOpen(true)}
                            onBlur={(event) => {
                                if (!card.current?.contains(event.relatedTarget)) {
                                    setOpen(false);
                                }
                            }}
                            className="truncate text-primary underline-offset-2 hover:underline"
                        />
                    }
                >
                    {name}
                </PopoverTrigger>
                <PopoverContent
                    align={align}
                    className="w-80"
                    initialFocus={false}
                    finalFocus={false}
                    ref={card}
                >
                    <PoolCard name={name} pool={pool} details={details} />
                </PopoverContent>
            </Popover>
            {machine && (
                <span className="min-w-0 truncate text-muted-foreground">
                    {"· "}
                    <span className="font-mono">{machine}</span>
                </span>
            )}
        </span>
    );
}

export function PoolList({ names, details }: { names: string[]; details?: ReactNode }) {
    const [first, ...rest] = names;
    if (!first) {
        return null;
    }
    const also = rest.length > 0 && (
        <span>
            {"Also: "}
            {rest.map((name, index) => (
                <span key={name}>
                    {index > 0 && ", "}
                    <Link href={poolHref(name)} className="text-primary hover:underline">
                        {name}
                    </Link>
                </span>
            ))}
        </span>
    );
    return (
        <span className="inline-flex flex-wrap items-baseline gap-x-1">
            <PoolLink
                name={first}
                details={
                    also || details ? (
                        <>
                            {details}
                            {also}
                        </>
                    ) : undefined
                }
            />
            {rest.length > 0 && <span>{`and ${count(rest.length)} more`}</span>}
        </span>
    );
}

export type Place = { pool: string; host?: string | null };

function byPool(places: Place[]): [string, string[]][] {
    const groups = new Map<string, string[]>();
    for (const place of places) {
        const hosts = groups.get(place.pool) ?? [];
        if (place.host && !hosts.includes(place.host)) {
            hosts.push(place.host);
        }
        groups.set(place.pool, hosts);
    }
    return [...groups.entries()];
}

export function PoolPlaces({
    places,
    machines = true,
    align,
}: {
    places: Place[];
    machines?: boolean;
    align?: "start" | "center" | "end";
}) {
    return (
        <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-3">
            {byPool(places).map(([pool, hosts]) => (
                <PoolLink
                    key={pool}
                    name={pool}
                    align={align}
                    machine={machines && hosts.length > 0 ? hosts.join(", ") : null}
                />
            ))}
        </span>
    );
}
