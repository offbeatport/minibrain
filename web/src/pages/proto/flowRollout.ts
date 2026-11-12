import type { LogEntry } from "obp-ui";
import {
    type Placement,
    type Serve,
    baseUsers,
    completeDeploy,
    computeNow,
    deployedPlacements,
    dropLoading,
    enginesOf,
    isCached,
    markCached,
    placementNames,
    releaseBase,
    serveOf,
    setRolloutPhase,
    startLoading,
    stopRouting,
    type useCompute,
} from "./flowCompute";
import {
    DEFAULT_CONTEXT,
    type FlowModel,
    type FlowState,
    type Job,
    type Mode,
    OOM_ERROR,
    type Rollout,
    type RolloutStep,
    type RolloutStepKey,
    STEP_MS,
    type StepState,
    addJob,
    changeJob,
    findVersion,
    flowMode,
    flowState,
    liveVersion,
    makeLive,
    markVisited,
    newJobId,
    variantKey,
} from "./modelsFlowData";

type Compute = ReturnType<typeof useCompute>;

const TICK = 200;
const FAIL_AT = 0.7;
const REUSE_MS = 600;
const SKIP_MS = 300;

type Run = {
    mode: Mode;
    id: number;
    kind: "deploy" | "undeploy";
    target: string;
    pool: string;
    serve: Serve;
    placements: Placement[];
    loading: Placement[];
    fail: boolean;
    version: number | null;
    swap: boolean;
    source?: "inbox";
    steps: RolloutStep[];
    index: number;
    started: number;
    timer: number;
};

const runs = new Map<number, Run>();

export type DeploySlot = { placement: Placement; loaded: boolean };

export type DeployRequest = {
    model: FlowModel;
    target: string;
    pool: string;
    slots: DeploySlot[];
    context: number;
    change: boolean;
    version: number | null;
};

function stepMs(run: Run, step: RolloutStep): number {
    if (step.state === "skipped") {
        return SKIP_MS;
    }
    if (step.key === "load" && run.loading.length === 0) {
        return REUSE_MS;
    }
    return STEP_MS[step.key];
}

function progressOf(run: Run, now: number): number {
    const total = run.steps.reduce((sum, step) => sum + STEP_MS[step.key], 0);
    const done = run.steps.reduce((sum, step) => {
        if (step.state === "done" || step.state === "skipped") {
            return sum + STEP_MS[step.key];
        }
        if (step.state === "running" && step.start !== null) {
            const part = Math.min(1, (now - step.start) / stepMs(run, step));
            return sum + part * STEP_MS[step.key];
        }
        return sum;
    }, 0);
    return Math.min(0.99, done / Math.max(1, total));
}

function write(run: Run, change: Partial<Job> = {}) {
    const steps = run.steps.map((step) => ({ ...step }));
    changeJob(run.mode, run.id, (job) => ({
        ...job,
        progress: progressOf(run, Date.now()),
        ...change,
        rollout: job.rollout ? { ...job.rollout, steps } : job.rollout,
    }));
}

function finish(run: Run, status: "done" | "failed" | "cancelled", error?: string) {
    window.clearInterval(run.timer);
    runs.delete(run.id);
    if (run.swap) {
        setRolloutPhase(run.mode, run.target, null);
    }
    const seconds = Math.round((Date.now() - run.started) / 100) / 10;
    write(run, {
        status,
        progress: status === "done" ? 1 : progressOf(run, Date.now()),
        seconds,
        error,
    });
}

function phase(run: Run, kind: "deploying" | "loading" | "undeploying") {
    setRolloutPhase(run.mode, run.target, {
        phase: kind,
        since: Date.now(),
        ms: STEP_MS.load,
        pool: run.pool,
        placements: run.placements,
        loads: run.loading.length > 0,
        job: run.id,
    });
}

function onStart(run: Run, step: RolloutStep) {
    if (step.key === "load") {
        phase(run, "loading");
        if (run.loading.length > 0) {
            startLoading(run.mode, run.loading, run.serve, STEP_MS.load, run.id);
        }
    }
    if (step.key === "release") {
        const users = baseUsers(run.target, run.placements, run.serve);
        if (users.length > 0) {
            step.state = "skipped";
            step.note = `Kept: ${users.join(", ")} still ${users.length === 1 ? "uses" : "use"} it`;
        }
    }
}

