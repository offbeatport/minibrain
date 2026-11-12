import { useEffect, useState, useSyncExternalStore } from "react";
import {
    DEVICE,
    type FlowModel,
    type FlowState,
    type Job,
    type Mode,
    TRAIN_MS,
    baseModelSlug,
    catalogEntry,
    downloadProgress,
    failedRollout,
    findVersion,
    flowMode,
    flowState,
    jobHref,
    lastRollout,
    liveVersion,
    markVisited,
    modelHref,
    setDeployment,
    setVariantsLive,
    variantKey,
} from "./modelsFlowData";

export type PoolUse = "serving" | "jobs" | "both";

export const USE_LABELS: Record<PoolUse, string> = {
    serving: "Serving",
    jobs: "Jobs",
    both: "Both",
};

export type Pool = { name: string; use: PoolUse };

export type Gpu = { index: number; name: string; memory: number; pool: string };

export type Reserve = { ram: number; gpu: number };

export type Machine = {
    id: string;
    main: boolean;
    cpu: number;
    ram: number;
    system: number;
    gpus: Gpu[];
    pool: string;
    platform: string;
    engine: string;
    reserve: Reserve;
    joinedAgo: string;
};

type Engine = {
    machine: string;
    gpu: number | null;
    base: string;
    format: string;
    state: "loading" | "unloading";
    since: number;
    ms: number;
    demand: { reason: string; until: number } | null;
    job?: number;
};

export type Placement = { machine: string; gpu: number | null };

export type Phase = "deploying" | "loading" | "undeploying";

export type Deployment = {
    phase: Phase;
    since: number;
    ms: number;
    pool: string;
    placements: Placement[];
    loads: boolean;
    job: number | null;
};

type Request = { key: string; at: number };

type Compute = {
    pools: Pool[];
    machines: Machine[];
    engines: Engine[];
    deployments: Record<string, Deployment>;
    placements: Record<string, Placement[]>;
    requests: Request[];
    joined: number;
    cached: string[];
};

export const DEFAULT_RESERVE: Reserve = { ram: 4, gpu: 1 };
export const ON_DEMAND_MS = 5 * 60000;
const UNLOAD_MS = 2500;
const DEMAND_LOAD_MS = 2500;
const ADAPTER_GB = 0.3;
export const STORAGE_GB = 2000;

function a10(index: number, pool: string): Gpu {
    return { index, name: "NVIDIA A10", memory: 24, pool };
}

const LOCAL: Machine = {
    id: "local",
    main: true,
    cpu: 16,
    ram: 64,
    system: 9,
    gpus: [{ index: 0, name: "NVIDIA L4", memory: 24, pool: "local" }],
    pool: "local",
    platform: "Linux · CUDA 12.4",
    engine: "SGLang",
    reserve: DEFAULT_RESERVE,
    joinedAgo: "Runs main",
};

const FULL: Compute = {
    pools: [
        { name: "local", use: "both" },
        { name: "serve", use: "serving" },
        { name: "train", use: "jobs" },
        { name: "cpu", use: "both" },
    ],
    machines: [
        LOCAL,
        {
            id: "gpu-a10-1",
            main: false,
            cpu: 32,
            ram: 128,
            system: 6,
            gpus: [a10(0, "train"), a10(1, "serve")],
            pool: "train",
            platform: "Linux · CUDA 12.4",
            engine: "SGLang",
            reserve: DEFAULT_RESERVE,
            joinedAgo: "Joined 41 days ago",
        },
        {
            id: "gpu-a10-2",
            main: false,
            cpu: 32,
            ram: 128,
            system: 6,
            gpus: [a10(0, "serve")],
            pool: "serve",
            platform: "Linux · CUDA 12.4",
            engine: "SGLang",
            reserve: DEFAULT_RESERVE,
            joinedAgo: "Joined 38 days ago",
        },
        {
            id: "gpu-t4-1",
            main: false,
            cpu: 8,
            ram: 32,
            system: 3,
            gpus: [{ index: 0, name: "NVIDIA T4", memory: 16, pool: "train" }],
            pool: "train",
            platform: "Linux · CUDA 12.2",
            engine: "transformers",
            reserve: DEFAULT_RESERVE,
            joinedAgo: "Joined 20 days ago",
        },
        {
            id: "cpu-1",
            main: false,
            cpu: 32,
            ram: 64,
            system: 4,
            gpus: [],
            pool: "cpu",
            platform: "Linux · x86-64",
            engine: "llama.cpp",
            reserve: DEFAULT_RESERVE,
            joinedAgo: "Joined 30 days ago",
        },
    ],
    engines: [
        {
            machine: "local",
            gpu: 0,
            base: "llama-3.2-1b",
            format: "FP8",
            state: "loading",
            since: 0,
            ms: 0,
            demand: { reason: "Playground", until: Date.now() + 4 * 60000 + 20000 },
        },
    ],
    deployments: {},
    placements: {},
    requests: [],
    joined: 0,
    cached: ["gpu-a10-2:qwen3-8b", "gpu-a10-1:llama-3.2-1b", "cpu-1:qwen3-8b"],
};

