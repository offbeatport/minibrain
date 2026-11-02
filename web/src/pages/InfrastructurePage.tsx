import { useRouterState } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Cpu, Gauge, HardDrive, MemoryStick, Network, Server, TriangleAlert } from "lucide-react";
import { Badge, DataGrid, Link, Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import { useInfrastructure, usePools, useSystem } from "~/api/queries";
import type { components } from "~/api/schema";
import { PageHeader } from "~/components/PageHeader";
import { ErrorLine, Page, PanelSection, PanelSections, Stat } from "~/components/Section";
import { SideMenuLayout } from "~/components/SideMenu";
import { StatusText } from "~/components/models/StatusText";
import { count } from "~/lib/format";
import { bytes, relativeTime } from "~/lib/time";

type LoadedModel = components["schemas"]["LoadedModel"];
type PoolInfo = components["schemas"]["PoolInfo"];
type NodeInfo = components["schemas"]["NodeInfo"];
type ReplicaInfo = components["schemas"]["ReplicaInfo"];
type StoreInfo = components["schemas"]["StoreInfo"];
type InfrastructureInfo = components["schemas"]["InfrastructureInfo"];

const LOOPS: Record<string, string> = {
    single: "Runs here",
    leader: "Runs here (leader)",
    standby: "Standby",
};

const ENGINE_LABEL: Record<string, string> = {
    sglang: "SGLang",
    mlx: "MLX",
    transformers: "Transformers",
    llamacpp: "llama.cpp",
};

function engineNames(engines: string[]): string {
    return engines.map((engine) => ENGINE_LABEL[engine] ?? engine).join(", ");
}

const COMPARED = ["minibrain", "torch", "transformers", "peft"];

function release(value: string): string {
    return value.split("+")[0];
}

function differences(versions: Record<string, string>, main: Record<string, string>): string[] {
    return COMPARED.filter(
        (name) => versions[name] && main[name] && release(versions[name]) !== release(main[name]),
    ).map((name) => `${name} ${versions[name]} (main has ${main[name]})`);
}

function VersionCell({ node }: { node: NodeInfo }) {
    const versions = node.versions ?? {};
    const listed = Object.entries(versions)
        .map(([name, value]) => `${name} ${value}`)
        .join(" · ");
    return (
        <span className="flex items-center gap-2">
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="rounded-sm font-mono">{versions.minibrain ?? "–"}</span>
                </TooltipTrigger>
                <TooltipContent>{listed || "Not reported"}</TooltipContent>
            </Tooltip>
        </span>
    );
}

function VersionWarning({ node, main }: { node: NodeInfo; main: Record<string, string> }) {
    const differs = node.roles.includes("main") ? [] : differences(node.versions ?? {}, main);
    if (differs.length === 0) {
        return null;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="rounded-sm">
                    <Badge variant="warning">Version differs</Badge>
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-normal">
                {differs.join("; ")}
            </TooltipContent>
        </Tooltip>
    );
}

function nodeColumns(main: Record<string, string>): ColumnDef<NodeInfo, unknown>[] {
    return [
        {
            header: "Machine",
            id: "host",
            enableHiding: false,
            cell: ({ row }) => (
                <span className="flex items-center gap-2">
                    <span className="font-mono">{row.original.host}</span>
                    {!row.original.online && <Badge variant="warning">Offline</Badge>}
                    <VersionWarning node={row.original} main={main} />
                </span>
            ),
        },
        ...NODE_COLUMNS,
        {
            header: "Version",
            id: "version",
            cell: ({ row }) => <VersionCell node={row.original} />,
        },
    ];
}

const NODE_COLUMNS: ColumnDef<NodeInfo, unknown>[] = [
    { header: "Role", id: "roles", cell: ({ row }) => row.original.roles.join(", ") },
    {
        header: "Accelerator",
        id: "hardware",
        cell: ({ row }) => row.original.accelerator_name || row.original.accelerator,
    },
    {
        header: "Memory for models",
        id: "usable",
        cell: ({ row }) => <span className="tabular-nums">{bytes(row.original.usable_bytes)}</span>,
    },
    {
        header: "CPU and RAM",
        id: "cpu",
        cell: ({ row }) => (
            <span className="tabular-nums">{`${row.original.cpu_count} cores · ${bytes(row.original.ram_bytes)}`}</span>
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

function PoolSection({ pool, main }: { pool: PoolInfo; main: Record<string, string> }) {
    const online = pool.nodes.filter((node) => node.online).length;
    return (
        <PanelSection
            icon={Server}
            title={pool.name === "local" ? pool.label : `Pool ${pool.label}`}
            description={`${count(online)} of ${plural(pool.nodes.length, "machine")} online · ${plural(pool.engines.length, "engine")} serving`}
        >
            <div className="flex flex-col gap-3">
                <DataGrid
                    columns={nodeColumns(main)}
                    rows={pool.nodes}
                    empty="No machines yet."
                    storageKey="minibrain.machines.columns"
                    columnPicker
                    hiddenColumns={["cpu", "engines", "version"]}
                    dropOrder={["engines", "cpu", "seen", "version", "usable", "roles"]}
                />
                {pool.engines.length > 0 && (
                    <DataGrid columns={REPLICA_COLUMNS} rows={pool.engines} />
                )}
            </div>
        </PanelSection>
    );
}

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

const SETUPS: Record<InfrastructureInfo["setup"], { title: string; body: string }> = {
    one_machine: {
        title: "One machine",
        body: "main, the gateway, the worker and engines all run here, with SQLite and local folders.",
    },
    remote_gpus: {
        title: "Local main, remote GPUs",
        body: "main and its gateway run here; workers and engines on other machines join pools and pull work from main.",
    },
    distributed: {
        title: "Distributed",
        body: "Separate services: mains share a Postgres database, and gateways and GPU pools scale on their own.",
    },
};

function hostsWith(pools: PoolInfo[], role: string): string[] {
    const hosts = pools.flatMap((pool) =>
        pool.nodes
            .filter((node) => node.online && node.roles.includes(role))
            .map((node) => node.host),
    );
    return [...new Set(hosts)];
}

function Hosts({ hosts, none }: { hosts: string[]; none: string }) {
    if (hosts.length === 0) {
        return <span className="text-muted-foreground">{none}</span>;
    }
    return <span className="font-mono">{hosts.join(", ")}</span>;
}

function SetupSection({
    info,
    pools,
    loops,
}: {
    info: InfrastructureInfo | undefined;
    pools: PoolInfo[];
    loops: string | undefined;
}) {
    const setup = info ? SETUPS[info.setup] : null;
    const replicas = pools.flatMap((pool) => pool.engines);
    const engineHosts = [...new Set(replicas.map((replica) => replica.host))];
    return (
        <PanelSection icon={Network} title="Setup">
            <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-0.5">
                    <span className="text-base font-semibold">{setup?.title ?? "…"}</span>
                    <span className="text-sm text-muted-foreground">{setup?.body}</span>
                </div>
                <div className="grid gap-4 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4">
                    <Stat
                        label="main"
                        value={
                            <span className="flex flex-col font-normal">
                                <span className="font-mono">{info?.host ?? "–"}</span>
                                <span className="text-sm text-muted-foreground">
                                    {LOOPS[loops ?? "single"]}
                                </span>
                            </span>
                        }
                    />
                    <Stat
                        label="Gateway"
                        value={<span className="font-normal">Inside main</span>}
                    />
                    <Stat
                        label="Workers"
                        value={
                            <span className="font-normal">
                                <Hosts hosts={hostsWith(pools, "worker")} none="None online" />
                            </span>
                        }
                    />
                    <Stat
                        label={`Engines · ${count(replicas.length)}`}
                        value={
                            <span className="font-normal">
                                <Hosts hosts={engineHosts} none="None running" />
                            </span>
                        }
                    />
                </div>
            </div>
        </PanelSection>
    );
}

const STORE_KIND: Record<StoreInfo["kind"], string> = {
    sqlite: "SQLite file",
    postgres: "Postgres",
    folder: "Folder",
};

const STORE_COLUMNS: ColumnDef<StoreInfo, unknown>[] = [
    { header: "Holds", accessorKey: "name" },
    { header: "Kind", id: "kind", cell: ({ row }) => STORE_KIND[row.original.kind] },
    {
        header: "Where",
        id: "location",
        cell: ({ row }) => (
            <span className="block max-w-64 truncate font-mono" title={row.original.location}>
                {row.original.location}
            </span>
        ),
    },
    {
        header: "Used",
        id: "used",
        cell: ({ row }) => <span className="tabular-nums">{bytes(row.original.used_bytes)}</span>,
    },
    {
        header: "Free on that disk",
        id: "free",
        cell: ({ row }) =>
            row.original.free_bytes === null || row.original.free_bytes === undefined ? (
                <span className="text-muted-foreground">Managed</span>
            ) : (
                <span className="tabular-nums">
                    {`${bytes(row.original.free_bytes)} of ${bytes(row.original.total_bytes)}`}
                </span>
            ),
    },
];

function StorageSection({ info }: { info: InfrastructureInfo | undefined }) {
    return (
        <PanelSection icon={HardDrive} title="Storage">
            <div className="flex flex-col gap-3">
                <DataGrid columns={STORE_COLUMNS} rows={info?.stores ?? []} />
                <p className="text-sm text-muted-foreground">
                    Everything lives under{" "}
                    <span className="font-mono text-foreground">{info?.home ?? "…"}</span>. To move
                    the install, set{" "}
                    <span className="font-mono text-foreground">MINIBRAIN_HOME</span> before
                    starting minibrain.
                </p>
            </div>
        </PanelSection>
    );
}

function gigabytes(megabytes: number | null | undefined): string {
    return megabytes === null || megabytes === undefined
        ? "–"
        : `${(megabytes / 1024).toFixed(1)} GB`;
}

const SECTIONS = [
    { label: "Overview", href: "/infrastructure", icon: Gauge },
    { label: "Machines", href: "/infrastructure/machines", icon: Server },
    { label: "Storage", href: "/infrastructure/storage", icon: HardDrive },
];

const LOW_FREE_SHARE = 0.1;
const LOW_FREE_BYTES = 10 * 1024 ** 3;

type Warning = { text: string; href: string };

function warningsFor(
    pools: PoolInfo[],
    main: Record<string, string>,
    info: InfrastructureInfo | undefined,
): Warning[] {
    const nodes = pools.flatMap((pool) => pool.nodes);
    const offline = nodes.filter((node) => !node.online);
    const drifting = nodes.filter(
        (node) => !node.roles.includes("main") && differences(node.versions ?? {}, main).length > 0,
    );
    const low = (info?.stores ?? []).filter(
        (store) =>
            store.free_bytes !== null &&
            store.free_bytes !== undefined &&
            store.total_bytes &&
            (store.free_bytes < LOW_FREE_BYTES ||
                store.free_bytes / store.total_bytes < LOW_FREE_SHARE),
    );
    return [
        ...offline.map((node) => ({
            text: `${node.host} is offline (last seen ${node.seen_at ? relativeTime(node.seen_at) : "never"})`,
            href: "/infrastructure/machines",
        })),
        ...drifting.map((node) => ({
            text: `${node.host} runs different library versions from main`,
            href: "/infrastructure/machines",
        })),
        ...low.map((store) => ({
            text: `${store.name}: only ${bytes(store.free_bytes)} free on its disk`,
            href: "/infrastructure/storage",
        })),
    ];
}

function Overview({
    info,
    pools,
    loops,
    main,
}: {
    info: InfrastructureInfo | undefined;
    pools: PoolInfo[];
    loops: string | undefined;
    main: Record<string, string>;
}) {
    const nodes = pools.flatMap((pool) => pool.nodes);
    const engines = pools.flatMap((pool) => pool.engines);
    const models = info?.stores.find((store) => store.name === "Model files");
    const warnings = warningsFor(pools, main, info);
    return (
        <PanelSections>
            <SetupSection info={info} pools={pools} loops={loops} />
            <PanelSection icon={Gauge} title="At a glance">
                <div className="flex flex-wrap gap-8">
                    <Stat
                        label="Machines online"
                        value={`${count(nodes.filter((node) => node.online).length)} of ${count(nodes.length)}`}
                    />
                    <Stat label="Engines serving" value={count(engines.length)} />
                    <Stat label="Pools" value={count(pools.length)} />
                    <Stat
                        label="Free for model files"
                        value={
                            models?.free_bytes === null || models?.free_bytes === undefined
                                ? "Managed"
                                : bytes(models.free_bytes)
                        }
                    />
                </div>
            </PanelSection>
            <PanelSection icon={TriangleAlert} title="Needs a look">
                {warnings.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        Nothing: every machine is online and up to date.
                    </p>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {warnings.map((warning) => (
                            <li
                                key={warning.text}
                                className="flex flex-wrap items-center gap-2 text-sm"
                            >
                                <StatusText tone="warning">{warning.text}</StatusText>
                                <Link href={warning.href} className="text-primary hover:underline">
                                    Open
                                </Link>
                            </li>
                        ))}
                    </ul>
                )}
            </PanelSection>
        </PanelSections>
    );
}

export function InfrastructurePage() {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const { data, error } = useSystem();
    const pools = usePools();
    const infrastructure = useInfrastructure();
    const device = data?.device;
    const main =
        (pools.data ?? []).flatMap((pool) => pool.nodes).find((node) => node.roles.includes("main"))
            ?.versions ?? {};
    const active = SECTIONS.find((item) => item.href === pathname)?.href ?? "/infrastructure";
    return (
        <Page>
            <PageHeader
                title="Infrastructure"
                caption="Where minibrain runs and where it keeps its data."
            />
            <ErrorLine error={error ?? pools.error ?? infrastructure.error} />
            <SideMenuLayout label="Infrastructure pages" items={SECTIONS} active={active}>
                {active === "/infrastructure" && (
                    <Overview
                        info={infrastructure.data}
                        pools={pools.data ?? []}
                        loops={data?.loops}
                        main={main}
                    />
                )}
                {active === "/infrastructure/machines" && (
                    <PanelSections>
                        {(pools.data ?? []).map((pool) => (
                            <PoolSection key={pool.name} pool={pool} main={main} />
                        ))}
                        <PanelSection
                            icon={Cpu}
                            title="This main process"
                            description="Inference uses the GPU when there is one; training avoids the Apple GPU, which hangs."
                        >
                            <div className="flex flex-wrap gap-8">
                                <Stat
                                    label="Inference"
                                    value={
                                        <span className="font-mono">
                                            {device?.inference ?? "–"}
                                        </span>
                                    }
                                />
                                <Stat
                                    label="Training"
                                    value={
                                        <span className="font-mono">{device?.training ?? "–"}</span>
                                    }
                                />
                                <Stat label="Accelerator" value={device?.accelerator ?? "None"} />
                                <Stat
                                    label="GPU memory used"
                                    value={`${gigabytes(device?.memory_used_mb)} of ${gigabytes(device?.memory_total_mb)}`}
                                />
                                <Stat label="CPU cores" value={count(device?.cpu_count)} />
                                <Stat
                                    label="Background loops"
                                    value={LOOPS[data?.loops ?? "single"]}
                                />
                            </div>
                        </PanelSection>
                        <PanelSection
                            icon={MemoryStick}
                            title="Loaded in memory"
                            description="Base models and adapters the serving process holds right now."
                        >
                            <DataGrid
                                columns={LOADED_COLUMNS}
                                rows={data?.loaded ?? []}
                                empty="Nothing loaded yet; the first request loads the base model."
                            />
                        </PanelSection>
                    </PanelSections>
                )}
                {active === "/infrastructure/storage" && (
                    <PanelSections>
                        <StorageSection info={infrastructure.data} />
                    </PanelSections>
                )}
            </SideMenuLayout>
        </Page>
    );
}