function onDone(run: Run, step: RolloutStep) {
    if (step.key === "download") {
        markCached(
            run.mode,
            run.placements.map((placement) => placement.machine),
            run.serve.base,
        );
    }
    if (step.key === "route") {
        const model = flowState().models.find((item) => item.slug === run.target);
        if (model && run.version !== null && model.live !== run.version) {
            makeLive(model.slug, run.version, run.source);
        }
        if (!run.swap) {
            completeDeploy(run.mode, run.target, run.placements, run.serve);
        }
    }
    if (step.key === "stop") {
        stopRouting(run.target);
    }
}

function tick(run: Run) {
    const now = Date.now();
    const step = run.steps[run.index];
    if (!step) {
        finish(run, "done");
        return;
    }
    if (step.state === "pending") {
        step.state = "running";
        step.start = now;
        onStart(run, step);
        if (step.key === "release") {
            releaseNow(run);
        }
        write(run);
        return;
    }
    const elapsed = now - (step.start ?? now);
    const ms = stepMs(run, step);
    if (run.fail && step.key === "load" && elapsed >= ms * FAIL_AT) {
        step.state = "failed";
        step.end = now;
        dropLoading(run.mode, run.id);
        setRolloutPhase(run.mode, run.target, null);
        finish(run, "failed", OOM_ERROR);
        return;
    }
    if (elapsed >= ms) {
        if (step.state === "running") {
            step.state = "done";
        }
        step.end = now;
        onDone(run, step);
        run.index += 1;
        if (run.index >= run.steps.length) {
            finish(run, "done");
            return;
        }
    }
    write(run);
}

function releaseNow(run: Run) {
    releaseBase(run.mode, run.target, run.placements, run.serve, run.id);
}

function pending(keys: RolloutStepKey[]): RolloutStep[] {
    return keys.map((key) => ({ key, state: "pending", start: null, end: null }));
}

function launch(run: Omit<Run, "timer">, job: Job) {
    addJob(run.mode, job);
    const full = { ...run, timer: 0 } as Run;
    full.timer = window.setInterval(() => tick(full), TICK);
    runs.set(full.id, full);
}

function apiTarget(model: FlowModel, target: string): number | null {
    return target.includes("#") || model.kind === "base" ? null : model.live;
}

function rolloutJob(
    id: number,
    kind: "deploy" | "undeploy",
    model: FlowModel,
    version: number | null,
    rollout: Rollout,
): Job {
    return {
        id,
        kind,
        model: model.slug,
        version,
        status: "running",
        progress: 0,
        hoursAgo: 0,
        atMs: Date.now(),
        minutes: null,
        rollout,
    };
}

function currentPool(state: FlowState, target: string): string {
    const done = state.jobs
        .filter(
            (job) =>
                job.kind === "deploy" &&
                job.status === "done" &&
                job.rollout?.target === target &&
                job.rollout.pool,
        )
        .sort((a, b) => (b.atMs ?? 0) - (a.atMs ?? 0) || a.hoursAgo - b.hoursAgo);
    return done[0]?.rollout?.pool ?? "";
}

export function startVersionDeploy(model: FlowModel, number: number, source?: "inbox"): number {
    const mode = flowMode();
    const state = flowState();
    const serve = serveOf(model.slug, state);
    const target = findVersion(model, number);
    if (!serve || !target) {
        return 0;
    }
    const id = newJobId();
    const placements = deployedPlacements(model.slug);
    const steps = pending(["fetch", "attach", "route", "detach"]);
    const pool = currentPool(state, model.slug);
    const now = Date.now();
    const rollout: Rollout = {
        target: model.slug,
        pool,
        slots: placements,
        by: "You",
        context: DEFAULT_CONTEXT,
        loaded: true,
        cold: [],
        change: true,
        from: model.live,
        steps,
    };
    const run: Omit<Run, "timer"> = {
        mode,
        id,
        kind: "deploy",
        target: model.slug,
        pool,
        serve,
        placements,
        loading: [],
        fail: false,
        version: number,
        swap: true,
        source,
        steps,
        index: 0,
        started: now,
    };
    launch(run, rolloutJob(id, "deploy", model, number, rollout));
    phase(run as Run, "deploying");
    return id;
}