const EMPTY: Compute = {
    pools: [{ name: "local", use: "both" }],
    machines: [LOCAL],
    engines: [],
    deployments: {},
    placements: {},
    requests: [],
    joined: 0,
    cached: [],
};

let worlds: Record<Mode, Compute> = { full: FULL, empty: EMPTY };
const listeners = new Set<() => void>();

function notify() {
    worlds = { ...worlds };
    for (const listener of listeners) {
        listener();
    }
}

function change(mode: Mode, update: (compute: Compute) => Compute) {
    worlds = { ...worlds, [mode]: update(worlds[mode]) };
    notify();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useComputeWorlds(): Record<Mode, Compute> {
    return useSyncExternalStore(subscribe, () => worlds);
}

export function computeNow(): Compute {
    return worlds[flowMode()];
}

export function useCompute(mode: Mode): Compute {
    return useComputeWorlds()[mode];
}

export function useNow(ms = 1000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), ms);
        return () => window.clearInterval(timer);
    }, [ms]);
    return now;
}

export function resetCompute(mode: Mode) {
    change(mode, () => (mode === "full" ? FULL : EMPTY));
}

export type Serve = {
    base: string;
    baseName: string;
    format: string;
    memory: number;
    cpu: boolean;
    label: string;
};

function gb(text: string | null | undefined): number {
    return Number.parseFloat(text ?? "") || 0;
}

function serveMemory(base: string, format: string): number {
    const full = gb(catalogEntry(base)?.memory) || 4;
    if (format.startsWith("GGUF")) {
        return Math.max(1, Math.round(full * 0.3));
    }
    if (format === "FP8") {
        return Math.max(1, Math.round(full / 2));
    }
    return full;
}

function serveFor(base: string, format: string, state: FlowState): Serve {
    const owner = state.models.find((model) => model.slug === base);
    const baseName = owner?.name ?? catalogEntry(base)?.name ?? base;
    return {
        base,
        baseName,
        format,
        memory: serveMemory(base, format),
        cpu: format.startsWith("GGUF"),
        label: `${baseName} · ${format}`,
    };
}

export function baseOf(model: FlowModel, state: FlowState): Serve {
    if (model.kind === "base") {
        const variant = model.variants[0];
        return serveFor(model.slug, variant?.format ?? "BF16", state);
    }
    const slug = baseModelSlug(model.base ?? "");
    const owner = state.models.find((item) => item.slug === slug);
    const rest = owner ? (model.base ?? "").slice(owner.name.length).trim() : "";
    return serveFor(slug, rest || "BF16", state);
}

export function serveOf(target: string, state: FlowState): Serve | null {
    const [slug, variant] = target.split("#");
    const model = state.models.find((item) => item.slug === slug);
    if (!model) {
        return null;
    }
    if (variant) {
        const found = model.variants.find((item) => item.id === variant);
        return serveFor(slug, found?.format ?? "BF16", state);
    }
    return baseOf(model, state);
}

export function targetName(target: string, state: FlowState): string {
    const [slug, variant] = target.split("#");
    const model = state.models.find((item) => item.slug === slug);
    const format = model?.variants.find((item) => item.id === variant)?.format;
    return format ? `${model?.name} · ${format}` : (model?.name ?? slug);
}

function servingGpu(machine: Machine, pools: Pool[]): number | null {
    const allowed = machine.gpus.find((gpu) => usesServing(pools, gpu.pool));
    return allowed?.index ?? machine.gpus[0]?.index ?? null;
}

export function usesServing(pools: Pool[], name: string): boolean {
    return pools.find((pool) => pool.name === name)?.use !== "jobs";
}

export function usesJobs(pools: Pool[], name: string): boolean {
    return pools.find((pool) => pool.name === name)?.use !== "serving";
}

function slotKey(placement: Placement): string {
    return `${placement.machine}:${placement.gpu ?? "ram"}`;
}

function engineKey(placement: Placement, base: string, format: string): string {
    return `${slotKey(placement)}:${base}:${format}`;
}

export type Adapter = {
    slug: string;
    name: string;
    version: string;
    trained: boolean;
    loading: boolean;
};

export type LoadedEngine = {
    key: string;
    placement: Placement;
    serve: Serve;
    state: "loading" | "loaded" | "unloading";
    progress: number;
    adapters: Adapter[];
    servesBase: boolean;
    demand: { reason: string; until: number } | null;
    today: number;
    recent: number;
    job: number | null;
    rollout: number | null;
};

