import { Cloud, Network, PlugZap } from "lucide-react";
import {
    Badge,
    Button,
    CodeBlock,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    Link,
    NumberField,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    cn,
} from "obp-ui";
import { type ReactNode, useEffect, useState } from "react";
import { ProgressBar, StatusText } from "~/components/models/StatusText";
import {
    type Adapter,
    type Machine,
    USE_LABELS,
    hardware,
    joinMachine,
    machinePools,
    nextMachineName,
    setGpuPool,
    setReserve,
    useCompute,
} from "./flowCompute";
import type { World } from "./flowInfra";
import { useCan } from "./flowOverlays";
import { jobHref, modelHref, shortAgo, useFlowState } from "./modelsFlowData";

function SheetSection({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-2 border-t pt-4">
            <h3 className="font-semibold">{title}</h3>
            {children}
        </section>
    );
}

function adapterNote(adapter: Adapter): string {
    if (adapter.trained) {
        return `${adapter.version} adapter`;
    }
    return adapter.version === "no version deployed"
        ? "no version deployed, answers as the base"
        : `${adapter.version}, no adapter`;
}

function EnginesSection({ machine, world }: { machine: Machine; world: World }) {
    const engines = world.engines.filter((engine) => engine.placement.machine === machine.id);
    if (engines.length === 0) {
        return (
            <p className="text-muted-foreground">
                {`No engine running. ${machine.engine} starts one when something is deployed here or loaded on demand.`}
            </p>
        );
    }
    return (
        <ul className="flex flex-col gap-3">
            {engines.map((engine) => (
                <li key={engine.key} className="flex flex-col gap-1">
                    <span className="flex items-baseline justify-between gap-3">
                        <StatusText
                            tone={
                                engine.state === "loaded"
                                    ? engine.demand
                                        ? "neutral"
                                        : "success"
                                    : engine.state === "loading"
                                      ? "info"
                                      : "warning"
                            }
                            className="whitespace-normal"
                        >
                            {`${machine.engine} · ${engine.serve.label}`}
                        </StatusText>
                        <span className="text-sm text-muted-foreground tabular-nums">
                            {engine.placement.gpu === null ? "RAM" : `GPU ${engine.placement.gpu}`}
                        </span>
                    </span>
                    <ul className="flex flex-col gap-0.5 pl-3 text-sm text-muted-foreground">
                        {engine.servesBase && <li>The base itself, by its API name</li>}
                        {engine.adapters.map((adapter) => (
                            <li key={adapter.slug}>
                                <Link href={modelHref(adapter.slug)} className="hover:underline">
                                    {adapter.name}
                                </Link>
                                {` · ${adapterNote(adapter)}${adapter.loading ? " · loading" : ""}`}
                            </li>
                        ))}
                        {engine.demand && (
                            <li>{`On demand for the ${engine.demand.reason}; unloads after 5 min idle`}</li>
                        )}
                        {engine.state === "unloading" && <li>Unloading</li>}
                    </ul>
                </li>
            ))}
        </ul>
    );
}