export function startDeploy(request: DeployRequest): number {
    const mode = flowMode();
    const state = flowState();
    const serve = serveOf(request.target, state);
    if (!serve) {
        return 0;
    }
    const id = newJobId();
    const placements = request.slots.map((slot) => slot.placement);
    const loading = request.slots.filter((slot) => !slot.loaded).map((slot) => slot.placement);
    const download =
        loading.length > 0 &&
        loading.some((placement) => !isCached(mode, placement.machine, serve.base));
    const adapter = request.model.kind === "custom";
    const keys: RolloutStepKey[] = [
        ...(download ? (["download"] as const) : []),
        "load",
        ...(adapter ? (["attach"] as const) : []),
        "route",
    ];
    const steps = pending(keys);
    const now = Date.now();
    const version = request.version ?? apiTarget(request.model, request.target);
    const rollout: Rollout = {
        target: request.target,
        pool: request.pool,
        slots: placements,
        by: "You",
        context: request.context,
        loaded: loading.length === 0,
        cold: loading,
        change: request.change,
        from: request.model.deployed ? request.model.live : null,
        steps,
    };
    const job = rolloutJob(id, "deploy", request.model, version, rollout);
    const run: Omit<Run, "timer"> = {
        mode,
        id,
        kind: "deploy",
        target: request.target,
        pool: request.pool,
        serve,
        placements,
        loading,
        fail: request.context > DEFAULT_CONTEXT && !serve.cpu,
        version,
        swap: false,
        steps,
        index: 0,
        started: now,
    };
    launch(run, job);
    phase(run as Run, "deploying");
    markVisited("infra-deploy");
    return id;
}

export function startUndeploy(model: FlowModel, target: string): number {
    const mode = flowMode();
    const state = flowState();
    const serve = serveOf(target, state);
    if (!serve) {
        return 0;
    }
    const id = newJobId();
    const placements = deployedPlacements(target);
    const keys: RolloutStepKey[] =
        model.kind === "custom" ? ["stop", "unload", "release"] : ["stop", "release"];
    const pool = currentPool(state, target);
    const steps = pending(keys);
    const now = Date.now();
    const job = rolloutJob(id, "undeploy", model, apiTarget(model, target), {
        target,
        pool,
        slots: placements,
        by: "You",
        context: DEFAULT_CONTEXT,
        loaded: true,
        cold: [],
        change: false,
        from: null,
        steps,
    });
    const run: Omit<Run, "timer"> = {
        mode,
        id,
        kind: "undeploy",
        target,
        pool,
        serve,
        placements,
        loading: [],
        fail: false,
        version: null,
        swap: false,
        steps,
        index: 0,
        started: now,
    };
    launch(run, job);
    phase(run as Run, "undeploying");
    markVisited("infra-undeploy");
    return id;
}

export function undeployTargets(model: FlowModel): string[] {
    if (model.kind === "custom") {
        return [model.slug];
    }
    return model.variants
        .filter((item) => item.live)
        .map((item) => variantKey(model.slug, item.id));
}

export function cancelRollout(id: number) {
    const run = runs.get(id);
    if (!run) {
        return;
    }
    const step = run.steps[run.index];
    if (step) {
        step.state = "cancelled";
        step.end = Date.now();
    }
    if (run.kind === "deploy") {
        dropLoading(run.mode, run.id);
    }
    setRolloutPhase(run.mode, run.target, null);
    finish(run, "cancelled");
}

function loadedSlots(target: string, slots: Placement[]): DeploySlot[] {
    const state = flowState();
    const serve = serveOf(target, state);
    const engines = enginesOf(state, computeNow(), Date.now());
    return slots.map((placement) => ({
        placement,
        loaded: engines.some(
            (engine) =>
                engine.state === "loaded" &&
                engine.placement.machine === placement.machine &&
                engine.placement.gpu === placement.gpu &&
                engine.serve.base === serve?.base &&
                engine.serve.format === serve?.format,
        ),
    }));
}

export function retryRollout(job: Job, context?: number): number {
    const state = flowState();
    const model = state.models.find((item) => item.slug === job.model);
    const rollout = job.rollout;
    if (!model || !rollout) {
        return 0;
    }
    if (job.kind === "undeploy") {
        return startUndeploy(model, rollout.target);
    }
    if (rollout.steps.some((step) => step.key === "fetch") && job.version !== null) {
        return startVersionDeploy(model, job.version);
    }
    return startDeploy({
        version: job.version,
        model,
        target: rollout.target,
        pool: rollout.pool,
        slots: loadedSlots(rollout.target, rollout.slots),
        context: context ?? rollout.context,
        change: rollout.change,
    });
}