function versionLabel(model: FlowModel): string {
    const live = liveVersion(model);
    if (!live) {
        return "no version deployed";
    }
    if (live.kind === "prompt") {
        return `v${live.number}, prompt only`;
    }
    const canary = model.canary ? ` + v${model.canary.version} canary` : "";
    return `v${live.number}${canary}`;
}

function placementsOf(target: string, replicas: string[], compute: Compute): Placement[] {
    const stored = compute.placements[target];
    if (stored && stored.length > 0) {
        return stored;
    }
    return replicas.flatMap((id) => {
        const machine = compute.machines.find((item) => item.id === id);
        return machine ? [{ machine: id, gpu: servingGpu(machine, compute.pools) }] : [];
    });
}

type Use = {
    target: string;
    placement: Placement;
    serve: Serve;
    adapter: Adapter | null;
    today: number;
    job: number | null;
};

type Active = { placements: Placement[]; loading: boolean; job: number | null };

function activeOf(
    target: string,
    live: boolean,
    replicas: string[],
    compute: Compute,
): Active | null {
    const deployment = compute.deployments[target];
    if (deployment && deployment.phase !== "deploying") {
        return {
            placements: deployment.placements,
            loading: deployment.phase === "loading",
            job: deployment.job,
        };
    }
    if (!live) {
        return null;
    }
    return { placements: placementsOf(target, replicas, compute), loading: false, job: null };
}

function usesOf(state: FlowState, compute: Compute): Use[] {
    const uses: Use[] = [];
    for (const model of state.models) {
        if (model.kind === "custom") {
            const serve = baseOf(model, state);
            const active = activeOf(model.slug, model.deployed, model.replicas, compute);
            for (const placement of active?.placements ?? []) {
                uses.push({
                    target: model.slug,
                    placement,
                    serve,
                    job: active?.job ?? null,
                    today: model.traffic.at(-1) ?? 0,
                    adapter: {
                        slug: model.slug,
                        name: model.name,
                        version: versionLabel(model),
                        trained: liveVersion(model)?.kind === "trained",
                        loading: Boolean(active?.loading),
                    },
                });
            }
            continue;
        }
        for (const variant of model.variants) {
            const target = variantKey(model.slug, variant.id);
            const active = activeOf(target, variant.live, variant.replicas, compute);
            for (const placement of active?.placements ?? []) {
                uses.push({
                    target,
                    placement,
                    job: active?.job ?? null,
                    serve: serveFor(model.slug, variant.format, state),
                    today: variant.traffic.at(-1) ?? 0,
                    adapter: null,
                });
            }
        }
    }
    return uses;
}

export function enginesOf(state: FlowState, compute: Compute, now: number): LoadedEngine[] {
    const engines = new Map<string, LoadedEngine>();
    const touch = (placement: Placement, serve: Serve): LoadedEngine => {
        const key = engineKey(placement, serve.base, serve.format);
        const found = engines.get(key);
        if (found) {
            return found;
        }
        const created: LoadedEngine = {
            key,
            placement,
            serve,
            state: "loaded",
            progress: 1,
            adapters: [],
            servesBase: false,
            demand: null,
            today: 0,
            recent: 0,
            job: null,
            rollout: null,
        };
        engines.set(key, created);
        return created;
    };
    const rollouts = latestDeploys(state);
    for (const use of usesOf(state, compute)) {
        const engine = touch(use.placement, use.serve);
        engine.today += use.today;
        engine.job ??= use.job;
        engine.rollout ??= rollouts.get(use.target) ?? null;
        if (use.adapter) {
            engine.adapters.push(use.adapter);
        } else {
            engine.servesBase = true;
        }
    }
    for (const item of compute.engines) {
        const placement = { machine: item.machine, gpu: item.gpu };
        const known = engines.has(engineKey(placement, item.base, item.format));
        if (item.state === "unloading" && known) {
            continue;
        }
        const engine = touch(placement, serveFor(item.base, item.format, state));
        engine.demand = item.demand;
        engine.job ??= item.job ?? null;
        const done = (now - item.since) / Math.max(1, item.ms);
        if (item.demand && now > item.demand.until) {
            engine.state = "unloading";
        } else if (item.state === "unloading" && !known) {
            engine.state = "unloading";
        } else if (item.state === "loading" && done < 1) {
            engine.state = "loading";
            engine.progress = Math.max(0, done);
        }
    }
    for (const request of compute.requests) {
        const engine = engines.get(request.key);
        if (engine && now - request.at < 60000) {
            engine.recent += 1;
        }
    }
    return [...engines.values()];
}

