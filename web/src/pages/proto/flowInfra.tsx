import { Layers, Plus, Server } from "lucide-react";
import {
    Badge,
    Button,
    Link,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    cn,
} from "obp-ui";
import { type ReactNode, useEffect, useState } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page, PanelSection, PanelSections } from "~/components/Section";
import { ProgressBar, StatusText, type Tone } from "~/components/models/StatusText";
import {
    type Gpu,
    type JobLoad,
    type LoadedEngine,
    type Machine,
    type Pool,
    type PoolUse,
    STORAGE_GB,
    USE_LABELS,
    adapterCount,
    engineMemoryOf,
    enginesOf,
    hardware,
    jobLoads,
    machinePools,
    queuedJobs,
    round,
    setPoolUse,
    slotReserve,
    slotTotal,
    slotUsage,
    targetName,
    useCompute,
    useNow,
    usesJobs,
} from "./flowCompute";
import { AddComputeDialog, MachineSheet } from "./flowInfraDialogs";
import { useCan } from "./flowOverlays";
import {
    type FlowState,
    STEP_MS,
    downloadProgress,
    jobHref,
    markVisited,
    useFlowState,
} from "./modelsFlowData";

type Compute = ReturnType<typeof useCompute>;

export type World = {
    state: FlowState;
    compute: Compute;
    engines: LoadedEngine[];
    jobs: JobLoad[];
    now: number;
};

function useWorld(): World {
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const now = useNow(500);
    return {
        state,
        compute,
        engines: enginesOf(state, compute, now),
        jobs: jobLoads(state, compute),
        now,
    };
}

function onSlot(machine: Machine, gpu: Gpu | null) {
    return (item: { placement: { machine: string; gpu: number | null } }) =>
        item.placement.machine === machine.id && item.placement.gpu === (gpu?.index ?? null);
}

function countdown(until: number, now: number): string {
    const seconds = Math.max(0, Math.round((until - now) / 1000));
    return seconds >= 60 ? `unloads in ${Math.ceil(seconds / 60)} min` : `unloads in ${seconds} s`;
}

function plural(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}

function servingText(engine: LoadedEngine): string {
    const settled = engine.adapters.filter((adapter) => !adapter.loading);
    const names = settled.map((adapter) =>
        adapter.version === "no version deployed"
            ? `${adapter.name} (no version deployed yet, answers as the base)`
            : `${adapter.name} ${adapter.version}`,
    );
    if (engine.servesBase) {
        names.push("the base");
    }
    if (names.length === 0) {
        return "";
    }
    const adapters = settled.filter((adapter) => adapter.trained).length;
    return `serving ${names.join(", ")}${adapters > 0 ? ` (${plural(adapters, "adapter")})` : ""}`;
}

type Line = {
    key: string;
    tone: Tone;
    text: ReactNode;
    meta?: ReactNode;
    memory: number | null;
    progress?: number;
    kind: "serving" | "job" | "demand" | "loading" | "idle" | "system";
};

function RolloutLink({ id, text }: { id: number | null; text: string }) {
    if (id === null) {
        return null;
    }
    return (
        <Link href={jobHref(id)} className="relative z-10 text-primary hover:underline">
            {text}
        </Link>
    );
}

function withRollout(meta: string, id: number | null, text: string): ReactNode {
    if (id === null) {
        return meta;
    }
    return (
        <>
            {meta}
            {" · "}
            <RolloutLink id={id} text={text} />
        </>
    );
}