export function isRunning(id: number): boolean {
    return runs.has(id);
}

export type StepView = {
    key: RolloutStepKey;
    label: string;
    detail: string;
    state: StepState;
    start: number | null;
    end: number | null;
    ms: number;
    note?: string;
};

export function apiNameOf(model: FlowModel | undefined, target: string): string {
    const [slug, variant] = target.split("#");
    if (!model) {
        return slug;
    }
    if (variant) {
        return model.variants.find((item) => item.id === variant)?.apiName ?? slug;
    }
    return model.slug;
}

export function versionText(model: FlowModel | undefined, job: Job): string | null {
    if (!model || job.version === null) {
        return null;
    }
    const version = findVersion(model, job.version);
    return version?.kind === "prompt" ? `v${job.version}, prompt only` : `v${job.version}`;
}

function sizeOf(serve: Serve): string {
    return `${serve.memory} GB`;
}

export function whereOf(job: Job, compute: Compute): string {
    return placementNames(job.rollout?.slots ?? [], compute);
}

export function stepViews(job: Job, state: FlowState, compute: Compute): StepView[] {
    const rollout = job.rollout;
    if (!rollout) {
        return [];
    }
    const model = state.models.find((item) => item.slug === job.model);
    const serve = serveOf(rollout.target, state);
    const label = serve?.label ?? rollout.target;
    const where = whereOf(job, compute);
    const api = apiNameOf(model, rollout.target);
    const machines = [...new Set(rollout.slots.map((slot) => slot.machine))].join(", ");
    const cold = rollout.cold ?? [];
    const warm = rollout.slots.filter(
        (slot) => !cold.some((item) => item.machine === slot.machine && item.gpu === slot.gpu),
    );
    const coldMachines = [...new Set(cold.map((slot) => slot.machine))].join(", ");
    const coldWhere = cold.length > 0 ? placementNames(cold, compute) : where;
    const warmWhere = cold.length > 0 && warm.length > 0 ? placementNames(warm, compute) : "";
    const version = job.version;
    const prompt = model && version !== null && findVersion(model, version)?.kind === "prompt";
    const settings = model && version !== null ? findVersion(model, version)?.settings : null;
    const replicas = rollout.slots.length;
    const from = rollout.from;
    const fromPrompt = model && from !== null && findVersion(model, from)?.kind === "prompt";
    const text: Record<RolloutStepKey, [string, string]> = {
        fetch: [
            prompt ? `Fetch v${version} instructions` : `Fetch adapter v${version} (84 MB)`,
            prompt
                ? "Prompt only: nothing to download"
                : `From main storage to ${machines}; same base, so no fit check or base load`,
        ],
        detach: [
            from === null ? "Detach the old adapter" : `Detach the old adapter (v${from})`,
            from === null
                ? "Nothing was deployed before"
                : fromPrompt
                  ? `v${from} was prompt only; nothing to unload`
                  : `v${from} stays callable as ${api}@${from} and reloads on demand`,
        ],
        download: [
            "Download weights",
            `${label}, ${serve ? sizeOf(serve) : ""}, from main storage to ${coldMachines || machines}`,
        ],
        load: [
            `Load the base on ${rollout.loaded ? where : coldWhere}`,
            rollout.loaded
                ? `${label} was already loaded there, so the engine reuses it`
                : `${label} with a ${rollout.context.toLocaleString("en-US")}-token context${warmWhere ? `; ${warmWhere} already has it loaded` : ""}`,
        ],
        attach: [
            version === null
                ? "Attach adapters (none yet)"
                : prompt
                  ? `Apply v${version} instructions`
                  : rollout.from !== null && rollout.steps.some((step) => step.key === "fetch")
                    ? `Attach v${version} on ${where}`
                    : `Attach adapters (v${version})`,
            version === null
                ? "No version is deployed, so it answers as the base"
                : prompt
                  ? "Prompt only: no adapter to load"
                  : `${model?.name} v${version} · ${settings?.adapter ?? "LoRA"} rank ${settings?.rank ?? 16}`,
        ],
        route: [
            `Route ${api}`,
            `Calls to ${api} on /v1 go to ${replicas} ${replicas === 1 ? "replica" : "replicas"}${rollout.pool ? ` in ${rollout.pool}` : ""}`,
        ],
        stop: [`Stop routing ${api}`, `Calls to ${api} on /v1 get an error from now on`],
        unload: [
            version === null ? "Unload adapters" : `Unload adapters (v${version})`,
            `Frees the adapter on ${where}`,
        ],
        release: [
            "Release the base",
            `Unloads ${label} from ${where} if no other deployment needs it`,
        ],
    };
    return rollout.steps.map((step) => {
        const [title, detail] = text[step.key];
        const ms =
            step.key === "load" && rollout.loaded
                ? REUSE_MS
                : step.state === "skipped"
                  ? SKIP_MS
                  : STEP_MS[step.key];
        return { ...step, label: title, detail, ms };
    });
}