function latestDeploys(state: FlowState): Map<string, number> {
    const found = new Map<string, number>();
    for (const job of state.jobs) {
        const target = job.rollout?.target;
        if (job.kind !== "deploy" || job.status !== "done" || !target) {
            continue;
        }
        const known = state.jobs.find((item) => item.id === found.get(target));
        if (!known || jobHours(job) < jobHours(known)) {
            found.set(target, job.id);
        }
    }
    return found;
}

function jobHours(job: Job): number {
    return job.atMs ? (Date.now() - job.atMs) / 3600000 : job.hoursAgo;
}

export type JobLoad = {
    job: Job;
    placement: Placement;
    label: string;
    progress: number;
    left: string | null;
    memory: number;
};

function minutesLeft(job: Job, progress: number): string | null {
    if (job.status !== "running") {
        return null;
    }
    const left = job.atMs
        ? ((1 - progress) * TRAIN_MS) / 60000
        : (1 - progress) * (job.kind === "train" ? 22 : 8);
    const minutes = Math.max(1, Math.round(left));
    return `${minutes} min left`;
}

function jobVerb(job: Job): string {
    if (job.kind === "train") {
        return "Training";
    }
    if (job.kind === "judge") {
        return "Judging";
    }
    if (job.kind === "export") {
        return "Exporting";
    }
    return "Scoring";
}

export function jobSlots(compute: Compute): Placement[] {
    return compute.machines.flatMap((machine) =>
        machine.gpus
            .filter((gpu) => usesJobs(compute.pools, gpu.pool))
            .map((gpu) => ({ machine: machine.id, gpu: gpu.index })),
    );
}

export function jobLoads(state: FlowState, compute: Compute): JobLoad[] {
    const slots = jobSlots(compute);
    const taken = new Set<string>();
    const loads: JobLoad[] = [];
    const running = state.jobs.filter(
        (job) => job.status === "running" && ["train", "score", "judge"].includes(job.kind),
    );
    for (const job of running) {
        const model = state.models.find((item) => item.slug === job.model);
        if (!model) {
            continue;
        }
        const serve = baseOf(model, state);
        const version = job.version === null ? undefined : findVersion(model, job.version);
        const progress = job.kind === "train" ? (version?.progress ?? job.progress) : job.progress;
        const label = `${jobVerb(job)} ${model.name}${job.version === null ? "" : ` v${job.version}`}`;
        let placement: Placement | undefined;
        if (serve.cpu) {
            const cpu = compute.machines.find(
                (machine) => machine.gpus.length === 0 && usesJobs(compute.pools, machine.pool),
            );
            placement = cpu ? { machine: cpu.id, gpu: null } : undefined;
        } else {
            const wanted = job.device ?? DEVICE;
            placement =
                slots.find((slot) => slot.machine === wanted && !taken.has(slotKey(slot))) ??
                slots.find((slot) => !taken.has(slotKey(slot)));
        }
        if (!placement) {
            continue;
        }
        if (placement.gpu !== null) {
            taken.add(slotKey(placement));
        }
        const machine = compute.machines.find((item) => item.id === placement.machine);
        const gpu = machine?.gpus.find((item) => item.index === placement.gpu);
        const training = job.kind === "train" ? serve.memory + 1 : serve.memory;
        const room = gpu && machine ? gpu.memory - machine.reserve.gpu - 1 : training;
        loads.push({
            job,
            placement,
            label,
            progress,
            left: minutesLeft(job, progress),
            memory: Math.min(training, room),
        });
    }
    return loads;
}

export function queuedJobs(state: FlowState): Job[] {
    return state.jobs.filter((job) => job.status === "queued");
}

export type Slot = {
    machine: Machine;
    gpu: Gpu | null;
    pool: string;
    total: number;
    used: number;
    free: number;
    loaded: boolean;
};

type RawSlot = { machine: Machine; gpu: Gpu | null; pool: string };

function slotsOf(compute: Compute): RawSlot[] {
    return compute.machines.flatMap((machine): RawSlot[] =>
        machine.gpus.length > 0
            ? machine.gpus.map((gpu) => ({ machine, gpu, pool: gpu.pool }))
            : [{ machine, gpu: null, pool: machine.pool }],
    );
}

export function slotUsage(
    machine: Machine,
    gpu: Gpu | null,
    engines: LoadedEngine[],
    jobs: JobLoad[],
): number {
    const here = (placement: Placement) =>
        placement.machine === machine.id && placement.gpu === (gpu?.index ?? null);
    const engineMemory = engines
        .filter((engine) => here(engine.placement))
        .reduce((total, engine) => total + engineMemoryOf(engine), 0);
    const jobMemory = jobs
        .filter((load) => here(load.placement))
        .reduce((total, load) => total + load.memory, 0);
    return engineMemory + jobMemory + (gpu ? 0 : machine.system);
}