function engineLine(engine: LoadedEngine, now: number): Line {
    const memory = engineMemoryOf(engine);
    const adding = engine.adapters.filter((adapter) => adapter.loading);
    if (engine.state === "loading") {
        const forWhom =
            adding.length > 0 ? ` for ${adding.map((adapter) => adapter.name).join(", ")}` : "";
        return {
            key: engine.key,
            tone: "info",
            kind: "loading",
            memory,
            progress: engine.progress,
            text: `Loading ${engine.serve.label}${forWhom} · ${Math.round(engine.progress * 100)}%`,
            meta: engine.demand
                ? `On demand for the ${engine.demand.reason}`
                : withRollout("Deploying", engine.job, `rollout #${engine.job}`),
        };
    }
    if (engine.state === "unloading") {
        return {
            key: engine.key,
            tone: "warning",
            kind: "loading",
            memory,
            text: `Unloading ${engine.serve.label}`,
            meta: engine.demand
                ? "Idle for 5 min and nothing deployed needs it"
                : withRollout(
                      "Undeployed; nothing else needs this base",
                      engine.job,
                      `rollout #${engine.job}`,
                  ),
        };
    }
    const serving = servingText(engine);
    const traffic =
        engine.today > 0 || engine.recent > 0
            ? `${plural(engine.today, "request")} today${engine.recent > 0 ? ` · ${engine.recent} in the last minute` : ""}`
            : null;
    const addingText =
        adding.length > 0
            ? `Adding the ${adding.map((adapter) => adapter.name).join(", ")} adapter`
            : null;
    if (engine.demand && !serving) {
        return {
            key: engine.key,
            tone: "neutral",
            kind: "demand",
            memory,
            text: `${engine.serve.label} · on demand for the ${engine.demand.reason} · ${countdown(engine.demand.until, now)}`,
            meta:
                engine.recent > 0
                    ? `${engine.recent} in the last minute`
                    : "Loaded when someone tried it",
        };
    }
    return {
        key: engine.key,
        tone: "success",
        kind: "serving",
        memory,
        text: (
            <>
                {engine.serve.label}
                {serving && <span className="text-muted-foreground">{` · ${serving}`}</span>}
            </>
        ),
        meta:
            adding.length > 0 && engine.job !== null
                ? withRollout(addingText ?? "", engine.job, `rollout #${engine.job}`)
                : withRollout(
                      [addingText, traffic].filter(Boolean).join(" · ") || "No requests today",
                      engine.rollout,
                      `deployed by rollout #${engine.rollout}`,
                  ),
    };
}

function jobLine(load: JobLoad): Line {
    return {
        key: `job-${load.job.id}`,
        tone: "info",
        kind: "job",
        memory: load.memory,
        progress: load.progress,
        text: (
            <Link href={jobHref(load.job.id)} className="relative z-10 hover:underline">
                {[load.label, `${Math.round(load.progress * 100)}%`, load.left]
                    .filter(Boolean)
                    .join(" · ")}
            </Link>
        ),
        meta: `Job #${load.job.id}`,
    };
}

const DOT: Record<Tone, string> = {
    success: "bg-success",
    info: "bg-info",
    warning: "bg-warning",
    destructive: "bg-destructive",
    neutral: "bg-faint",
};

const SEGMENT: Record<Line["kind"], string> = {
    serving: "bg-success",
    job: "bg-info",
    demand: "bg-muted-foreground",
    loading: "bg-info/40",
    idle: "bg-transparent",
    system: "bg-faint/50",
};

const RESERVE = "bg-faint/50";

function MemoryBar({
    lines,
    total,
    reserve,
    label,
}: {
    lines: Line[];
    total: number;
    reserve: number;
    label: string;
}) {
    return (
        <div
            role="img"
            aria-label={label}
            className="flex h-2 overflow-hidden rounded-sm border bg-secondary"
        >
            {lines
                .filter((line) => line.memory)
                .map((line) => (
                    <span
                        key={line.key}
                        className={cn("h-full border-r border-card", SEGMENT[line.kind])}
                        style={{ width: `${((line.memory ?? 0) / total) * 100}%` }}
                    />
                ))}
            <span
                className={cn("ml-auto h-full", RESERVE)}
                style={{ width: `${(reserve / total) * 100}%` }}
            />
        </div>
    );
}