type Line = [number, LogEntry["level"], string, string];

function stepLines(
    step: StepView,
    job: Job,
    compute: Compute,
    context: { serve: Serve | null; api: string; model: FlowModel | undefined },
): Line[] {
    const rollout = job.rollout;
    const { serve, api, model } = context;
    const first = rollout?.cold?.[0] ?? rollout?.slots[0];
    const where =
        rollout && rollout.cold.length > 0
            ? placementNames(rollout.cold, compute)
            : whereOf(job, compute);
    const label = serve?.label ?? "";
    const gpu = first?.gpu;
    const machine = compute.machines.find((item) => item.id === first?.machine);
    const engine = machine?.engine ?? "SGLang";
    const tokens = (rollout?.context ?? DEFAULT_CONTEXT).toLocaleString("en-US");
    const failed = step.state === "failed";
    const memory = serve?.memory ?? 16;
    const kv = rollout && rollout.context > DEFAULT_CONTEXT ? 5.5 : 1.4;
    switch (step.key) {
        case "fetch":
            return [
                [
                    0,
                    "info",
                    "rollout",
                    `Fetching adapter ${model?.slug}-v${job.version} (84 MB) to ${first?.machine}`,
                ],
                [0.9, "info", "transfer", "Checked SHA-256 3f9a1c…e07b against the version record"],
            ];
        case "detach":
            return rollout?.from === null || rollout?.from === undefined
                ? [[0.5, "info", "rollout", "No previous adapter to detach"]]
                : [
                      [0.2, "info", "gateway", `Drained 1 request still on v${rollout.from}`],
                      [
                          0.8,
                          "info",
                          engine.toLowerCase(),
                          `Unloaded adapter ${model?.slug}-v${rollout.from}; 1 adapter loaded`,
                      ],
                  ];
        case "download":
            return [
                [
                    0,
                    "info",
                    "rollout",
                    `Fetching ${label} (${memory} GB) from main storage to ${first?.machine}`,
                ],
                [
                    0.25,
                    "info",
                    "transfer",
                    `${Math.round(memory * 0.25 * 10) / 10} of ${memory} GB · 412 MB/s`,
                ],
                [
                    0.5,
                    "info",
                    "transfer",
                    `${Math.round(memory * 0.5 * 10) / 10} of ${memory} GB · 418 MB/s`,
                ],
                [
                    0.75,
                    "info",
                    "transfer",
                    `${Math.round(memory * 0.75 * 10) / 10} of ${memory} GB · 405 MB/s`,
                ],
                [0.98, "info", "transfer", "Checked SHA-256 of every shard against the catalogue"],
            ];
        case "load":
            if (rollout?.loaded) {
                return [
                    [
                        0.1,
                        "info",
                        "scheduler",
                        `${label} is already loaded on ${where}; reusing the engine`,
                    ],
                ];
            }
            return [
                [
                    0,
                    "info",
                    "scheduler",
                    `Placing on ${where}: estimate ${memory} GB weights, fits`,
                ],
                [
                    0.05,
                    "info",
                    engine.toLowerCase(),
                    `Starting ${engine} 0.4.6 on cuda:${gpu ?? 0} (${machine?.gpus.find((item) => item.index === gpu)?.name ?? "CPU"})`,
                ],
                [
                    0.1,
                    "info",
                    engine.toLowerCase(),
                    `max_model_len=${tokens} dtype=${serve?.format.toLowerCase() ?? "bf16"} gpu_memory_utilization=0.90`,
                ],
                [0.25, "info", engine.toLowerCase(), "Loading safetensors shards: 1/4"],
                [0.4, "info", engine.toLowerCase(), "Loading safetensors shards: 2/4"],
                [0.55, "info", engine.toLowerCase(), "Loading safetensors shards: 3/4"],
                ...(failed
                    ? ([
                          [0.62, "info", engine.toLowerCase(), `Model weights took ${memory} GB`],
                          [
                              0.66,
                              "warning",
                              engine.toLowerCase(),
                              `KV cache for ${tokens} tokens needs ${kv} GB more than the scheduler estimated`,
                          ],
                          [
                              0.7,
                              "error",
                              engine.toLowerCase(),
                              `torch.OutOfMemoryError: ${OOM_ERROR}`,
                          ],
                          [
                              0.72,
                              "info",
                              "rollout",
                              `Stopped the engine on ${where} and released its memory`,
                          ],
                      ] as Line[])
                    : ([
                          [0.7, "info", engine.toLowerCase(), "Loading safetensors shards: 4/4"],
                          [0.75, "info", engine.toLowerCase(), `Model weights took ${memory} GB`],
                          [
                              0.82,
                              "info",
                              engine.toLowerCase(),
                              `KV cache: ${kv} GB for ${tokens} tokens`,
                          ],
                          [
                              0.9,
                              "info",
                              engine.toLowerCase(),
                              "Captured CUDA graphs for batch sizes 1 to 32",
                          ],
                          [
                              0.99,
                              "info",
                              engine.toLowerCase(),
                              `Engine ready on :30001 in ${(step.ms / 1000).toFixed(1)} s`,
                          ],
                      ] as Line[])),
            ];
        case "attach": {
            const version = job.version;
            if (version === null || !model) {
                return [[0.2, "info", "rollout", "No version deployed; it answers as the base"]];
            }
            const kind = findVersion(model, version)?.kind;
            if (kind === "prompt") {
                return [
                    [
                        0.3,
                        "info",
                        "rollout",
                        `Applied v${version} instructions; no adapter to load`,
                    ],
                ];
            }
            return [
                [
                    0.1,
                    "info",
                    "rollout",
                    `Loading LoRA adapter ${model.slug}-v${version} (84 MB, sha256 3f9a1c…e07b)`,
                ],
                [
                    0.6,
                    "info",
                    engine.toLowerCase(),
                    `Registered adapter ${model.slug}-v${version}; 1 adapter loaded`,
                ],
                [0.9, "info", "rollout", "Warm-up request answered in 182 ms"],
            ];
        }
        case "route":
            return [
                [
                    0.2,
                    "info",
                    "gateway",
                    `Route ${api} → ${where} (${rollout?.slots.length ?? 1} ${(rollout?.slots.length ?? 1) === 1 ? "replica" : "replicas"})`,
                ],
                [0.8, "info", "gateway", "Health check passed: GET /health 200 in 3 ms"],
            ];
        case "stop":
            return [
                [
                    0.1,
                    "info",
                    "gateway",
                    `Removed the route for ${api}; draining 2 requests in flight`,
                ],
                [0.9, "info", "gateway", "Drained; new calls get 404 model_not_deployed"],
            ];
        case "unload":
            return [
                [
                    0.5,
                    "info",
                    engine.toLowerCase(),
                    `Unloaded adapter ${api}${job.version === null ? "" : `-v${job.version}`}; 0 adapters loaded`,
                ],
            ];
        case "release":
            return step.state === "skipped"
                ? [[0.5, "info", "scheduler", `${step.note ?? "Kept the base"}; nothing to unload`]]
                : [
                      [0.1, "info", "scheduler", `No other deployment needs ${label} on ${where}`],
                      [0.9, "info", engine.toLowerCase(), `Engine stopped; freed ${memory} GB`],
                  ];
        default:
            return [];
    }
}