export function engineMemoryOf(engine: LoadedEngine): number {
    return engine.serve.memory + adapterCount(engine) * ADAPTER_GB;
}

export function slotTotal(machine: Machine, gpu: Gpu | null): number {
    return gpu ? gpu.memory : machine.ram;
}

export function slotReserve(machine: Machine, gpu: Gpu | null): number {
    return gpu ? machine.reserve.gpu : machine.reserve.ram;
}

export type PoolFit = {
    pool: Pool;
    fitting: Slot[];
    best: Slot | null;
    need: number;
    reason: string | null;
    text: string;
};

export function round(value: number): string {
    return `${Math.round(value * 10) / 10} GB`;
}

export function slotName(slot: { machine: Machine; gpu: Gpu | null }): string {
    return slot.machine.gpus.length > 1 && slot.gpu
        ? `${slot.machine.id} (GPU ${slot.gpu.index})`
        : slot.machine.id;
}

export function poolFits(
    target: string,
    state: FlowState,
    compute: Compute,
    now: number,
): PoolFit[] {
    const serve = serveOf(target, state);
    if (!serve) {
        return [];
    }
    const others = { ...state, models: state.models.map((model) => withoutTarget(model, target)) };
    const engines = enginesOf(others, compute, now);
    const jobs = jobLoads(state, compute);
    const slots = slotsOf(compute).map((slot): Slot => {
        const total = slotTotal(slot.machine, slot.gpu);
        const used = slotUsage(slot.machine, slot.gpu, engines, jobs);
        const loaded = engines.some(
            (engine) =>
                engine.state === "loaded" &&
                engine.placement.machine === slot.machine.id &&
                engine.placement.gpu === (slot.gpu?.index ?? null) &&
                engine.serve.base === serve.base &&
                engine.serve.format === serve.format,
        );
        return {
            ...slot,
            total,
            used,
            free: Math.max(0, total - slotReserve(slot.machine, slot.gpu) - used),
            loaded,
        };
    });
    return compute.pools.map((pool) => {
        const inPool = slots.filter((slot) => slot.pool === pool.name);
        const usable = inPool.filter((slot) => slot.gpu !== null || serve.cpu);
        const fitting = usable
            .filter((slot) => slot.loaded || slot.free >= serve.memory)
            .sort((a, b) => Number(b.loaded) - Number(a.loaded) || b.free - a.free);
        const best = fitting[0] ?? null;
        const most = Math.max(0, ...usable.map((slot) => slot.free));
        let reason: string | null = null;
        if (pool.use === "jobs") {
            reason = "Runs jobs only";
        } else if (inPool.length === 0) {
            reason = "No machines yet";
        } else if (usable.length === 0) {
            reason = `No GPU: ${serve.format} needs one`;
        } else if (!best) {
            reason = `No room: needs ${round(serve.memory)}, ${round(most)} free`;
        }
        const text = best?.loaded
            ? `Fits: ${serve.label} is already loaded on ${slotName(best)}`
            : best
              ? `Fits: needs ${round(serve.memory)}, ${round(best.free)} free`
              : "";
        return { pool, fitting, best, need: serve.memory, reason, text };
    });
}

function withoutTarget(model: FlowModel, target: string): FlowModel {
    const [slug, variant] = target.split("#");
    if (model.slug !== slug) {
        return model;
    }
    if (!variant) {
        return { ...model, deployed: false };
    }
    return {
        ...model,
        variants: model.variants.map((item) =>
            item.id === variant ? { ...item, live: false } : item,
        ),
    };
}

export function automaticPool(fits: PoolFit[]): PoolFit | undefined {
    const usable = fits.filter((fit) => !fit.reason && fit.best);
    return usable.sort(
        (a, b) =>
            Number(b.best?.loaded) - Number(a.best?.loaded) ||
            Number(b.pool.use === "serving") - Number(a.pool.use === "serving") ||
            (b.best?.free ?? 0) - (a.best?.free ?? 0),
    )[0];
}

export function loadSeconds(serve: Serve, loaded: boolean): number {
    return loaded ? 2 : Math.max(10, Math.round(serve.memory * 2));
}