function JobsSection({ machine, world }: { machine: Machine; world: World }) {
    const placed = new Set(
        world.jobs
            .filter((load) => load.placement.machine === machine.id)
            .map((load) => load.job.id),
    );
    const jobs = world.state.jobs
        .filter((job) => placed.has(job.id) || job.device === machine.id)
        .slice(0, 5);
    if (jobs.length === 0) {
        return <p className="text-muted-foreground">No jobs have run here yet.</p>;
    }
    return (
        <ul className="flex flex-col gap-1">
            {jobs.map((job) => {
                const model = world.state.models.find((item) => item.slug === job.model);
                return (
                    <li key={job.id} className="flex items-baseline justify-between gap-3">
                        <Link href={jobHref(job.id)} className="min-w-0 truncate hover:underline">
                            {`${job.kind[0].toUpperCase()}${job.kind.slice(1)} ${model?.name ?? job.model}${job.version === null ? "" : ` v${job.version}`}`}
                        </Link>
                        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                            {job.status === "running"
                                ? `${Math.round(job.progress * 100)}%`
                                : `${job.status} · ${shortAgo(job)}`}
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}

function ReserveSection({ machine }: { machine: Machine }) {
    const admin = useCan("admin");
    return (
        <>
            <p className="text-sm text-muted-foreground">
                Kept free for the system and engine overhead; nothing is placed in it.
            </p>
            <div className="grid grid-cols-2 gap-field">
                <Field id={`reserve-ram-${machine.id}`} label="RAM">
                    <NumberField
                        id={`reserve-ram-${machine.id}`}
                        value={machine.reserve.ram}
                        onValueChange={(value) =>
                            setReserve(machine.id, { ...machine.reserve, ram: value ?? 4 })
                        }
                        min={0}
                        max={machine.ram}
                        step={1}
                        unit="GB"
                        format={{ maximumFractionDigits: 0 }}
                        disabled={!admin}
                    />
                </Field>
                {machine.gpus.length > 0 && (
                    <Field id={`reserve-gpu-${machine.id}`} label="GPU memory">
                        <NumberField
                            id={`reserve-gpu-${machine.id}`}
                            value={machine.reserve.gpu}
                            onValueChange={(value) =>
                                setReserve(machine.id, { ...machine.reserve, gpu: value ?? 1 })
                            }
                            min={0}
                            max={machine.gpus[0].memory}
                            step={1}
                            unit="GB"
                            format={{ maximumFractionDigits: 0 }}
                            disabled={!admin}
                        />
                    </Field>
                )}
            </div>
        </>
    );
}

function SplitSection({ machine }: { machine: Machine }) {
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const admin = useCan("admin");
    const pools = machinePools(machine);
    const commands = pools
        .map((pool) => {
            const gpus = machine.gpus.filter((gpu) => gpu.pool === pool).map((gpu) => gpu.index);
            return `minibrain engine --pool ${pool}${gpus.length > 0 ? ` --gpus ${gpus.join(",")}` : ""}`;
        })
        .join("\n");
    return (
        <>
            <p className="text-sm text-muted-foreground">
                Each GPU joins one pool, so one machine can serve in one pool and train in another.
                The machine runs one engine per pool.
            </p>
            {machine.gpus.length > 0 ? (
                <ul className="flex flex-col gap-2">
                    {machine.gpus.map((gpu) => (
                        <li key={gpu.index} className="flex items-center justify-between gap-3">
                            <span>{`GPU ${gpu.index} · ${gpu.name}`}</span>
                            <Select
                                value={gpu.pool}
                                onValueChange={(value) =>
                                    setGpuPool(machine.id, gpu.index, String(value))
                                }
                                disabled={!admin}
                            >
                                <SelectTrigger
                                    aria-label={`Pool for GPU ${gpu.index}`}
                                    className="w-40"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {compute.pools.map((pool) => (
                                        <SelectItem key={pool.name} value={pool.name}>
                                            {`${pool.name} · ${USE_LABELS[pool.use]}`}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </li>
                    ))}
                </ul>
            ) : (
                <p>{`All of it is in ${machine.pool}.`}</p>
            )}
            <CodeBlock code={commands} language="bash" copyLabel="Copy the engine commands" />
        </>
    );
}

export function MachineSheet({
    machine,
    world,
    onClose,
}: {
    machine: Machine | null;
    world: World;
    onClose: () => void;
}) {
    return (
        <Sheet open={machine !== null} onOpenChange={(open) => !open && onClose()}>
            <SheetContent className="sm:max-w-md">
                {machine && (
                    <>
                        <SheetHeader>
                            <SheetTitle className="font-mono">{machine.id}</SheetTitle>
                            <SheetDescription asChild>
                                <div className="flex flex-col gap-1 tabular-nums">
                                    <StatusText tone="success">
                                        {machine.main
                                            ? "Online · runs main"
                                            : `Online · ${machine.joinedAgo.toLowerCase()}`}
                                    </StatusText>
                                    <span>{`${machine.platform} · ${hardware(machine)}`}</span>
                                </div>
                            </SheetDescription>
                        </SheetHeader>
                        <SheetSection title="Engines and what they hold">
                            <EnginesSection machine={machine} world={world} />
                        </SheetSection>
                        <SheetSection title="Recent jobs">
                            <JobsSection machine={machine} world={world} />
                        </SheetSection>
                        <SheetSection title="Reserve">
                            <ReserveSection machine={machine} />
                        </SheetSection>
                        <SheetSection title="Pools">
                            <SplitSection machine={machine} />
                        </SheetSection>
                    </>
                )}
            </SheetContent>
        </Sheet>
    );
}

type Way = "connect" | "cloud" | "managed";

const WAYS: { key: Way; title: string; detail: string; icon: typeof Cloud; soon?: string }[] = [
    {
        key: "connect",
        title: "Connect a machine",
        detail: "Run two commands on a Linux machine with NVIDIA GPUs; it joins a pool.",
        icon: PlugZap,
    },
    {
        key: "cloud",
        title: "Your cloud (AWS, GCP)",
        detail: "minibrain starts and stops GPU machines in your account.",
        icon: Network,
        soon: "Coming in v2",
    },
    {
        key: "managed",
        title: "minibrain Cloud",
        detail: "GPUs we run, added like any pool, for teams without hardware.",
        icon: Cloud,
        soon: "Coming in v3 · data leaves your network",
    },
];

const JOIN_MS = 4500;

function ConnectMachine() {
    const state = useFlowState();
    const compute = useCompute(state.mode);
    const [pool, setPool] = useState(compute.pools[0]?.name ?? "local");
    const [name] = useState(() => nextMachineName(compute));
    const [joined, setJoined] = useState<string | null>(null);
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    useEffect(() => {
        const timer = window.setTimeout(() => {
            setJoined(pool);
            joinMachine(name, pool);
        }, JOIN_MS);
        return () => window.clearTimeout(timer);
    }, [name, pool]);
    const token = "mbj_4fK9q2LxR7vT";
    const code = [
        `minibrain worker --url ${origin} --token ${token} --pool ${pool}`,
        `minibrain engine --url ${origin} --token ${token} --pool ${pool}`,
    ].join("\n");
    const machine = compute.machines.find((item) => item.id === name);
    return (
        <div className="flex flex-col gap-4">
            <Field id="join-pool" label="Pool it joins">
                <Select
                    value={pool}
                    onValueChange={(value) => setPool(String(value))}
                    disabled={joined !== null}
                >
                    <SelectTrigger id="join-pool" className="w-56">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {compute.pools.map((item) => (
                            <SelectItem key={item.name} value={item.name}>
                                {`${item.name} · ${USE_LABELS[item.use]}`}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Field>
            <CodeBlock
                code={code}
                language="bash"
                title="Run on the machine"
                copyLabel="Copy the join commands"
            />
            <p className="text-sm text-muted-foreground">
                The token joins machines for 24 hours. Each command reports the GPUs, memory, CPU
                and engines it finds; the worker runs jobs and the engine serves.
            </p>
            {joined && machine ? (
                <StatusText tone="success" className="whitespace-normal">
                    {`Joined pool ${joined}: ${name} · ${hardware(machine)}`}
                </StatusText>
            ) : (
                <div className="flex flex-col gap-2">
                    <StatusText tone="info">{`Waiting for ${name}…`}</StatusText>
                    <ProgressBar value={null} label="Waiting" className="w-40" />
                </div>
            )}
        </div>
    );
}

export function AddComputeDialog({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const [way, setWay] = useState<Way>("connect");
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl [&>*]:min-w-0">
                <DialogHeader>
                    <DialogTitle>Add compute</DialogTitle>
                    <DialogDescription>
                        Machines join a named pool. Jobs and deployments place onto them by the
                        pool's Use for.
                    </DialogDescription>
                </DialogHeader>
                <RadioGroup
                    value={way}
                    onValueChange={(value) => setWay(value as Way)}
                    aria-label="How to add compute"
                >
                    {WAYS.map((item) => {
                        const Icon = item.icon;
                        const id = `add-compute-${item.key}`;
                        return (
                            <label
                                key={item.key}
                                htmlFor={id}
                                className={cn(
                                    "flex items-start gap-3 rounded-md border px-3 py-2",
                                    item.soon
                                        ? "cursor-not-allowed"
                                        : "cursor-pointer hover:bg-secondary has-data-checked:border-primary has-data-checked:bg-accent",
                                )}
                            >
                                <RadioGroupItem
                                    id={id}
                                    value={item.key}
                                    disabled={Boolean(item.soon)}
                                    className="mt-1"
                                />
                                <Icon
                                    aria-hidden="true"
                                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                                />
                                <span className="flex min-w-0 flex-1 flex-col">
                                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                        <span className={cn(item.soon && "text-muted-foreground")}>
                                            {item.title}
                                        </span>
                                        {item.soon && <Badge variant="outline">{item.soon}</Badge>}
                                    </span>
                                    <span className="text-sm text-muted-foreground">
                                        {item.detail}
                                    </span>
                                </span>
                            </label>
                        );
                    })}
                </RadioGroup>
                {open && way === "connect" && <ConnectMachine />}
                <DialogFooter>
                    <DialogClose asChild>
                        <Button>Done</Button>
                    </DialogClose>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