export function rolloutLog(job: Job, state: FlowState, compute: Compute, now: number): LogEntry[] {
    const rollout = job.rollout;
    if (!rollout) {
        return [];
    }
    const model = state.models.find((item) => item.slug === job.model);
    const serve = serveOf(rollout.target, state);
    const api = apiNameOf(model, rollout.target);
    const views = stepViews(job, state, compute);
    const start = (views[0]?.start ?? now) - 400;
    const entries: LogEntry[] = [];
    const push = (time: number, level: LogEntry["level"], source: string, message: string) => {
        if (time <= now) {
            entries.push({ id: entries.length + 1, time, level, source, message });
        }
    };
    const version = versionText(model, job);
    push(
        start,
        "info",
        "rollout",
        `Rollout #${job.id}: ${job.kind} ${api}${version ? ` ${version}` : ""}${rollout.pool ? ` to pool ${rollout.pool}` : ""}, requested by ${rollout.by}`,
    );
    push(
        start + 50,
        "info",
        "rollout",
        `Plan: ${views.map((view) => view.label.charAt(0).toLowerCase() + view.label.slice(1)).join(" → ")}`,
    );
    for (const view of views) {
        if (view.start === null) {
            continue;
        }
        const span = view.end !== null ? view.end - view.start : view.ms;
        for (const [at, level, source, message] of stepLines(view, job, compute, {
            serve,
            api,
            model,
        })) {
            push(view.start + at * span, level, source, message);
        }
    }
    const end = Math.max(...views.map((view) => view.end ?? 0));
    if (job.status === "done") {
        push(
            end + 10,
            "info",
            "rollout",
            `Rollout done in ${job.seconds ?? ((end - start) / 1000).toFixed(1)} s`,
        );
    }
    if (job.status === "failed") {
        const at = views.findIndex((view) => view.state === "failed") + 1;
        push(
            end + 10,
            "error",
            "rollout",
            `Rollout failed at step ${at} of ${views.length}; nothing was routed to it${rollout.change ? `, and ${api} keeps its previous deployment` : ""}`,
        );
    }
    if (job.status === "cancelled") {
        push(
            end + 10,
            "warning",
            "rollout",
            `Cancelled by ${rollout.by}; undid the steps that ran`,
        );
    }
    return entries;
}