export function placementOf(slot: Slot): Placement {
    return { machine: slot.machine.id, gpu: slot.gpu?.index ?? null };
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
    return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

export function completeDeploy(mode: Mode, target: string, placements: Placement[], serve: Serve) {
    const machines = [...new Set(placements.map((placement) => placement.machine))];
    if (target.includes("#")) {
        setVariantsLive([target], true, machines);
    } else {
        setDeployment(target, true, machines);
    }
    const keys = new Set(
        placements.map((placement) => engineKey(placement, serve.base, serve.format)),
    );
    change(mode, (compute) => ({
        ...compute,
        deployments: omit(compute.deployments, target),
        placements: { ...compute.placements, [target]: placements },
        engines: compute.engines.filter(
            (engine) => !keys.has(engineKey(engine, engine.base, engine.format)),
        ),
    }));
}

export function setRolloutPhase(mode: Mode, target: string, deployment: Deployment | null) {
    change(mode, (compute) => ({
        ...compute,
        deployments: deployment
            ? { ...compute.deployments, [target]: deployment }
            : omit(compute.deployments, target),
    }));
}

export function startLoading(
    mode: Mode,
    placements: Placement[],
    serve: Serve,
    ms: number,
    job: number,
) {
    const since = Date.now();
    change(mode, (compute) => ({
        ...compute,
        engines: [
            ...compute.engines,
            ...placements.map(
                (placement): Engine => ({
                    ...placement,
                    base: serve.base,
                    format: serve.format,
                    state: "loading",
                    since,
                    ms,
                    demand: null,
                    job,
                }),
            ),
        ],
    }));
}

export function dropLoading(mode: Mode, job: number) {
    change(mode, (compute) => ({
        ...compute,
        engines: compute.engines.filter((engine) => engine.job !== job),
    }));
}

export function isCached(mode: Mode, machine: string, base: string): boolean {
    return machine === "local" || worlds[mode].cached.includes(`${machine}:${base}`);
}

export function markCached(mode: Mode, machines: string[], base: string) {
    change(mode, (compute) => ({
        ...compute,
        cached: [...new Set([...compute.cached, ...machines.map((id) => `${id}:${base}`)])],
    }));
}

export function deployedPlacements(target: string): Placement[] {
    const mode = flowMode();
    const state = flowState();
    const model = state.models.find((item) => item.slug === target.split("#")[0]);
    if (!model) {
        return [];
    }
    const replicas = target.includes("#")
        ? (model.variants.find((item) => variantKey(model.slug, item.id) === target)?.replicas ??
          [])
        : model.replicas;
    return placementsOf(target, replicas, worlds[mode]);
}

export function stopRouting(target: string) {
    if (target.includes("#")) {
        setVariantsLive([target], false, []);
    } else {
        setDeployment(target, false, []);
    }
}

export function baseUsers(target: string, placements: Placement[], serve: Serve): string[] {
    const state = flowState();
    const mode = flowMode();
    const keys = new Set(
        placements.map((placement) => engineKey(placement, serve.base, serve.format)),
    );
    return usesOf(state, worlds[mode])
        .filter(
            (use) =>
                use.target !== target &&
                keys.has(engineKey(use.placement, use.serve.base, use.serve.format)),
        )
        .map((use) => targetName(use.target, state));
}

export function releaseBase(
    mode: Mode,
    target: string,
    placements: Placement[],
    serve: Serve,
    job: number,
) {
    change(mode, (compute) => ({
        ...compute,
        deployments: omit(compute.deployments, target),
        placements: omit(compute.placements, target),
    }));
    const after = enginesOf(flowState(), worlds[mode], Date.now());
    const since = Date.now();
    const unloading = placements
        .filter(
            (placement) =>
                !after.some(
                    (engine) =>
                        engine.key === engineKey(placement, serve.base, serve.format) &&
                        engine.state !== "unloading",
                ),
        )
        .map(
            (placement): Engine => ({
                ...placement,
                base: serve.base,
                format: serve.format,
                state: "unloading",
                since,
                ms: UNLOAD_MS,
                demand: null,
                job,
            }),
        );
    change(mode, (compute) => ({
        ...compute,
        engines: [...compute.engines, ...unloading],
    }));
    window.setTimeout(
        () =>
            change(mode, (compute) => ({
                ...compute,
                engines: compute.engines.filter((engine) => !unloading.includes(engine)),
            })),
        UNLOAD_MS,
    );
}

export type Served = { where: string; onDemand: boolean; loading: boolean };

export function serveRequest(choice: string): Served | null {
    const mode = flowMode();
    const state = flowState();
    const slug = choice.split("@")[0];
    const model = state.models.find((item) => item.slug === slug);
    if (!model) {
        return null;
    }
    const compute = worlds[mode];
    const now = Date.now();
    const engines = enginesOf(state, compute, now);
    const serving = engines.find(
        (engine) =>
            engine.state !== "unloading" &&
            (model.kind === "custom"
                ? engine.adapters.some((adapter) => adapter.slug === slug)
                : engine.servesBase && engine.serve.base === slug),
    );
    const name = (placement: Placement) => {
        const machine = compute.machines.find((item) => item.id === placement.machine);
        return machine && placement.gpu !== null && machine.gpus.length > 1
            ? `${machine.id} (GPU ${placement.gpu})`
            : placement.machine;
    };
    if (serving) {
        change(mode, (current) => ({
            ...current,
            requests: [...current.requests, { key: serving.key, at: now }],
        }));
        if (model.kind === "custom") {
            markVisited("infra-try");
        }
        return { where: name(serving.placement), onDemand: false, loading: false };
    }
    const serve = baseOf(model, state);
    const existing = compute.engines.find(
        (engine) =>
            engine.demand !== null &&
            engine.base === serve.base &&
            engine.format === serve.format &&
            now <= engine.demand.until,
    );
    if (existing) {
        change(mode, (current) => ({
            ...current,
            engines: current.engines.map((engine) =>
                engine === existing
                    ? { ...engine, demand: { reason: "Playground", until: now + ON_DEMAND_MS } }
                    : engine,
            ),
            requests: [
                ...current.requests,
                { key: engineKey(existing, existing.base, existing.format), at: now },
            ],
        }));
        return {
            where: name(existing),
            onDemand: true,
            loading: now - existing.since < existing.ms,
        };
    }
    const jobs = jobLoads(state, compute);
    const slot = slotsOf(compute)
        .filter((item) => usesJobs(compute.pools, item.pool) && (item.gpu !== null || serve.cpu))
        .map((item) => ({
            ...item,
            free:
                slotTotal(item.machine, item.gpu) -
                slotReserve(item.machine, item.gpu) -
                slotUsage(item.machine, item.gpu, engines, jobs),
        }))
        .filter((item) => item.free >= serve.memory)
        .sort((a, b) => b.free - a.free)[0];
    if (!slot) {
        return null;
    }
    const placement = { machine: slot.machine.id, gpu: slot.gpu?.index ?? null };
    const engine: Engine = {
        ...placement,
        base: serve.base,
        format: serve.format,
        state: "loading",
        since: now,
        ms: DEMAND_LOAD_MS,
        demand: { reason: "Playground", until: now + ON_DEMAND_MS },
    };
    change(mode, (current) => ({
        ...current,
        engines: [...current.engines, engine],
        requests: [
            ...current.requests,
            { key: engineKey(placement, serve.base, serve.format), at: now },
        ],
    }));
    sweepLater();
    return { where: name(placement), onDemand: true, loading: true };
}

let sweeping = false;

function sweepLater() {
    if (sweeping) {
        return;
    }
    sweeping = true;
    const timer = window.setInterval(() => {
        const now = Date.now();
        let pending = false;
        for (const mode of ["full", "empty"] as Mode[]) {
            const stale = worlds[mode].engines.filter(
                (engine) => engine.demand && now > engine.demand.until + UNLOAD_MS,
            );
            pending ||= worlds[mode].engines.some((engine) => engine.demand);
            if (stale.length > 0) {
                change(mode, (compute) => ({
                    ...compute,
                    engines: compute.engines.filter((engine) => !stale.includes(engine)),
                }));
            }
        }
        if (!pending) {
            window.clearInterval(timer);
            sweeping = false;
        }
    }, 1000);
}

sweepLater();

export function setPoolUse(name: string, use: PoolUse) {
    change(flowMode(), (compute) => ({
        ...compute,
        pools: compute.pools.map((pool) => (pool.name === name ? { ...pool, use } : pool)),
    }));
}

export function setGpuPool(machineId: string, index: number, pool: string) {
    change(flowMode(), (compute) => ({
        ...compute,
        machines: compute.machines.map((machine) =>
            machine.id === machineId
                ? {
                      ...machine,
                      gpus: machine.gpus.map((gpu) =>
                          gpu.index === index ? { ...gpu, pool } : gpu,
                      ),
                  }
                : machine,
        ),
    }));
}

export function setReserve(machineId: string, reserve: Reserve) {
    change(flowMode(), (compute) => ({
        ...compute,
        machines: compute.machines.map((machine) =>
            machine.id === machineId ? { ...machine, reserve } : machine,
        ),
    }));
}

export function nextMachineName(compute: Compute): string {
    const taken = new Set(compute.machines.map((machine) => machine.id));
    let number = 3;
    while (taken.has(`gpu-a10-${number}`)) {
        number += 1;
    }
    return `gpu-a10-${number}`;
}

export function joinMachine(id: string, pool: string) {
    change(flowMode(), (compute) => ({
        ...compute,
        joined: compute.joined + 1,
        machines: [
            ...compute.machines,
            {
                id,
                main: false,
                cpu: 32,
                ram: 128,
                system: 5,
                gpus: [a10(0, pool)],
                pool,
                platform: "Linux · CUDA 12.4",
                engine: "SGLang",
                reserve: DEFAULT_RESERVE,
                joinedAgo: "Joined just now",
            },
        ],
    }));
}

export type ModelPhase = {
    tone: "success" | "info" | "neutral" | "warning" | "destructive";
    text: string;
    href?: string;
    reason?: string;
};

const UNHEALTHY: Record<string, string> = {
    guy1: "health checks time out on local; the engine restarted 3 times in 10 min",
};

export function unhealthyReason(model: FlowModel, mode: Mode): string | null {
    return mode === "full" && model.deployed ? (UNHEALTHY[model.slug] ?? null) : null;
}

function targetsOf(model: FlowModel): string[] {
    return model.kind === "custom"
        ? [model.slug]
        : model.variants.map((item) => variantKey(model.slug, item.id));
}

export function deploymentOf(model: FlowModel, compute: Compute): Deployment | undefined {
    return targetsOf(model)
        .map((target) => compute.deployments[target])
        .find(Boolean);
}

export function downloadingBase(
    model: FlowModel,
    state: FlowState,
    now: number,
): { name: string; progress: number } | null {
    const slug = model.kind === "base" ? model.slug : baseModelSlug(model.base ?? "");
    const progress = downloadProgress(state, slug, now);
    if (progress === null) {
        return null;
    }
    const name = state.models.find((item) => item.slug === slug)?.name ?? model.base ?? slug;
    return { name, progress };
}

export function placementNames(placements: Placement[], compute: Compute): string {
    return placements
        .map((placement) => {
            const machine = compute.machines.find((item) => item.id === placement.machine);
            return machine && placement.gpu !== null && machine.gpus.length > 1
                ? `${machine.id} (GPU ${placement.gpu})`
                : placement.machine;
        })
        .join(", ");
}

export function modelPhase(
    model: FlowModel,
    state: FlowState,
    compute: Compute,
    now: number,
): ModelPhase {
    const download = downloadingBase(model, state, now);
    if (download) {
        return {
            tone: "info",
            text: `Downloading ${download.name} · ${Math.round(download.progress * 100)}%`,
        };
    }
    const deployment = deploymentOf(model, compute);
    const href = deployment?.job ? jobHref(deployment.job) : undefined;
    const job = state.jobs.find((item) => item.id === deployment?.job);
    const what =
        model.kind === "custom" && job?.version !== null && job?.version !== undefined
            ? `Deploying v${job.version}`
            : "Deploying";
    if (deployment?.phase === "deploying") {
        return { tone: "info", text: what, href };
    }
    if (deployment?.phase === "loading") {
        return {
            tone: "info",
            text: `${what} · loading on ${placementNames(deployment.placements, compute)}`,
            href,
        };
    }
    if (deployment?.phase === "undeploying") {
        return { tone: "info", text: "Undeploying", href };
    }
    const failed = failedRollout(state, model.slug);
    if (failed) {
        return {
            tone: "destructive",
            text: model.deployed
                ? `Deploy failed · ${model.kind === "custom" && model.live !== null ? `v${model.live}` : "the old deployment"} still serves`
                : "Deploy failed",
            href: jobHref(failed.id),
            reason: failed.error,
        };
    }
    const unhealthy = unhealthyReason(model, state.mode);
    if (unhealthy) {
        return {
            tone: "warning",
            text: "Unhealthy",
            reason: unhealthy,
            href: `${modelHref(model.slug, "monitoring")}#deployment`,
        };
    }
    if (model.deployed) {
        const last = lastRollout(state, model.slug);
        const version =
            model.kind === "custom" && model.live !== null
                ? model.canary
                    ? ` · v${model.live} ${100 - model.canary.share}% · v${model.canary.version} ${model.canary.share}%`
                    : ` · v${model.live}`
                : "";
        return {
            tone: "success",
            text: `Deployed${version}`,
            href: last ? jobHref(last.id) : undefined,
        };
    }
    return { tone: "neutral", text: "Not deployed" };
}

export function liveReplicas(model: FlowModel): number {
    if (model.kind === "custom") {
        return model.replicas.length;
    }
    return model.variants.reduce((total, item) => total + item.replicas.length, 0);
}

export function machinePools(machine: Machine): string[] {
    return [
        ...new Set(machine.gpus.length > 0 ? machine.gpus.map((gpu) => gpu.pool) : [machine.pool]),
    ];
}

export function hardware(machine: Machine): string {
    const gpus = machine.gpus;
    const gpuText =
        gpus.length > 0 ? `${gpus.length}× ${gpus[0].name} ${gpus[0].memory} GB` : "no GPU";
    return `${machine.cpu} vCPU · ${machine.ram} GB RAM · ${gpuText}`;
}

export function adapterCount(engine: LoadedEngine): number {
    return engine.adapters.filter((adapter) => adapter.trained).length;
}
