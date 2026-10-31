import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "obp-ui";
import { usePools, useSystem } from "~/api/queries";
import type { components } from "~/api/schema";
import { DataTable } from "~/components/DataTable";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, Section, Stat } from "~/components/Section";
import { count } from "~/lib/format";
import { bytes, relativeTime } from "~/lib/time";

type LoadedModel = components["schemas"]["LoadedModel"];
type PoolInfo = components["schemas"]["PoolInfo"];
type NodeInfo = components["schemas"]["NodeInfo"];
type ReplicaInfo = components["schemas"]["ReplicaInfo"];

const ENGINE_LABEL: Record<string, string> = {
    sglang: "SGLang",
    mlx: "MLX",
    transformers: "Transformers",
    llamacpp: "llama.cpp",
};

function engineNames(engines: string[]): string {
    return engines.map((engine) => ENGINE_LABEL[engine] ?? engine).join(", ");
}

const NODE_COLUMNS: ColumnDef<NodeInfo, unknown>[] = [
    {
        header: "Machine",
        id: "host",
        cell: ({ row }) => (
            <span className="flex items-center gap-2">
                <span className="font-mono">{row.original.host}</span>
                {!row.original.online && <Badge variant="warning">Offline</Badge>}
            </span>
        ),
    },
    { header: "Role", id: "roles", cell: ({ row }) => row.original.roles.join(", ") },
    {
        header: "Accelerator",
        id: "accelerator",
        cell: ({ row }) => row.original.accelerator_name || row.original.accelerator,
    },
    {
        header: "Memory for models",
        id: "memory",
        cell: ({ row }) => <span className="tabular-nums">{bytes(row.original.usable_bytes)}</span>,
    },
    {
        header: "CPU",
        id: "cpu",
        cell: ({ row }) => (
            <span className="tabular-nums">{`${row.original.cpu_count} cores · ${bytes(row.original.ram_bytes)} RAM`}</span>
        ),
    },
    {
        header: "Engines available",
        id: "engines",
        cell: ({ row }) => engineNames(row.original.engines),
    },
    {
        header: "Seen",
        id: "seen",
        cell: ({ row }) => (row.original.seen_at ? relativeTime(row.original.seen_at) : "Now"),
    },
];

const REPLICA_COLUMNS: ColumnDef<ReplicaInfo, unknown>[] = [
    {
        header: "Model",
        accessorKey: "base_model",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
    { header: "Engine", id: "engine", cell: ({ row }) => engineNames([row.original.engine]) },
    {
        header: "Address",
        accessorKey: "url",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
    {
        header: "State",
        id: "state",
        cell: ({ row }) => (
            <Badge variant={row.original.state === "ready" ? "success" : "neutral"}>
                {row.original.state === "ready" ? "Ready" : "Loading"}
            </Badge>
        ),
    },
    { header: "Seen", id: "seen", cell: ({ row }) => relativeTime(row.original.seen_at) },
];

function plural(value: number, noun: string): string {
    return `${count(value)} ${noun}${value === 1 ? "" : "s"}`;
}

function PoolSection({ pool }: { pool: PoolInfo }) {
    const online = pool.nodes.filter((node) => node.online).length;
    return (
        <Section
            title={pool.name === "local" ? pool.label : `Pool ${pool.label}`}
            caption={`${count(online)} of ${plural(pool.nodes.length, "machine")} online · ${plural(pool.engines.length, "engine")} serving`}
        >
            <div className="flex flex-col gap-3">
                <DataTable columns={NODE_COLUMNS} rows={pool.nodes} empty="No machines yet." />
                {pool.engines.length > 0 && (
                    <DataTable columns={REPLICA_COLUMNS} rows={pool.engines} />
                )}
            </div>
        </Section>
    );
}

const JOB_STATES = ["queued", "running", "succeeded", "failed", "cancelled"];

const LOADED_COLUMNS: ColumnDef<LoadedModel, unknown>[] = [
    {
        header: "Base model",
        accessorKey: "base_model",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
    {
        header: "Device",
        accessorKey: "device",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
    {
        header: "Adapters",
        id: "adapters",
        cell: ({ row }) => (
            <span className="font-mono">
                {row.original.adapters.length ? row.original.adapters.join(", ") : "–"}
            </span>
        ),
    },
];

function gigabytes(megabytes: number | null | undefined): string {
    return megabytes === null || megabytes === undefined
        ? "–"
        : `${(megabytes / 1024).toFixed(1)} GB`;
}

export function ComputePage() {
    const { data, error } = useSystem();
    const pools = usePools();
    const device = data?.device;
    return (
        <Page>
            <PageHeader
                title="Compute"
                caption="Pools of machines that run engines and jobs. Workers and engines join a pool with --pool and report their hardware."
            />
            <ErrorLine error={error ?? pools.error} />
            {(pools.data ?? []).map((pool) => (
                <PoolSection key={pool.name} pool={pool} />
            ))}
            <Section
                title="This main process"
                caption="Inference uses the GPU when there is one; training avoids the Apple GPU, which hangs."
            >
                <div className="flex flex-wrap gap-8">
                    <Stat
                        label="Inference"
                        value={<span className="font-mono">{device?.inference ?? "–"}</span>}
                    />
                    <Stat
                        label="Training"
                        value={<span className="font-mono">{device?.training ?? "–"}</span>}
                    />
                    <Stat label="Accelerator" value={device?.accelerator ?? "None"} />
                    <Stat
                        label="GPU memory used"
                        value={`${gigabytes(device?.memory_used_mb)} of ${gigabytes(device?.memory_total_mb)}`}
                    />
                    <Stat label="CPU cores" value={count(device?.cpu_count)} />
                </div>
            </Section>
            <Section title="Job queue" caption="One worker runs jobs one at a time.">
                <div className="flex flex-wrap gap-8">
                    {JOB_STATES.map((state) => (
                        <Stat
                            key={state}
                            label={state[0].toUpperCase() + state.slice(1)}
                            value={count(data?.jobs[state] ?? 0)}
                        />
                    ))}
                </div>
            </Section>
            <Section
                title="Loaded in memory"
                caption="Base models and adapters the serving process holds right now."
            >
                <DataTable
                    columns={LOADED_COLUMNS}
                    rows={data?.loaded ?? []}
                    empty="Nothing loaded yet; the first request loads the base model."
                />
            </Section>
            <Section title="Libraries">
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                    {Object.entries(data?.libraries ?? {}).map(([name, version]) => (
                        <span key={name}>
                            {name} <span className="font-mono">{version}</span>
                        </span>
                    ))}
                </div>
            </Section>
        </Page>
    );
}