const ENGINE_SPAN = 12 * 60000;
const BEAT = 5000;

export function engineLog(
    model: FlowModel,
    placement: Placement,
    compute: Compute,
    now: number,
    since: number,
    unhealthy: string | null,
): LogEntry[] {
    const machine = compute.machines.find((item) => item.id === placement.machine);
    const engine = (machine?.engine ?? "SGLang").toLowerCase();
    const live = liveVersion(model);
    const adapter =
        model.kind === "custom" && live?.kind === "trained"
            ? `${model.slug}-v${live.number}`
            : null;
    const entries: LogEntry[] = [];
    const first = Math.max(since, now - ENGINE_SPAN);
    const push = (time: number, level: LogEntry["level"], source: string, message: string) =>
        entries.push({ id: `${time}:${entries.length}`, time, level, source, message });
    if (since >= now - ENGINE_SPAN) {
        push(since, "info", engine, `Engine ready on :30001 (cuda:${placement.gpu ?? 0})`);
        if (adapter) {
            push(since + 900, "info", engine, `Loaded LoRA adapter ${adapter} (84 MB)`);
        }
    } else {
        push(
            first,
            "info",
            engine,
            `Log tail from ${new Date(first).toLocaleTimeString("en-GB")}; engine up since ${new Date(since).toLocaleString("en-GB")}`,
        );
        if (adapter) {
            push(
                first + 10,
                "info",
                engine,
                `Serving adapter ${adapter} and ${model.kind === "custom" ? "no other models" : "the base"} on this replica`,
            );
        }
    }
    const startBeat = Math.ceil(first / BEAT) * BEAT;
    for (let at = startBeat; at <= now; at += BEAT) {
        const n = Math.floor(at / BEAT);
        if (unhealthy && n % 24 === 7) {
            push(at, "error", "health", "GET /health timed out after 5 s");
            push(at + 300, "warning", engine, "Watchdog restarted the engine (attempt 3 of 5)");
            continue;
        }
        push(at, "info", "health", `GET /health 200 · ${2 + (n % 3)} ms`);
        if (n % 6 === 0) {
            const running = (n * 7) % 5;
            push(
                at + 120,
                "info",
                engine,
                `Decode batch: ${running} running, 0 queued · KV cache ${18 + ((n * 13) % 30)}% · ${30 + ((n * 11) % 25)} tok/s`,
            );
        }
        if (n % 37 === 0) {
            push(at + 240, "warning", engine, "Request 8f3a… hit max_tokens 256; answer truncated");
        }
        if (n % 53 === 0) {
            push(
                at + 260,
                "warning",
                engine,
                "KV cache 86% full; preempted 1 request and requeued it",
            );
        }
    }
    return entries.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
}