function SlotBlock({
    machine,
    gpu,
    world,
}: {
    machine: Machine;
    gpu: Gpu | null;
    world: World;
}) {
    const here = onSlot(machine, gpu);
    const lines: Line[] = [
        ...world.engines.filter(here).map((engine) => engineLine(engine, world.now)),
        ...world.jobs.filter(here).map(jobLine),
    ];
    const total = slotTotal(machine, gpu);
    const used = slotUsage(machine, gpu, world.engines, world.jobs);
    const reserve = slotReserve(machine, gpu);
    const shown: Line[] =
        lines.length > 0
            ? lines
            : [{ key: "idle", tone: "neutral", kind: "idle", memory: null, text: "Idle" }];
    const system = gpu ? null : machine.system;
    return (
        <div className="flex flex-col gap-2 border-t pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="flex items-center gap-2">
                    <span className="font-medium">
                        {gpu ? `GPU ${gpu.index} · ${gpu.name}` : "CPU and RAM"}
                    </span>
                    <Badge variant="outline" className="font-mono">
                        {gpu?.pool ?? machine.pool}
                    </Badge>
                </span>
                <span className="text-sm text-muted-foreground tabular-nums">
                    {`${round(used)} of ${total} GB${gpu ? "" : " RAM"}`}
                </span>
            </div>
            <MemoryBar
                lines={
                    system
                        ? [
                              {
                                  key: "system",
                                  tone: "neutral",
                                  kind: "system",
                                  memory: system,
                                  text: "",
                              },
                              ...lines,
                          ]
                        : lines
                }
                total={total}
                reserve={reserve}
                label={`${round(used)} of ${total} GB used, ${reserve} GB reserved`}
            />
            <ul className="flex flex-col gap-2">
                {shown.map((line) => (
                    <li key={line.key} className="flex items-start justify-between gap-3">
                        <span className="flex min-w-0 flex-col">
                            <span className="flex items-start gap-2">
                                <span
                                    aria-hidden="true"
                                    className={cn(
                                        "mt-2 size-1.5 shrink-0 rounded-full",
                                        DOT[line.tone],
                                    )}
                                />
                                <span className="min-w-0">{line.text}</span>
                            </span>
                            {line.meta && (
                                <span className="pl-3.5 text-sm text-muted-foreground tabular-nums">
                                    {line.meta}
                                </span>
                            )}
                            {line.progress !== undefined && line.progress < 1 && (
                                <span className="pt-1 pl-3.5">
                                    <ProgressBar
                                        value={line.progress}
                                        label="Progress"
                                        className="w-40"
                                    />
                                </span>
                            )}
                        </span>
                        {line.memory !== null && (
                            <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                                {round(line.memory)}
                            </span>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

type Activity = { key: string; text: string; job: number | null };

function rolloutDownloads(machine: Machine, world: World): Activity[] {
    return Object.entries(world.compute.deployments).flatMap(([target, deployment]) => {
        const job = world.state.jobs.find((item) => item.id === deployment.job);
        const step = job?.rollout?.steps.find((item) => item.state === "running");
        if (
            !job ||
            step?.key !== "download" ||
            !deployment.placements.some((placement) => placement.machine === machine.id)
        ) {
            return [];
        }
        const done = Math.min(0.99, (world.now - (step.start ?? world.now)) / STEP_MS.download);
        return [
            {
                key: `rollout:${job.id}`,
                text: `Downloading ${targetName(target, world.state)} weights · ${Math.round(done * 100)}%`,
                job: job.id,
            },
        ];
    });
}

function machineActivity(machine: Machine, world: World): Activity[] {
    if (!machine.main) {
        return rolloutDownloads(machine, world);
    }
    return Object.keys(world.state.downloads).map((slug) => {
        const name = world.state.models.find((model) => model.slug === slug)?.name ?? slug;
        const progress = downloadProgress(world.state, slug, world.now) ?? 0;
        return {
            key: slug,
            text: `Downloading ${name} to storage · ${Math.round(progress * 100)}% · nothing loads on a GPU`,
            job: null,
        };
    });
}

function MachineCard({
    machine,
    world,
    onOpen,
}: {
    machine: Machine;
    world: World;
    onOpen: () => void;
}) {
    const fresh = machine.joinedAgo === "Joined just now";
    return (
        <article
            className={cn(
                "relative flex flex-col gap-3 rounded-xl border bg-card p-panel hover:border-input",
                fresh && "border-success",
            )}
        >
            <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={onOpen}
                        className="font-mono font-medium after:absolute after:inset-0 after:rounded-xl hover:underline focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
                    >
                        {machine.id}
                    </button>
                    <StatusText tone="success">Online</StatusText>
                </span>
                <span className="text-sm text-muted-foreground">
                    {machine.main ? "Runs main" : machine.joinedAgo}
                </span>
            </header>
            <div className="flex flex-col gap-0.5 text-sm text-muted-foreground tabular-nums">
                <span>{`${hardware(machine)} · ${machine.engine}`}</span>
                <span>
                    {`Pool ${machinePools(machine).join(" and ")} · reserve ${machine.reserve.ram} GB RAM${machine.gpus.length > 0 ? ` + ${machine.reserve.gpu} GB per GPU` : ""}`}
                </span>
            </div>
            {machineActivity(machine, world).map((item) => (
                <StatusText key={item.key} tone="info" className="whitespace-normal">
                    {withRollout(item.text, item.job, `rollout #${item.job}`)}
                </StatusText>
            ))}
            {machine.gpus.length > 0 ? (
                machine.gpus.map((gpu) => (
                    <SlotBlock key={gpu.index} machine={machine} gpu={gpu} world={world} />
                ))
            ) : (
                <SlotBlock machine={machine} gpu={null} world={world} />
            )}
        </article>
    );
}

function Summary({ world }: { world: World }) {
    const { compute, engines, jobs, state } = world;
    const gpus = compute.machines.flatMap((machine) =>
        machine.gpus.map((gpu) => ({ machine, gpu })),
    );
    const busy = gpus.filter(({ machine, gpu }) =>
        [...engines, ...jobs].some(onSlot(machine, gpu)),
    ).length;
    const loaded = engines.filter((engine) => engine.state !== "unloading");
    const adapters = loaded.reduce((total, engine) => total + adapterCount(engine), 0);
    const running = state.jobs.filter((job) => job.status === "running").length;
    const queued = queuedJobs(state).length;
    const bases = state.models
        .filter((model) => model.kind === "base")
        .reduce(
            (total, model) =>
                total +
                model.variants.reduce((sum, item) => sum + (Number.parseFloat(item.size) || 0), 0),
            0,
        );
    const versions = state.models.reduce((total, model) => total + model.versions.length, 0);
    const storage = bases + versions * 0.2 + state.datasets.length * 0.4;
    const items: [string, string, string][] = [
        ["Machines", String(compute.machines.length), "all online"],
        ["GPUs in use", `${busy} of ${gpus.length}`, `${gpus.length - busy} idle`],
        ["Models loaded", plural(loaded.length, "base"), `with ${plural(adapters, "adapter")}`],
        ["Jobs", `${running} running`, `${queued} queued`],
        ["Storage used", `${Math.round(storage)} GB`, `of ${STORAGE_GB / 1000} TB`],
    ];
    return (
        <dl className="grid grid-cols-2 overflow-hidden rounded-xl border bg-card sm:grid-cols-3 xl:grid-cols-5">
            {items.map(([label, value, detail]) => (
                <div
                    key={label}
                    className="flex flex-col gap-0.5 border-r border-b px-4 py-3 -mr-px -mb-px"
                >
                    <dt className="text-sm text-muted-foreground">{label}</dt>
                    <dd className="text-lg font-semibold tabular-nums">{value}</dd>
                    <dd className="text-sm text-muted-foreground tabular-nums">{detail}</dd>
                </div>
            ))}
        </dl>
    );
}

function headroom(pool: Pool, world: World): string {
    const slots = world.compute.machines.flatMap((machine) =>
        machine.gpus.length > 0
            ? machine.gpus
                  .filter((gpu) => gpu.pool === pool.name)
                  .map((gpu) => ({ machine, gpu: gpu as Gpu | null }))
            : machine.pool === pool.name
              ? [{ machine, gpu: null }]
              : [],
    );
    if (slots.length === 0) {
        return "No machines";
    }
    const free = slots.map(
        ({ machine, gpu }) =>
            slotTotal(machine, gpu) -
            slotReserve(machine, gpu) -
            slotUsage(machine, gpu, world.engines, world.jobs),
    );
    const most = Math.max(0, ...free);
    const cpu = slots.every(({ gpu }) => gpu === null);
    return `Up to ${round(most)} ${cpu ? "RAM" : "per GPU"}`;
}

function PoolsTable({ world }: { world: World }) {
    const admin = useCan("admin");
    const { compute, state } = world;
    const queued = queuedJobs(state);
    return (
        <div className="overflow-x-auto">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Pool</TableHead>
                        <TableHead>Use for</TableHead>
                        <TableHead>Machines</TableHead>
                        <TableHead>Deployed on it</TableHead>
                        <TableHead>Jobs</TableHead>
                        <TableHead>Fits</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {compute.pools.map((pool) => {
                        const machines = compute.machines.filter((machine) =>
                            machinePools(machine).includes(pool.name),
                        );
                        const inPool = (placement: { machine: string; gpu: number | null }) => {
                            const machine = compute.machines.find(
                                (item) => item.id === placement.machine,
                            );
                            const gpu = machine?.gpus.find((item) => item.index === placement.gpu);
                            return (gpu?.pool ?? machine?.pool) === pool.name;
                        };
                        const deployed = world.engines.filter(
                            (engine) => !engine.demand && inPool(engine.placement),
                        );
                        const names = [
                            ...new Set(
                                deployed.flatMap((engine) => [
                                    ...engine.adapters.map((adapter) => adapter.name),
                                    ...(engine.servesBase ? [engine.serve.label] : []),
                                ]),
                            ),
                        ];
                        const running = world.jobs.filter((load) => inPool(load.placement)).length;
                        const firstJobs =
                            compute.pools.find((item) => item.use === "jobs") ??
                            compute.pools.find((item) => item.use === "both");
                        const waiting =
                            firstJobs?.name === pool.name && usesJobs(compute.pools, pool.name)
                                ? queued.length
                                : 0;
                        return (
                            <TableRow key={pool.name}>
                                <TableCell className="font-mono">{pool.name}</TableCell>
                                <TableCell>
                                    {admin ? (
                                        <Select
                                            value={pool.use}
                                            onValueChange={(value) =>
                                                setPoolUse(pool.name, value as PoolUse)
                                            }
                                        >
                                            <SelectTrigger
                                                aria-label={`Use ${pool.name} for`}
                                                className="w-32"
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {(Object.keys(USE_LABELS) as PoolUse[]).map(
                                                    (use) => (
                                                        <SelectItem key={use} value={use}>
                                                            {USE_LABELS[use]}
                                                        </SelectItem>
                                                    ),
                                                )}
                                            </SelectContent>
                                        </Select>
                                    ) : (
                                        USE_LABELS[pool.use]
                                    )}
                                </TableCell>
                                <TableCell className="font-mono text-sm">
                                    {machines.map((machine) => machine.id).join(", ") || "–"}
                                </TableCell>
                                <TableCell className="max-w-80 whitespace-normal">
                                    {names.length > 0 ? (
                                        names.join(", ")
                                    ) : (
                                        <span className="text-muted-foreground">Nothing</span>
                                    )}
                                </TableCell>
                                <TableCell className="tabular-nums">
                                    {pool.use === "serving" ? (
                                        <span className="text-muted-foreground">Not allowed</span>
                                    ) : (
                                        `${running} running${waiting > 0 ? ` · ${waiting} queued` : ""}`
                                    )}
                                </TableCell>
                                <TableCell className="tabular-nums">
                                    {headroom(pool, world)}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}

function Legend() {
    const items: [string, string][] = [
        ["Serving", SEGMENT.serving],
        ["Job", SEGMENT.job],
        ["On demand", SEGMENT.demand],
        ["System and reserve", RESERVE],
    ];
    return (
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {items.map(([label, color]) => (
                <li key={label} className="flex items-center gap-1.5">
                    <span aria-hidden="true" className={cn("size-2.5 rounded-sm border", color)} />
                    {label}
                </li>
            ))}
        </ul>
    );
}

export function FlowInfrastructurePage() {
    const world = useWorld();
    const admin = useCan("admin");
    const [open, setOpen] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const visited = world.state.visited;
    const loading = world.engines.some((engine) => engine.state === "loading");
    const unloading = world.engines.some((engine) => engine.state === "unloading");
    const traffic = world.engines.some((engine) => engine.recent > 0);
    useEffect(() => {
        if (visited.includes("infra-deploy") && (loading || !visited.includes("infra-undeploy"))) {
            markVisited("infra-loading");
        }
        if (visited.includes("infra-try") && traffic) {
            markVisited("infra-traffic");
        }
        if (
            visited.includes("infra-undeploy") &&
            (unloading || visited.includes("infra-traffic"))
        ) {
            markVisited("infra-unload");
        }
    }, [visited, loading, unloading, traffic]);
    const machine = world.compute.machines.find((item) => item.id === open) ?? null;
    return (
        <Page wide>
            <PageHeader
                title="Infrastructure"
                caption="What runs where, right now: the machines in each pool, what each GPU holds, and the jobs on them."
                actions={
                    admin ? (
                        <Button onClick={() => setAdding(true)}>
                            <Plus />
                            Add compute
                        </Button>
                    ) : undefined
                }
            />
            <Summary world={world} />
            <PanelSections>
                <PanelSection
                    icon={Server}
                    title="Machines"
                    description="Each machine, its GPUs and what is loaded on them now. Open one for its engines, jobs and reserve."
                    actions={<Legend />}
                    bare
                >
                    <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                        {world.compute.machines.map((item) => (
                            <MachineCard
                                key={item.id}
                                machine={item}
                                world={world}
                                onOpen={() => setOpen(item.id)}
                            />
                        ))}
                    </div>
                </PanelSection>
                <PanelSection
                    icon={Layers}
                    title="Pools"
                    description="Named budgets of machines. Use for decides what the scheduler may place there; Both serves first."
                    flush
                >
                    <PoolsTable world={world} />
                </PanelSection>
            </PanelSections>
            <MachineSheet machine={machine} world={world} onClose={() => setOpen(null)} />
            <AddComputeDialog open={adding} onOpenChange={setAdding} />
        </Page>
    );
}
