import { useSyncExternalStore } from "react";
import { type AvatarChoice, choiceFor } from "~/components/avatar/avatarSvg";

export type VersionKind = "trained" | "prompt";
export type VersionStatus = "ready" | "training" | "failed";
export type Adapter = "LoRA" | "QLoRA";

export type TrainingSettings = {
    adapter: Adapter;
    rank: number;
    epochs: number;
    learningRate: number;
    rows: number;
    batch: number;
};

export type DataVersion = {
    number: number;
    rows: number;
    added: number;
    removed: number;
    relabelled: number;
};

export type FlowVersion = {
    number: number;
    kind: VersionKind;
    status: VersionStatus;
    scores: [number, number] | null;
    passed: boolean | null;
    hoursAgo: number;
    atMs?: number;
    wasLive: boolean;
    progress?: number;
    jobId: number;
    error?: string;
    data: DataVersion;
    settings: TrainingSettings | null;
    p50: number | null;
};

export type BaseVariant = {
    id: string;
    format: string;
    size: string;
    apiName: string;
    live: boolean;
    trainable: boolean;
    replicas: string[];
    traffic: number[];
    previous: number;
    gpuSeconds: number;
    p95: number | null;
    update: string | null;
};

export type Autopilot = {
    threshold: number;
    canary: number;
    minutes: number;
    revertOnErrors: boolean;
    revertOnScore: boolean;
    run: { version: number; minutesLeft: number } | null;
};

export type Canary = { version: number; share: number };

export type RecentAnswer = {
    question: string;
    answer: string;
    minutesAgo: number;
};

export type FlowModel = {
    slug: string;
    name: string;
    kind: "custom" | "base";
    publisher: string;
    base: string | null;
    description: string;
    metrics: [string, string];
    rule: [number, number];
    heldOut: number;
    live: number | null;
    deployed: boolean;
    traffic: number[];
    previous: number;
    serveOnly: boolean;
    size: string | null;
    versions: FlowVersion[];
    avatar: AvatarChoice | null;
    dataset: string | null;
    accepted: number;
    p95: number;
    errors: number;
    usualErrors: number;
    licence: string;
    task: string;
    gpuSeconds: number;
    replicas: string[];
    variants: BaseVariant[];
    autopilot: Autopilot | null;
    canary: Canary | null;
    recipe: TrainingSettings | null;
    pinned: boolean;
    recent: RecentAnswer[];
    trainAt: number;
    tags: string[];
    instructions: string;
    safety: string | null;
};

const CLASSIFY: [string, string] = ["Label accuracy", "Macro F1"];
const EXTRACT: [string, string] = ["Field accuracy", "Exact match"];
const SQL: [string, string] = ["Result match", "Valid SQL"];

function settings(
    rank: number,
    epochs: number,
    learningRate: number,
    rows: number,
): TrainingSettings {
    return { adapter: "LoRA", rank, epochs, learningRate, rows, batch: 8 };
}

function data(
    number: number,
    rows: number,
    added: number,
    removed: number,
    relabelled = 0,
): DataVersion {
    return { number, rows, added, removed, relabelled };
}

function trained(
    number: number,
    scores: [number, number] | null,
    passed: boolean | null,
    hoursAgo: number,
    extra: Partial<FlowVersion> & Pick<FlowVersion, "data" | "settings">,
): FlowVersion {
    return {
        number,
        kind: "trained",
        status: "ready",
        scores,
        passed,
        hoursAgo,
        wasLive: false,
        jobId: 1000 + number * 7,
        p50: 42 + number,
        ...extra,
    };
}

function promptOnly(
    scores: [number, number],
    passed: boolean,
    hoursAgo: number,
    rows: number,
): FlowVersion {
    return {
        number: 0,
        kind: "prompt",
        status: "ready",
        scores,
        passed,
        hoursAgo,
        wasLive: false,
        jobId: 900,
        data: data(1, rows, rows, 0),
        settings: null,
        p50: 38,
    };
}

const DAY = 24;

const OUT_OF_MEMORY =
    "Out of memory at step 212 of 720 on gpu-a10-1. Retry with QLoRA, a lower batch or gradient checkpointing.";

const SUPPORT_TRIAGE: FlowVersion[] = [
    promptOnly([0.712, 0.642], false, 34 * DAY, 1210),
    trained(1, [0.804, 0.771], true, 33 * DAY, {
        wasLive: true,
        data: data(2, 1420, 210, 0),
        settings: settings(16, 3, 2e-4, 1278),
    }),
    trained(2, [0.829, 0.8], true, 30 * DAY, {
        wasLive: true,
        data: data(3, 1610, 236, 46, 12),
        settings: settings(16, 3, 2e-4, 1449),
    }),
    trained(3, [0.841, 0.818], true, 26 * DAY, {
        wasLive: true,
        data: data(5, 1702, 120, 28),
        settings: settings(16, 4, 2e-4, 1532),
    }),
    trained(4, [0.867, 0.846], true, 21 * DAY, {
        data: data(7, 1876, 204, 30, 9),
        settings: settings(16, 3, 2e-4, 1688),
    }),
    trained(5, [0.881, 0.866], true, 6 * DAY, {
        data: data(8, 2140, 312, 48, 14),
        settings: settings(32, 3, 1e-4, 1928),
    }),
    trained(6, [0.842, 0.81], false, 5 * DAY, {
        data: data(8, 2140, 0, 0),
        settings: settings(32, 2, 1e-4, 1928),
    }),
    trained(7, null, null, 3 * DAY, {
        status: "failed",
        error: OUT_OF_MEMORY,
        data: data(9, 2290, 162, 12),
        settings: settings(64, 3, 1e-4, 2061),
    }),
    trained(8, null, null, 0.4, {
        status: "training",
        progress: 0.45,
        jobId: 1188,
        data: data(10, 2290, 0, 0),
        settings: settings(32, 3, 1e-4, 2061),
    }),
];

const INVOICE_EXTRACTOR: FlowVersion[] = [
    promptOnly([0.62, 0.41], false, 12 * DAY, 640),
    trained(1, [0.815, 0.702], true, 9 * DAY, {
        wasLive: true,
        data: data(2, 880, 240, 0),
        settings: settings(16, 3, 2e-4, 792),
    }),
    trained(2, [0.838, 0.731], true, 4 * DAY, {
        data: data(3, 1140, 290, 30),
        settings: settings(16, 3, 2e-4, 1026),
    }),
    trained(3, [0.851, 0.748], true, 21, {
        data: data(4, 1190, 50, 0),
        settings: settings(16, 3, 2e-4, 1071),
    }),
];

const CONTRACT_REVIEWER: FlowVersion[] = [
    promptOnly([0.58, 0.51], false, 20 * DAY, 420),
    trained(1, [0.774, 0.72], true, 15 * DAY, {
        data: data(2, 610, 190, 0),
        settings: settings(16, 3, 2e-4, 549),
    }),
    trained(2, [0.741, 0.7], false, 8 * DAY, {
        data: data(3, 780, 180, 10),
        settings: settings(16, 4, 2e-4, 702),
    }),
    trained(3, null, null, 5, {
        status: "failed",
        jobId: 1176,
        error: OUT_OF_MEMORY,
        data: data(4, 1020, 260, 20),
        settings: settings(64, 4, 2e-4, 918),
    }),
];

const GUY1: FlowVersion[] = [promptOnly([0.66, 0.6], true, 3 * DAY, 80)];

const SQL_HELPER: FlowVersion[] = [promptOnly([0.583, 0.912], false, 2 * DAY, 300)];

function week(values: number[], previous: number) {
    return { traffic: values, previous };
}

type RawModel = Omit<
    FlowModel,
    | "avatar"
    | "dataset"
    | "accepted"
    | "p95"
    | "errors"
    | "usualErrors"
    | "licence"
    | "task"
    | "gpuSeconds"
    | "replicas"
    | "variants"
    | "autopilot"
    | "canary"
    | "recipe"
    | "pinned"
    | "recent"
    | "trainAt"
    | "tags"
    | "instructions"
    | "safety"
>;

function variant(
    id: string,
    format: string,
    size: string,
    apiName: string,
    gpuSeconds: number,
    extra: Partial<BaseVariant> = {},
): BaseVariant {
    return {
        id,
        format,
        size,
        apiName,
        live: false,
        trainable: true,
        replicas: [],
        traffic: [0, 0, 0, 0, 0, 0, 0],
        previous: 0,
        gpuSeconds,
        p95: null,
        update: null,
        ...extra,
    };
}

const VARIANTS: Record<string, BaseVariant[]> = {
    "qwen3-8b": [
        variant("bf16", "BF16", "16 GB", "qwen3-8b", 9.6, {
            live: true,
            replicas: ["gpu-a10-2"],
            traffic: [120, 140, 132, 168, 150, 60, 41],
            previous: 760,
            p95: 410,
        }),
        variant("fp8", "FP8", "8 GB", "qwen3-8b-fp8", 5.1, {
            live: true,
            trainable: false,
            replicas: ["local"],
            traffic: [90, 120, 108, 132, 138, 30, 34],
            previous: 560,
            p95: 290,
        }),
        variant("gguf-q4", "GGUF Q4", "5 GB", "qwen3-8b-gguf-q4", 3.8, {
            trainable: false,
            update: "Upstream rebuilt the Q4_K_M weights on 2 Nov with a tokenizer fix; 5 GB to download.",
        }),
    ],
    "qwen3-0.6b": [variant("bf16", "BF16", "1.4 GB", "qwen3-0.6b", 0.8)],
    "llama-3.2-1b": [
        variant("bf16", "BF16", "2.5 GB", "llama-3.2-1b", 1.3, {
            live: true,
            replicas: ["gpu-a10-1"],
            traffic: [40, 35, 52, 61, 48, 12, 8],
            previous: 230,
            p95: 150,
        }),
        variant("fp8", "FP8", "1.3 GB", "llama-3.2-1b-fp8", 0.9, {
            trainable: false,
        }),
    ],
};

type Extra = Pick<FlowModel, "task" | "gpuSeconds" | "replicas" | "p95" | "recent"> & {
    autopilot?: Autopilot;
    canary?: Canary;
    errors?: number;
    usualErrors?: number;
};

function answer(question: string, text: string, minutesAgo: number): RecentAnswer {
    return { question, answer: text, minutesAgo };
}

const EXTRA: Record<string, Extra> = {
    "support-triage": {
        task: "Classify",
        gpuSeconds: 9.6,
        replicas: ["gpu-a10-2"],
        p95: 240,
        recent: [
            answer("Need my money back for the duplicate seat.", "refund_request", 2),
            answer("The app logs me out every 5 minutes.", "account_access", 6),
            answer("Where is my order? Tracking hasn't moved in 5 days.", "shipping", 9),
        ],
    },
    "invoice-extractor": {
        task: "Extract",
        gpuSeconds: 1.4,
        replicas: ["gpu-a10-1"],
        p95: 310,
        errors: 0.04,
        usualErrors: 0.005,
        canary: { version: 3, share: 10 },
        autopilot: {
            threshold: 50,
            canary: 10,
            minutes: 1440,
            revertOnErrors: true,
            revertOnScore: true,
            run: { version: 3, minutesLeft: 240 },
        },
        recent: [
            answer("Invoice INV-2291 from Nordlicht GmbH", "total 1,420.00 · due 30 Nov", 4),
            answer("Rechnung 88-104, Bäckerei Lind", "total 312.40 · due 21 Nov", 11),
            answer("Invoice 2026-0457 from Harbor Freight Co.", "total 9,870.00 · due 5 Dec", 18),
        ],
    },
    "contract-reviewer": {
        task: "Classify",
        gpuSeconds: 2.1,
        replicas: ["gpu-a10-1"],
        p95: 280,
        errors: 0.021,
        usualErrors: 0.02,
        recent: [
            answer("Clause 14.2: supplier may raise prices at any time.", "risky", 35),
            answer("Clause 3.1: payment within 30 days of invoice.", "standard", 52),
            answer("Clause 9: unlimited liability for the buyer.", "risky", 80),
        ],
    },
    guy1: {
        task: "Classify",
        gpuSeconds: 0.7,
        replicas: ["local"],
        p95: 95,
        recent: [answer("test", "billing", 300)],
    },
    "sql-helper": {
        task: "SQL",
        gpuSeconds: 3.8,
        replicas: [],
        p95: 0,
        recent: [],
    },
};

const BASE_RECENT: RecentAnswer[] = [
    answer("Summarise this ticket in one line.", "A refund request for a duplicate charge.", 3),
    answer("Translate to German: the parcel is late.", "Das Paket ist verspätet.", 7),
    answer("Is 2027 a leap year?", "No. The next one is 2028.", 15),
];

function sumDays(series: number[][]): number[] {
    return Array.from({ length: 7 }, (_, day) =>
        series.reduce((total, values) => total + (values[day] ?? 0), 0),
    );
}

function summarise(model: FlowModel): FlowModel {
    if (model.kind !== "base") {
        return model;
    }
    const live = model.variants.filter((item) => item.live);
    const weights = live.map((item) => item.traffic.reduce((total, value) => total + value, 0));
    const weight = weights.reduce((total, value) => total + value, 0);
    const p95 =
        weight > 0
            ? live.reduce((total, item, index) => total + (item.p95 ?? 0) * weights[index], 0) /
              weight
            : Math.max(0, ...live.map((item) => item.p95 ?? 0));
    return {
        ...model,
        deployed: live.length > 0,
        traffic: sumDays(model.variants.map((item) => item.traffic)),
        previous: model.variants.reduce((total, item) => total + item.previous, 0),
        serveOnly: model.variants.length > 0 && model.variants.every((item) => !item.trainable),
        size: model.variants[0]?.size ?? model.size,
        gpuSeconds: Math.min(...model.variants.map((item) => item.gpuSeconds), 99),
        replicas: [...new Set(live.flatMap((item) => item.replicas))],
        p95: Math.round(p95),
    };
}

function baseRaw(slug: string, name: string, publisher: string): RawModel {
    return {
        slug,
        name,
        kind: "base",
        publisher,
        base: null,
        description: "",
        metrics: CLASSIFY,
        rule: [0, 0],
        heldOut: 0,
        live: null,
        deployed: false,
        ...week([0, 0, 0, 0, 0, 0, 0], 0),
        serveOnly: false,
        size: null,
        versions: [],
    };
}

const RAW: RawModel[] = [
    {
        slug: "support-triage",
        name: "Support triage",
        kind: "custom",
        publisher: "Qwen",
        base: "Qwen3 8B",
        description: "Routes tickets to one of six queues.",
        metrics: CLASSIFY,
        rule: [0.85, 0.01],
        heldOut: 212,
        live: 4,
        deployed: true,
        ...week([412, 388, 455, 501, 476, 230, 198], 2810),
        serveOnly: false,
        size: null,
        versions: SUPPORT_TRIAGE,
    },
    {
        slug: "invoice-extractor",
        name: "Invoice extractor",
        kind: "custom",
        publisher: "Meta",
        base: "Llama 3.2 1B",
        description: "Pulls totals, dates and vendor names out of invoices.",
        metrics: EXTRACT,
        rule: [0.8, 0.02],
        heldOut: 96,
        live: 2,
        deployed: true,
        ...week([88, 102, 95, 120, 131, 40, 22], 100),
        serveOnly: false,
        size: null,
        versions: INVOICE_EXTRACTOR,
    },
    {
        slug: "contract-reviewer",
        name: "Contract reviewer",
        kind: "custom",
        publisher: "Meta",
        base: "Llama 3.2 1B",
        description: "Flags risky clauses in supplier contracts.",
        metrics: CLASSIFY,
        rule: [0.75, 0.02],
        heldOut: 78,
        live: 1,
        deployed: true,
        ...week([14, 22, 18, 30, 26, 4, 9], 160),
        serveOnly: false,
        size: null,
        versions: CONTRACT_REVIEWER,
    },
    {
        slug: "guy1",
        name: "guy1",
        kind: "custom",
        publisher: "Qwen",
        base: "Qwen3 0.6B",
        description: "",
        metrics: CLASSIFY,
        rule: [0.6, 0.05],
        heldOut: 12,
        live: 0,
        deployed: true,
        ...week([0, 0, 0, 0, 2, 5, 4], 0),
        serveOnly: false,
        size: null,
        versions: GUY1,
    },
    {
        slug: "sql-helper",
        name: "SQL helper",
        kind: "custom",
        publisher: "Qwen",
        base: "Qwen3 8B GGUF Q4",
        description: "Writes SQL for the finance warehouse.",
        metrics: SQL,
        rule: [0.7, 0.02],
        heldOut: 40,
        live: null,
        deployed: false,
        ...week([0, 0, 0, 0, 0, 0, 0], 0),
        serveOnly: true,
        size: null,
        versions: SQL_HELPER,
    },
    baseRaw("qwen3-8b", "Qwen3 8B", "Qwen"),
    baseRaw("qwen3-0.6b", "Qwen3 0.6B", "Qwen"),
    baseRaw("llama-3.2-1b", "Llama 3.2 1B", "Meta"),
];

const DATASET_OF: Record<string, string> = {
    "support-triage": "tickets-archive",
    "invoice-extractor": "invoices-q3",
    "contract-reviewer": "supplier-contracts",
    guy1: "tickets-archive",
    "sql-helper": "finance-questions",
};

const LICENCES: Record<string, string> = {
    Qwen: "Apache 2.0",
    Meta: "Llama 3.2 Community",
};

const FIXED_JOBS = new Set([1176, 1188]);

const TAGS: Record<string, string[]> = {
    "support-triage": ["support", "routing"],
    "invoice-extractor": ["finance", "extraction"],
    "contract-reviewer": ["legal"],
    "sql-helper": ["finance", "sql"],
};

const INSTRUCTIONS: Record<string, string> = {
    "support-triage":
        "Read the ticket and answer with exactly one queue label.\nPick refund_request only when the customer asks for money back.\nNever answer with more than the label.",
    "invoice-extractor":
        "Return the vendor, invoice number, dates and total as JSON.\nUse ISO dates and the invoice currency.",
    "contract-reviewer":
        "Label each clause standard or risky.\nRisky means it shifts cost or liability to us.",
    "sql-helper":
        "Write one read-only SQL query for the finance warehouse.\nUse only the tables in the schema.",
};

function complete(model: RawModel, index: number): FlowModel {
    const extra = EXTRA[model.slug];
    return summarise({
        ...model,
        versions: model.versions.map((version) => ({
            ...version,
            jobId: FIXED_JOBS.has(version.jobId)
                ? version.jobId
                : 1000 + index * 40 + version.number,
        })),
        avatar: null,
        dataset: DATASET_OF[model.slug] ?? null,
        accepted: model.slug === "support-triage" ? 12 : 0,
        p95: extra?.p95 ?? 0,
        errors: extra?.errors ?? (model.deployed || model.kind === "base" ? 0.002 : 0),
        usualErrors: extra?.usualErrors ?? 0.003,
        licence: LICENCES[model.publisher] ?? "Apache 2.0",
        task: extra?.task ?? "Base",
        gpuSeconds: extra?.gpuSeconds ?? 0,
        replicas: extra?.replicas ?? [],
        variants: VARIANTS[model.slug] ?? [],
        autopilot: extra?.autopilot ?? null,
        canary: extra?.canary ?? null,
        recipe: null,
        pinned: false,
        recent: extra?.recent ?? BASE_RECENT,
        trainAt: 10,
        tags: TAGS[model.slug] ?? [],
        instructions: INSTRUCTIONS[model.slug] ?? "",
        safety: model.slug === "support-triage" ? "Llama Guard 3 1B" : null,
    });
}

const INITIAL: FlowModel[] = RAW.map(complete);

export type Check = { name: string; state: "ok" | "warning"; detail: string };

export type Dataset = {
    slug: string;
    name: string;
    file: string;
    rows: number;
    version: number;
    columns: [string, string];
    preview: [string, string][];
    labels: [string, number][];
    checks: Check[];
    split: [number, number];
    hoursAgo: number;
    atMs?: number;
};

const TICKET_LABELS: [string, number][] = [
    ["billing", 512],
    ["refund_request", 401],
    ["account_access", 388],
    ["bug_report", 366],
    ["shipping", 281],
    ["feature_request", 192],
];

const TICKET_PREVIEW: [string, string][] = [
    ["I was charged twice for my March invoice, please refund one.", "refund_request"],
    ["Can't log in since the password reset email never arrived.", "account_access"],
    ["The export button does nothing on Safari 17.", "bug_report"],
    ["Where is my order? Tracking hasn't moved in 5 days.", "shipping"],
    ["Please add dark mode to the mobile app.", "feature_request"],
    ["VAT number is missing from the PDF invoice.", "billing"],
];

const TICKET_CHECKS: Check[] = [
    { name: "Duplicates", state: "ok", detail: "No repeated rows." },
    {
        name: "Conflicting labels",
        state: "ok",
        detail: "No text carries two labels.",
    },
    {
        name: "Label balance",
        state: "warning",
        detail: "feature_request has 9% of rows; the others 13 to 24%.",
    },
    {
        name: "Leakage",
        state: "ok",
        detail: "No held-out text appears in training.",
    },
    {
        name: "Personal data",
        state: "ok",
        detail: "Emails and phone numbers scrubbed (41 rows).",
    },
];

function dataset(
    slug: string,
    name: string,
    file: string,
    rows: number,
    version: number,
    hoursAgo: number,
): Dataset {
    const heldOut = Math.round(rows * 0.1);
    return {
        slug,
        name,
        file,
        rows,
        version,
        columns: ["text", "label"],
        preview: TICKET_PREVIEW,
        labels: TICKET_LABELS.map(([label, count]) => [label, Math.round((count * rows) / 2140)]),
        checks: TICKET_CHECKS,
        split: [rows - heldOut, heldOut],
        hoursAgo,
    };
}

const DATASETS: Dataset[] = [
    dataset("tickets-archive", "Tickets archive", "tickets-archive.parquet", 2290, 10, 26),
    dataset("invoices-q3", "Invoices Q3", "invoices-q3.jsonl", 1140, 3, 9 * DAY),
    dataset("supplier-contracts", "Supplier contracts", "contracts.csv", 1020, 4, 5 * DAY),
    dataset("finance-questions", "Finance questions", "finance-questions.csv", 300, 1, 2 * DAY),
];

export const SAMPLE_FILE = "support-tickets.csv";

export type JobKind =
    | "train"
    | "score"
    | "judge"
    | "download"
    | "import"
    | "export"
    | "deploy"
    | "undeploy";

export type RolloutStepKey =
    | "download"
    | "load"
    | "fetch"
    | "attach"
    | "route"
    | "detach"
    | "stop"
    | "unload"
    | "release";

export type StepState = "pending" | "running" | "done" | "failed" | "skipped" | "cancelled";

export type RolloutStep = {
    key: RolloutStepKey;
    state: StepState;
    start: number | null;
    end: number | null;
    note?: string;
};

export type RolloutSlot = { machine: string; gpu: number | null };

export type Rollout = {
    target: string;
    pool: string;
    slots: RolloutSlot[];
    by: string;
    context: number;
    loaded: boolean;
    cold: RolloutSlot[];
    change: boolean;
    from: number | null;
    steps: RolloutStep[];
};

export const DEFAULT_CONTEXT = 8192;
export const LONG_CONTEXT = 32768;
export const OOM_ERROR = "CUDA out of memory: needs 20 GB, 18 GB free";
export type JobStatus = "running" | "queued" | "done" | "failed" | "cancelled";

export type Job = {
    id: number;
    kind: JobKind;
    model: string;
    version: number | null;
    status: JobStatus;
    progress: number;
    hoursAgo: number;
    atMs?: number;
    minutes: number | null;
    error?: string;
    device?: string;
    format?: ExportFormat;
    seconds?: number;
    rollout?: Rollout;
};

export type ExportFormat = "adapter" | "merged" | "gguf-q4" | "gguf-q8";

export type ExportArtifact = {
    jobId: number;
    slug: string;
    version: number;
    format: ExportFormat;
    sha: string;
};

function versionJob(model: FlowModel, version: FlowVersion): Job {
    return {
        id: version.jobId,
        kind: version.kind === "prompt" ? "score" : "train",
        model: model.slug,
        version: version.number,
        status:
            version.status === "training"
                ? "running"
                : version.status === "failed"
                  ? "failed"
                  : "done",
        progress: version.progress ?? 1,
        hoursAgo: version.hoursAgo,
        minutes:
            version.status === "ready"
                ? version.kind === "prompt"
                    ? 2
                    : 9 + ((version.number * 5) % 7)
                : null,
        error: version.error,
    };
}

function transfer(
    id: number,
    kind: JobKind,
    model: string,
    hoursAgo: number,
    minutes: number,
): Job {
    return {
        id,
        kind,
        model,
        version: null,
        status: "done",
        progress: 1,
        hoursAgo,
        minutes,
    };
}

const SEED_SLOTS: Record<string, RolloutSlot & { pool: string }> = {
    "gpu-a10-1": { machine: "gpu-a10-1", gpu: 1, pool: "serve" },
    "gpu-a10-2": { machine: "gpu-a10-2", gpu: 0, pool: "serve" },
    local: { machine: "local", gpu: 0, pool: "local" },
    "cpu-1": { machine: "cpu-1", gpu: null, pool: "cpu" },
};

const SEED_BY: Record<string, string> = {
    "support-triage": "Dana",
    guy1: "Dana",
};

export const STEP_MS: Record<RolloutStepKey, number> = {
    download: 4000,
    load: 5000,
    fetch: 1200,
    attach: 1500,
    route: 800,
    detach: 700,
    stop: 800,
    unload: 1200,
    release: 2500,
};

const SEED_MS: Record<RolloutStepKey, number> = {
    download: 41000,
    load: 6200,
    fetch: 1300,
    attach: 1400,
    route: 600,
    detach: 500,
    stop: 700,
    unload: 1100,
    release: 2400,
};

type SeedRollout = {
    id: number;
    kind: "deploy" | "undeploy";
    model: string;
    target: string;
    version: number | null;
    hoursAgo: number;
    machines: string[];
    by: string;
    download?: boolean;
    loaded?: boolean;
    failed?: boolean;
    context?: number;
    adapter?: boolean;
    from?: number;
};

function seededSteps(seed: SeedRollout, start: number): RolloutStep[] {
    const keys: RolloutStepKey[] =
        seed.kind === "undeploy"
            ? ["stop", "unload", "release"]
            : seed.from !== undefined
              ? ["fetch", "attach", "route", "detach"]
              : [
                    ...(seed.download ? (["download"] as const) : []),
                    "load",
                    ...(seed.adapter ? (["attach"] as const) : []),
                    "route",
                ];
    let at = start + 400;
    let stopped = false;
    return keys.map((key): RolloutStep => {
        if (stopped) {
            return { key, state: "pending", start: null, end: null };
        }
        const ms = key === "load" && seed.loaded ? 300 : SEED_MS[key];
        if (seed.failed && key === "load") {
            stopped = true;
            return { key, state: "failed", start: at, end: at + ms * 0.7 };
        }
        const step: RolloutStep = { key, state: "done", start: at, end: at + ms };
        at += ms + 150;
        return step;
    });
}

function slotsOf(seed: SeedRollout): RolloutSlot[] {
    return seed.machines.map((machine) => {
        const slot = SEED_SLOTS[machine] ?? SEED_SLOTS.local;
        return { machine: slot.machine, gpu: slot.gpu };
    });
}

function seededRollout(seed: SeedRollout): Job {
    const start = Date.now() - seed.hoursAgo * 3600000;
    const steps = seededSteps(seed, start);
    const end = Math.max(...steps.map((step) => step.end ?? 0));
    const first = SEED_SLOTS[seed.machines[0]] ?? SEED_SLOTS.local;
    return {
        id: seed.id,
        kind: seed.kind,
        model: seed.model,
        version: seed.version,
        status: seed.failed ? "failed" : "done",
        progress: seed.failed ? 0.4 : 1,
        hoursAgo: seed.hoursAgo,
        minutes: null,
        seconds: Math.round((end - start) / 100) / 10,
        error: seed.failed ? OOM_ERROR : undefined,
        rollout: {
            target: seed.target,
            pool: first.pool,
            slots: slotsOf(seed),
            by: seed.by,
            context: seed.context ?? DEFAULT_CONTEXT,
            loaded: Boolean(seed.loaded),
            cold: seed.loaded || seed.from !== undefined ? [] : slotsOf(seed),
            change: false,
            from: seed.from ?? null,
            steps,
        },
    };
}

function rolloutSeeds(models: FlowModel[]): SeedRollout[] {
    const triage = (
        id: number,
        version: number,
        hoursAgo: number,
        extra: Partial<SeedRollout> = {},
    ): SeedRollout => ({
        id,
        kind: "deploy",
        model: "support-triage",
        target: "support-triage",
        version,
        hoursAgo,
        machines: ["gpu-a10-2"],
        by: "Dana",
        adapter: true,
        ...extra,
    });
    const seeds: SeedRollout[] = [
        triage(1250, 1, 32.9 * DAY, { download: true }),
        triage(1251, 3, 25.9 * DAY, { failed: true, context: LONG_CONTEXT }),
        triage(1252, 3, 25.85 * DAY),
        triage(1253, 4, 20.9 * DAY, { loaded: true, from: 3 }),
    ];
    let id = 1260;
    for (const model of models) {
        if (model.slug === "support-triage") {
            continue;
        }
        if (model.kind === "custom" && model.deployed) {
            const live = model.versions.find((version) => version.number === model.live);
            seeds.push({
                id: id++,
                kind: "deploy",
                model: model.slug,
                target: model.slug,
                version: model.live,
                hoursAgo: Math.min(live?.hoursAgo ?? DAY, 40 * DAY) - 0.1,
                machines: model.replicas,
                by: SEED_BY[model.slug] ?? "Sam",
                loaded: true,
                adapter: live?.kind === "trained",
            });
        }
        for (const item of model.variants.filter((entry) => entry.live)) {
            seeds.push({
                id: id++,
                kind: "deploy",
                model: model.slug,
                target: `${model.slug}#${item.id}`,
                version: null,
                hoursAgo: 75 * DAY,
                machines: item.replicas,
                by: "Sam",
                download: true,
            });
        }
    }
    return seeds;
}

function jobsOf(models: FlowModel[]): Job[] {
    const versionJobs = models.flatMap((model) =>
        model.versions.map((version) => versionJob(model, version)),
    );
    const rollouts = rolloutSeeds(models).map(seededRollout);
    const others: Job[] = [
        transfer(1201, "download", "qwen3-8b", 36 * DAY, 9),
        transfer(1202, "download", "llama-3.2-1b", 22 * DAY, 4),
        transfer(1203, "import", "qwen3-0.6b", 35 * DAY, 1),
        {
            id: 1205,
            kind: "judge",
            model: "support-triage",
            version: 5,
            status: "done",
            progress: 1,
            hoursAgo: 5.8 * DAY,
            minutes: 4,
        },
        {
            id: 1206,
            kind: "judge",
            model: "sql-helper",
            version: 0,
            status: "running",
            progress: 0.6,
            hoursAgo: 0.3,
            minutes: null,
        },
        {
            id: 1204,
            kind: "score",
            model: "invoice-extractor",
            version: 1,
            status: "queued",
            progress: 0,
            hoursAgo: 0.2,
            minutes: null,
        },
    ];
    return [...versionJobs, ...rollouts, ...others].sort((a, b) => a.hoursAgo - b.hoursAgo);
}

export type FeedbackRow = {
    id: number;
    model: string;
    question: string;
    answer: string;
    suggested: string;
    state: "pending" | "accepted" | "dismissed";
    hoursAgo: number;
};

function feedback(
    id: number,
    model: string,
    question: string,
    answer: string,
    suggested: string,
    hoursAgo: number,
): FeedbackRow {
    return { id, model, question, answer, suggested, state: "pending", hoursAgo };
}

const SUPPORT_FEEDBACK: [string, string, string][] = [
    ["Need my money back for the duplicate seat.", "billing", "refund_request"],
    ["The app logs me out every 5 minutes.", "account_access", "bug_report"],
    ["Courier left the parcel at the wrong address.", "billing", "shipping"],
    ["Card declined but the invoice says paid.", "bug_report", "billing"],
    ["Cancel my plan and refund this month.", "billing", "refund_request"],
    ["Reset link expired before I opened it.", "bug_report", "account_access"],
    ["Parcel tracking shows delivered, nothing here.", "bug_report", "shipping"],
    ["Add a CSV export to the reports page.", "bug_report", "feature_request"],
    ["Charged in USD instead of EUR.", "refund_request", "billing"],
    ["My teammate can't accept the invite.", "bug_report", "account_access"],
    ["Refund the second seat I never used.", "billing", "refund_request"],
];

const FEEDBACK: FeedbackRow[] = [
    ...SUPPORT_FEEDBACK.map(([question, answer, suggested], index) =>
        feedback(301 + index, "support-triage", question, answer, suggested, 2 + index * 3),
    ),
    feedback(
        320,
        "invoice-extractor",
        "Invoice INV-2291 from Nordlicht GmbH",
        "total: 1,240.00",
        "total: 1,420.00",
        26,
    ),
];

export type CatalogEntry = {
    id: string;
    name: string;
    publisher: string;
    params: string;
    size: string;
    memory: string;
    licence: string;
    context: string;
    summary: string;
    serveOnly: boolean;
};

function entry(
    id: string,
    name: string,
    publisher: string,
    params: string,
    sizes: [string, string],
    licence: string,
    context: string,
    summary: string,
    serveOnly = false,
): CatalogEntry {
    return {
        id,
        name,
        publisher,
        params,
        size: sizes[0],
        memory: sizes[1],
        licence,
        context,
        summary,
        serveOnly,
    };
}

export const CATALOG: CatalogEntry[] = [
    entry(
        "qwen3-0.6b",
        "Qwen3 0.6B",
        "Qwen",
        "0.6B",
        ["1.4 GB", "2 GB"],
        "Apache 2.0",
        "32K",
        "Small and fast; a good first base for classifying and routing.",
    ),
    entry(
        "llama-3.2-1b",
        "Llama 3.2 1B",
        "Meta",
        "1.2B",
        ["2.5 GB", "4 GB"],
        "Llama 3.2 Community",
        "128K",
        "Long context for its size; extraction and summaries.",
    ),
    entry(
        "qwen3-8b",
        "Qwen3 8B",
        "Qwen",
        "8.2B",
        ["16 GB", "20 GB"],
        "Apache 2.0",
        "32K",
        "Strong general base; FP8 and GGUF formats serve it on smaller GPUs or CPU.",
    ),
    entry(
        "gemma-3-1b",
        "Gemma 3 1B",
        "Google",
        "1.0B",
        ["2.0 GB", "3 GB"],
        "Gemma terms",
        "32K",
        "Compact and multilingual.",
    ),
    entry(
        "granite-3.3-2b",
        "Granite 3.3 2B",
        "IBM",
        "2.5B",
        ["5.1 GB", "6 GB"],
        "Apache 2.0",
        "128K",
        "Enterprise-tuned; strong on structured output.",
    ),
    entry(
        "phi-4-mini",
        "Phi-4 mini",
        "Microsoft",
        "3.8B",
        ["7.7 GB", "9 GB"],
        "MIT",
        "128K",
        "A small model tuned for reasoning.",
    ),
    entry(
        "mistral-7b",
        "Mistral 7B Instruct",
        "Mistral AI",
        "7.2B",
        ["14.5 GB", "16 GB"],
        "Apache 2.0",
        "32K",
        "General assistant; needs a 24 GB GPU to train.",
    ),
];

export type Recipe = {
    id: string;
    title: string;
    task: string;
    summary: string;
    base: string;
    file: string;
    rows: number;
    metrics: [string, string];
    dataset: string;
};

export const RECIPES: Recipe[] = [
    {
        id: "support-triage",
        title: "Support ticket triage",
        task: "Classify",
        summary: "Routes tickets to one of six queues.",
        base: "qwen3-0.6b",
        file: SAMPLE_FILE,
        rows: 2140,
        metrics: CLASSIFY,
        dataset: "support-tickets",
    },
    {
        id: "invoice-extraction",
        title: "Invoice extraction",
        task: "Extract",
        summary: "Pulls totals, dates and vendor names into JSON.",
        base: "llama-3.2-1b",
        file: "sample-invoices.jsonl",
        rows: 900,
        metrics: EXTRACT,
        dataset: "sample-invoices",
    },
    {
        id: "contract-clauses",
        title: "Contract clause review",
        task: "Classify",
        summary: "Flags risky clauses as standard, risky or blocking.",
        base: "llama-3.2-1b",
        file: "sample-clauses.csv",
        rows: 1200,
        metrics: CLASSIFY,
        dataset: "sample-clauses",
    },
    {
        id: "clinical-coding",
        title: "Clinical note coding",
        task: "Classify",
        summary: "Suggests ICD-10 codes for discharge notes.",
        base: "qwen3-8b",
        file: "sample-notes.jsonl",
        rows: 1600,
        metrics: CLASSIFY,
        dataset: "sample-notes",
    },
    {
        id: "trade-confirmations",
        title: "Trade confirmation extraction",
        task: "Extract",
        summary: "Reads counterparty, notional, dates and rate from confirmations.",
        base: "granite-3.3-2b",
        file: "sample-confirmations.jsonl",
        rows: 750,
        metrics: EXTRACT,
        dataset: "sample-confirmations",
    },
    {
        id: "sql-from-questions",
        title: "SQL from questions",
        task: "SQL",
        summary: "Writes SQL for a sample warehouse schema.",
        base: "qwen3-8b",
        file: "sample-questions.csv",
        rows: 1100,
        metrics: SQL,
        dataset: "sample-questions",
    },
];

export type ApiKey = {
    id: string;
    prefix: string;
    hoursAgo: number;
    atMs?: number;
    lastUsed: number | null;
};

export type Mode = "empty" | "full";

export type Intent =
    | { kind: "make-live"; slug: string; number: number; source?: "inbox" }
    | { kind: "connect"; slug: string }
    | null;

type World = {
    models: FlowModel[];
    datasets: Dataset[];
    jobs: Job[];
    feedback: FeedbackRow[];
    keys: Record<string, ApiKey[]>;
    focus: string | null;
    examples: number;
    dismissed: string[];
    exports: ExportArtifact[];
    downloads: Record<string, number>;
};

type Shared = { visited: string[]; mode: Mode; intent: Intent };

export type FlowState = World & Shared;

const FULL: World = {
    models: INITIAL,
    datasets: DATASETS,
    jobs: jobsOf(INITIAL),
    feedback: FEEDBACK,
    keys: {
        "support-triage": [
            { id: "k1", prefix: "mb_live_7Qx2…", hoursAgo: 30 * DAY, lastUsed: 0.05 },
            { id: "k2", prefix: "mb_live_c81F…", hoursAgo: 9 * DAY, lastUsed: 50 },
        ],
        "invoice-extractor": [
            { id: "k3", prefix: "mb_live_Lm4k…", hoursAgo: 8 * DAY, lastUsed: 0.2 },
        ],
    },
    focus: null,
    examples: 0,
    dismissed: [],
    exports: [],
    downloads: {},
};

const EMPTY: World = {
    models: [],
    datasets: [],
    jobs: [],
    feedback: [],
    keys: {},
    focus: null,
    examples: 0,
    dismissed: [],
    exports: [],
    downloads: {},
};

let worlds: Record<Mode, World> = { full: FULL, empty: EMPTY };
let shared: Shared = { visited: [], mode: "full", intent: null };
let state: FlowState = { ...worlds.full, ...shared };
const listeners = new Set<() => void>();
let nextJob = 1300;

function notify() {
    state = { ...worlds[shared.mode], ...shared };
    for (const listener of listeners) {
        listener();
    }
}

function set(change: (current: FlowState) => FlowState) {
    const { visited, mode, intent, ...world } = change(state);
    worlds = { ...worlds, [shared.mode]: world };
    shared = { visited, mode, intent };
    notify();
}

function setWorld(mode: Mode, change: (world: World) => World) {
    worlds = { ...worlds, [mode]: change(worlds[mode]) };
    notify();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function flowMode(): Mode {
    return shared.mode;
}

export function flowState(): FlowState {
    return state;
}

export function useFlowState(): FlowState {
    return useSyncExternalStore(subscribe, () => state);
}

export function useFlowModels(): FlowModel[] {
    return useFlowState().models;
}

export function useFlowModel(slug: string | undefined): FlowModel | undefined {
    return useFlowModels().find((model) => model.slug === slug);
}

export function restartJourney() {
    worlds = { ...worlds, empty: EMPTY };
    shared = { visited: [], mode: "empty", intent: null };
    notify();
}

export function setMode(mode: Mode) {
    if (shared.mode !== mode) {
        shared = { ...shared, mode, intent: null };
        notify();
    }
}

export function openIntent(intent: Intent) {
    shared = { ...shared, intent };
    notify();
}

function modelsIn(mode: Mode, slug: string, change: (model: FlowModel) => FlowModel) {
    setWorld(mode, (world) => ({
        ...world,
        models: world.models.map((model) => (model.slug === slug ? change(model) : model)),
    }));
}

function update(slug: string, change: (model: FlowModel) => FlowModel) {
    modelsIn(shared.mode, slug, change);
}

function jobIn(mode: Mode, id: number, change: (job: Job) => Job) {
    setWorld(mode, (world) => ({
        ...world,
        jobs: world.jobs.map((job) => (job.id === id ? change(job) : job)),
    }));
}

export function newJobId(): number {
    return nextJob++;
}

export function addJob(mode: Mode, job: Job) {
    setWorld(mode, (world) => ({ ...world, jobs: [job, ...world.jobs] }));
}

export function changeJob(mode: Mode, id: number, change: (job: Job) => Job) {
    jobIn(mode, id, change);
}

export function isRollout(job: Job): boolean {
    return job.kind === "deploy" || job.kind === "undeploy";
}

function hoursOfJob(job: Job): number {
    return job.atMs ? (Date.now() - job.atMs) / 3600000 : job.hoursAgo;
}

export function rolloutsOf(current: FlowState, slug: string): Job[] {
    return current.jobs
        .filter((job) => job.model === slug && isRollout(job))
        .sort((a, b) => hoursOfJob(a) - hoursOfJob(b));
}

export function lastRollout(current: FlowState, slug: string): Job | undefined {
    return rolloutsOf(current, slug)[0];
}

export function failedRollout(current: FlowState, slug: string): Job | undefined {
    const last = lastRollout(current, slug);
    return last?.kind === "deploy" && last.status === "failed" ? last : undefined;
}

export function markVisited(step: string) {
    if (!shared.visited.includes(step)) {
        shared = { ...shared, visited: [...shared.visited, step] };
        notify();
    }
}

export function dismiss(id: string) {
    set((current) => ({ ...current, dismissed: [...current.dismissed, id] }));
}

const ARRIVING: [string, string, string][] = [
    ["Got billed for a plan I cancelled last week.", "billing", "refund_request"],
    ["Two-factor code never arrives on my new phone.", "bug_report", "account_access"],
    ["Box was empty when it arrived.", "billing", "shipping"],
];

function arrivingFeedback(slug: string): FeedbackRow[] {
    const base = 400 + state.feedback.length;
    return ARRIVING.map(([question, answer, suggested], index) =>
        feedback(base + index, slug, question, answer, suggested, 0.1 * (index + 1)),
    );
}

export function makeLive(slug: string, number: number, source?: "inbox") {
    const model = state.models.find((item) => item.slug === slug);
    if (!model) {
        return;
    }
    const first = model.live === null && !model.deployed;
    const older = model.live !== null && number < model.live;
    const known = state.feedback.some((row) => row.model === slug);
    update(slug, (current) => ({
        ...current,
        live: number,
        deployed: current.deployed || first,
        canary: null,
        autopilot: current.autopilot ? { ...current.autopilot, run: null } : null,
        replicas: current.replicas.length > 0 ? current.replicas : homeOf(current.base),
        traffic: first ? [0, 0, 0, 0, 0, 0, 3] : current.traffic,
        versions: current.versions.map((version) =>
            version.number === current.live ? { ...version, wasLive: true } : version,
        ),
    }));
    if (first && !known) {
        set((current) => ({
            ...current,
            feedback: [...arrivingFeedback(slug), ...current.feedback],
        }));
    }
    markVisited("live");
    if (older && model.live !== null) {
        dismiss(`live:${slug}:${model.live}`);
        markVisited("older");
    }
    if (source === "inbox") {
        markVisited("inbox");
    }
}

const HOMES: Record<string, string> = {
    "Qwen3 8B": "gpu-a10-2",
    "Llama 3.2 1B": "gpu-a10-1",
    "Qwen3 0.6B": "local",
};

function homeOf(base: string | null): string[] {
    if (shared.mode === "empty") {
        return ["local"];
    }
    if (base?.includes("GGUF")) {
        return ["cpu-1"];
    }
    return [HOMES[base ?? ""] ?? "gpu-a10-1"];
}

export function setDeployment(slug: string, deployed: boolean, replicas: string[]) {
    update(slug, (current) => ({ ...current, deployed, replicas: deployed ? replicas : [] }));
}

export function setVariantsLive(keys: string[], live: boolean, replicas: string[]) {
    changeVariants(keys, (item) =>
        live
            ? { ...item, live: true, replicas, p95: item.p95 ?? 180 }
            : { ...item, live: false, replicas: [] },
    );
}

export function setOnApi(slug: string, on: boolean) {
    const model = state.models.find((item) => item.slug === slug);
    if (!model) {
        return;
    }
    if (model.kind === "base") {
        const keys = on
            ? model.variants.slice(0, 1).map((item) => variantKey(slug, item.id))
            : model.variants.map((item) => variantKey(slug, item.id));
        if (on) {
            deployVariants(keys);
        } else {
            undeployVariants(keys);
        }
        return;
    }
    update(slug, (current) => ({
        ...current,
        deployed: on,
        replicas: on ? (current.replicas.length > 0 ? current.replicas : homeOf(current.base)) : [],
    }));
}

export function undeployModels(slugs: string[]) {
    set((current) => ({
        ...current,
        models: current.models.map((model) =>
            slugs.includes(model.slug)
                ? summarise({
                      ...model,
                      deployed: false,
                      replicas: [],
                      variants: model.variants.map((item) => ({
                          ...item,
                          live: false,
                          replicas: [],
                      })),
                  })
                : model,
        ),
    }));
}

export function variantKey(slug: string, id: string): string {
    return `${slug}#${id}`;
}

function changeVariants(keys: string[], change: (item: BaseVariant) => BaseVariant | null) {
    set((current) => ({
        ...current,
        models: current.models.map((model) => {
            if (!model.variants.some((item) => keys.includes(variantKey(model.slug, item.id)))) {
                return model;
            }
            const variants = model.variants.flatMap((item) => {
                if (!keys.includes(variantKey(model.slug, item.id))) {
                    return [item];
                }
                const next = change(item);
                return next ? [next] : [];
            });
            return summarise({ ...model, variants });
        }),
    }));
}

export function deployVariants(keys: string[]) {
    changeVariants(keys, (item) =>
        item.live
            ? item
            : {
                  ...item,
                  live: true,
                  replicas: homeOf(item.format.startsWith("GGUF") ? "GGUF" : null),
                  p95: item.p95 ?? 180,
              },
    );
}

export function undeployVariants(keys: string[]) {
    changeVariants(keys, (item) => ({ ...item, live: false, replicas: [] }));
}

export function deleteVariantFiles(keys: string[]) {
    changeVariants(keys, (item) => (item.live ? item : null));
}

export function applyUpdate(slug: string, id: string) {
    changeVariants([variantKey(slug, id)], (item) => ({ ...item, update: null }));
    const jobId = nextJob++;
    set((current) => ({
        ...current,
        jobs: [{ ...transfer(jobId, "download", slug, 0, 2), atMs: Date.now() }, ...current.jobs],
    }));
}

export function togglePin(slug: string) {
    update(slug, (model) => ({ ...model, pinned: !model.pinned }));
}

export function setAutopilot(slug: string, autopilot: Autopilot | null) {
    update(slug, (model) => ({ ...model, autopilot }));
}

export function setRecipe(slug: string, recipe: TrainingSettings) {
    update(slug, (model) => ({ ...model, recipe }));
}

export function baseModelSlug(name: string): string {
    const found = state.models.find(
        (model) =>
            model.kind === "base" &&
            (model.name === name ||
                (model.variants.length > 1 && name.startsWith(`${model.name} `))),
    );
    return found?.slug ?? CATALOG.find((item) => item.name === name)?.id ?? slugify(name);
}

export function deleteModels(slugs: string[]) {
    set((current) => ({
        ...current,
        models: current.models.filter((model) => !slugs.includes(model.slug)),
    }));
}

export function deleteVersions(keys: string[]) {
    set((current) => ({
        ...current,
        models: current.models.map((model) => ({
            ...model,
            versions: model.versions.filter(
                (version) => !keys.includes(versionKey(model.slug, version.number)),
            ),
        })),
    }));
}

function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

export function catalogEntry(id: string | null | undefined): CatalogEntry | undefined {
    return CATALOG.find((item) => item.id === id);
}

export function isInstalled(current: FlowState, id: string): boolean {
    return current.models.some((model) => model.kind === "base" && model.slug === id);
}

export function installBase(id: string) {
    const source = catalogEntry(id);
    if (!source || isInstalled(state, id)) {
        return;
    }
    const seeded = INITIAL.find((model) => model.slug === id);
    const model: FlowModel = seeded
        ? summarise({
              ...seeded,
              variants: seeded.variants.map((item) => ({
                  ...item,
                  live: false,
                  replicas: [],
                  traffic: [0, 0, 0, 0, 0, 0, 0],
                  previous: 0,
                  update: null,
              })),
          })
        : complete(
              {
                  ...baseRaw(id, source.name, source.publisher),
                  serveOnly: source.serveOnly,
              },
              0,
          );
    const withVariants =
        model.variants.length > 0
            ? model
            : summarise({
                  ...model,
                  licence: source.licence,
                  variants: [variant("bf16", "BF16", source.size, id, 1.2)],
              });
    const jobId = nextJob++;
    const mode = shared.mode;
    set((current) => ({
        ...current,
        models: [...current.models, { ...withVariants, licence: source.licence }],
        downloads: { ...current.downloads, [id]: Date.now() },
        jobs: [
            {
                ...transfer(jobId, "download", id, 0, 3),
                status: "running",
                progress: 0,
                minutes: null,
                atMs: Date.now(),
            },
            ...current.jobs,
        ],
    }));
    window.setTimeout(() => finishDownload(mode, id, jobId), DOWNLOAD_MS);
}

export const DOWNLOAD_MS = 9000;

function finishDownload(mode: Mode, id: string, jobId: number) {
    setWorld(mode, (world) => ({
        ...world,
        downloads: Object.fromEntries(
            Object.entries(world.downloads).filter(([slug]) => slug !== id),
        ),
        jobs: world.jobs.map((job) =>
            job.id === jobId ? { ...job, status: "done", progress: 1, minutes: 3 } : job,
        ),
    }));
}

export function downloadProgress(current: FlowState, baseSlug: string, now: number): number | null {
    const start = current.downloads[baseSlug];
    return start === undefined ? null : Math.min(0.99, (now - start) / DOWNLOAD_MS);
}

function freeSlug(name: string): string {
    const taken = new Set(state.models.map((model) => model.slug));
    const stem = slugify(name) || "model";
    let slug = stem;
    for (let suffix = 2; taken.has(slug); suffix += 1) {
        slug = `${stem}-${suffix}`;
    }
    return slug;
}

export function createModel(
    name: string,
    baseId: string,
    avatar: AvatarChoice,
    extra: Partial<FlowModel> = {},
): string {
    const base = catalogEntry(baseId) ?? CATALOG[0];
    installBase(base.id);
    const slug = freeSlug(name);
    const model: FlowModel = {
        slug,
        name,
        kind: "custom",
        publisher: base.publisher,
        base: base.name,
        description: "",
        metrics: CLASSIFY,
        rule: [0.85, 0.01],
        heldOut: 214,
        live: null,
        deployed: false,
        traffic: [0, 0, 0, 0, 0, 0, 0],
        previous: 0,
        serveOnly: base.serveOnly,
        size: null,
        versions: [],
        avatar,
        dataset: null,
        accepted: 0,
        p95: 0,
        errors: 0,
        usualErrors: 0.003,
        licence: base.licence,
        task: "Classify",
        gpuSeconds: base.id === "qwen3-8b" ? 9.6 : 1.1,
        replicas: [],
        variants: [],
        autopilot: null,
        canary: null,
        recipe: null,
        pinned: false,
        recent: [],
        trainAt: 10,
        tags: [],
        instructions: "",
        safety: null,
        ...extra,
    };
    set((current) => ({
        ...current,
        models: [model, ...current.models],
        focus: slug,
    }));
    markVisited("start");
    return slug;
}

export function createFromRecipe(id: string): string {
    const recipe = RECIPES.find((item) => item.id === id) ?? RECIPES[0];
    const slug = createModel(recipe.title, recipe.base, choiceFor("initials", recipe.title), {
        description: recipe.summary,
        task: recipe.task,
        metrics: recipe.metrics,
    });
    addDataset(recipe.dataset, `${recipe.title} sample`, recipe.file, recipe.rows);
    attachDataset(slug, recipe.dataset);
    return slug;
}

function addDataset(slug: string, name: string, file: string, rows: number) {
    if (!state.datasets.some((item) => item.slug === slug)) {
        const added = {
            ...dataset(slug, name, file, rows, 1, 0),
            atMs: Date.now(),
        };
        set((current) => ({ ...current, datasets: [added, ...current.datasets] }));
    }
}

export function uploadSample(): string {
    addDataset("support-tickets", "Support tickets", SAMPLE_FILE, 2140);
    return "support-tickets";
}

export function attachDataset(slug: string, datasetSlug: string) {
    const source = state.datasets.find((item) => item.slug === datasetSlug);
    const model = state.models.find((item) => item.slug === slug);
    if (!source || !model) {
        return;
    }
    const needsZero = !model.versions.some((version) => version.number === 0);
    const jobId = nextJob++;
    const zero: FlowVersion = {
        ...promptOnly([0.712, 0.642], false, 0, source.rows),
        atMs: Date.now(),
        jobId,
        data: data(source.version, source.rows, source.rows, 0),
    };
    update(slug, (current) => ({
        ...current,
        dataset: datasetSlug,
        heldOut: source.split[1],
        versions: needsZero ? [zero] : current.versions,
    }));
    if (needsZero) {
        set((current) => ({
            ...current,
            jobs: [{ ...versionJob(model, zero), atMs: Date.now(), minutes: 1 }, ...current.jobs],
        }));
    }
}

export const TRAIN_MS = 10000;
const TICK_MS = 250;

function nextScores(model: FlowModel, number: number): [number, number] {
    if (number === 1) {
        return [0.867, 0.846];
    }
    const best = Math.max(...model.versions.map((version) => version.scores?.[0] ?? 0));
    return [Math.min(0.97, best + 0.012), Math.min(0.96, best - 0.006)];
}

export function defaultRecipe(model: FlowModel): TrainingSettings {
    if (model.recipe) {
        return model.recipe;
    }
    const source = state.datasets.find((item) => item.slug === model.dataset);
    const last = newestFirst(model).find(
        (version) => version.settings && version.status === "ready",
    )?.settings;
    return last ?? settings(16, 3, 2e-4, source?.split[0] ?? 1926);
}

function tick(
    mode: Mode,
    slug: string,
    number: number,
    jobId: number,
    timer: number,
    minutes: number,
) {
    const world = worlds[mode];
    const job = world.jobs.find((item) => item.id === jobId);
    if (!job || job.status !== "running") {
        window.clearInterval(timer);
        return;
    }
    const progress = Math.min(1, job.progress + TICK_MS / TRAIN_MS);
    const owner = world.models.find((item) => item.slug === slug);
    const scores = progress >= 1 && owner ? nextScores(owner, number) : null;
    jobIn(mode, jobId, (item) => ({
        ...item,
        progress,
        status: scores ? "done" : "running",
        minutes: scores ? minutes : null,
    }));
    modelsIn(mode, slug, (current) => ({
        ...current,
        versions: current.versions.map((item) => {
            if (item.number !== number) {
                return item;
            }
            return scores
                ? {
                      ...item,
                      status: "ready",
                      progress: 1,
                      scores,
                      passed: scores[0] >= current.rule[0],
                  }
                : { ...item, progress };
        }),
    }));
    if (scores) {
        window.clearInterval(timer);
    }
}

export type TrainStart = { device?: string; queued?: boolean; minutes?: number };

const QUEUE_MS = 4000;

function runJob(mode: Mode, slug: string, number: number, jobId: number, minutes: number) {
    const timer = window.setInterval(
        () => tick(mode, slug, number, jobId, timer, minutes),
        TICK_MS,
    );
}

export function startTraining(
    slug: string,
    recipe?: TrainingSettings,
    picked?: DataChoice,
    start: TrainStart = {},
): number {
    const model = state.models.find((item) => item.slug === slug);
    if (!model) {
        return 0;
    }
    const chosen = recipe ?? defaultRecipe(model);
    const latest = dataChoices(model)[0];
    const source = picked ?? latest;
    const number = nextNumber(model);
    const jobId = nextJob++;
    const added = model.accepted;
    const version: FlowVersion = {
        number,
        kind: "trained",
        status: "training",
        progress: 0,
        scores: null,
        passed: null,
        hoursAgo: 0,
        atMs: Date.now(),
        wasLive: false,
        jobId,
        data: data(source?.number ?? 1, (source?.rows ?? 2140) + added, added, 0),
        settings: { ...chosen, rows: chosen.rows + added },
        p50: 44,
    };
    update(slug, (current) => ({
        ...current,
        accepted: 0,
        recipe: chosen,
        versions: [...current.versions, version],
    }));
    const device = start.device ?? (trainingVersion(model) ? "gpu-t4-1" : DEVICE);
    const minutes = Math.max(1, Math.round(start.minutes ?? 12));
    const status = start.queued ? "queued" : "running";
    set((current) => ({
        ...current,
        jobs: [
            { ...versionJob(model, version), atMs: Date.now(), device, status },
            ...current.jobs,
        ],
    }));
    const mode = shared.mode;
    if (start.queued) {
        window.setTimeout(() => {
            jobIn(mode, jobId, (job) =>
                job.status === "queued" ? { ...job, status: "running" } : job,
            );
            runJob(mode, slug, number, jobId, minutes);
        }, QUEUE_MS);
    } else {
        runJob(mode, slug, number, jobId, minutes);
    }
    markVisited(number === 1 ? "training" : "train2");
    return number;
}

export function retryVersion(slug: string, number: number): number {
    const model = state.models.find((item) => item.slug === slug);
    const failed = model ? findVersion(model, number) : undefined;
    if (!model || !failed?.settings) {
        return 0;
    }
    const memory = /memory/i.test(failed.error ?? "");
    return startTraining(slug, memory ? { ...failed.settings, adapter: "QLoRA" } : failed.settings);
}

export function setHeldOut(slug: string, rows: number) {
    update(slug, (model) => ({ ...model, heldOut: rows }));
}

export function setTrainAt(slug: string, rows: number) {
    update(slug, (model) => ({ ...model, trainAt: rows }));
}

export type ModelEdit = Partial<
    Pick<FlowModel, "description" | "tags" | "instructions" | "safety" | "rule" | "avatar">
>;

export function editModel(slug: string, edit: ModelEdit) {
    update(slug, (model) => ({ ...model, ...edit }));
}

export function duration(minutes: number): string {
    return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

export type ExportOption = {
    id: ExportFormat;
    label: string;
    file: string;
    runs: string;
};

function paramsOf(model: FlowModel): number {
    const entry = model.base ? catalogEntry(baseModelSlug(model.base)) : undefined;
    return Number.parseFloat(entry?.params ?? "8") || 8;
}

function gigabytes(value: number): string {
    return value < 10 ? `${value.toFixed(1)} GB` : `${Math.round(value)} GB`;
}

export function exportSize(model: FlowModel, version: FlowVersion, format: ExportFormat): string {
    const params = paramsOf(model);
    if (format === "adapter") {
        const rank = version.settings?.rank ?? 16;
        return `${Math.max(4, Math.round((84 * params * rank) / (8.2 * 32)))} MB`;
    }
    if (format === "merged") {
        return gigabytes(params * 1.95);
    }
    return gigabytes(params * (format === "gguf-q4" ? 0.61 : 1.04));
}

export const EXPORT_OPTIONS: ExportOption[] = [
    {
        id: "adapter",
        label: "Adapter only",
        file: "safetensors",
        runs: "Runs on minibrain or any server that loads LoRA adapters on the same base.",
    },
    {
        id: "merged",
        label: "Merged full model",
        file: "safetensors",
        runs: "Runs anywhere that serves Hugging Face models, such as vLLM.",
    },
    {
        id: "gguf-q4",
        label: "Merged and quantised GGUF, Q4",
        file: "GGUF",
        runs: "For llama.cpp or Ollama.",
    },
    {
        id: "gguf-q8",
        label: "Merged and quantised GGUF, Q8",
        file: "GGUF",
        runs: "For llama.cpp or Ollama.",
    },
];

export function exportOption(format: ExportFormat): ExportOption {
    return EXPORT_OPTIONS.find((option) => option.id === format) ?? EXPORT_OPTIONS[0];
}

export function fakeSha(seed: string): string {
    let hash = 2166136261;
    let out = "";
    for (let round = 0; out.length < 64; round += 1) {
        for (const char of `${seed}#${round}`) {
            hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
        }
        out += hash.toString(16).padStart(8, "0");
    }
    return out.slice(0, 64);
}

const EXPORT_MS = 6000;

function exportTick(mode: Mode, jobId: number, timer: number) {
    const job = worlds[mode].jobs.find((item) => item.id === jobId);
    if (!job || job.status !== "running") {
        window.clearInterval(timer);
        return;
    }
    const progress = Math.min(1, job.progress + TICK_MS / EXPORT_MS);
    jobIn(mode, jobId, (item) => ({
        ...item,
        progress,
        status: progress >= 1 ? "done" : "running",
        minutes: progress >= 1 ? 3 : null,
    }));
    if (progress >= 1) {
        window.clearInterval(timer);
    }
}

export function startExport(slug: string, number: number, format: ExportFormat): number {
    const jobId = nextJob++;
    const job: Job = {
        id: jobId,
        kind: "export",
        model: slug,
        version: number,
        status: "running",
        progress: 0,
        hoursAgo: 0,
        atMs: Date.now(),
        minutes: null,
        device: DEVICE,
        format,
    };
    set((current) => ({
        ...current,
        jobs: [job, ...current.jobs],
        exports: [
            ...current.exports,
            { jobId, slug, version: number, format, sha: fakeSha(`${slug}@${number}:${format}`) },
        ],
    }));
    const mode = shared.mode;
    const timer = window.setInterval(() => exportTick(mode, jobId, timer), TICK_MS);
    markVisited("export");
    return jobId;
}

export function retryWithQLoRA(slug: string, number: number): number {
    const model = state.models.find((item) => item.slug === slug);
    const failed = model ? findVersion(model, number) : undefined;
    if (!model || !failed?.settings) {
        return 0;
    }
    return startTraining(slug, { ...failed.settings, adapter: "QLoRA" });
}

export function cancelJobs(ids: number[]) {
    set((current) => ({
        ...current,
        jobs: current.jobs.map((job) =>
            ids.includes(job.id) &&
            !isRollout(job) &&
            (job.status === "running" || job.status === "queued")
                ? { ...job, status: "cancelled" }
                : job,
        ),
    }));
}

export function retryJobs(ids: number[]) {
    set((current) => ({
        ...current,
        jobs: current.jobs.map((job) =>
            ids.includes(job.id) &&
            !isRollout(job) &&
            (job.status === "failed" || job.status === "cancelled")
                ? { ...job, status: "queued", progress: 0 }
                : job,
        ),
    }));
}

export function reviewFeedback(id: number, accepted: boolean) {
    const row = state.feedback.find((item) => item.id === id);
    if (!row || row.state !== "pending") {
        return;
    }
    set((current) => ({
        ...current,
        feedback: current.feedback.map((item) =>
            item.id === id ? { ...item, state: accepted ? "accepted" : "dismissed" } : item,
        ),
    }));
    if (accepted) {
        update(row.model, (model) => ({ ...model, accepted: model.accepted + 1 }));
    }
}

export function createKey(slug: string): string {
    const random = Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
        (byte % 36).toString(36),
    ).join("");
    const key = `mb_live_${random}`;
    const record: ApiKey = {
        id: `k${Date.now()}`,
        prefix: `${key.slice(0, 12)}…`,
        hoursAgo: 0,
        atMs: Date.now(),
        lastUsed: null,
    };
    set((current) => ({
        ...current,
        keys: { ...current.keys, [slug]: [...(current.keys[slug] ?? []), record] },
    }));
    markVisited("connect");
    return key;
}

export function revokeKey(slug: string, id: string) {
    set((current) => ({
        ...current,
        keys: {
            ...current.keys,
            [slug]: (current.keys[slug] ?? []).filter((k) => k.id !== id),
        },
    }));
}

export function saveExample() {
    set((current) => ({ ...current, examples: current.examples + 1 }));
}

export function countRequest(slug: string) {
    update(slug.split("@")[0], (model) => ({
        ...model,
        traffic: [...model.traffic.slice(0, -1), (model.traffic.at(-1) ?? 0) + 1],
    }));
}

export function nextNumber(model: FlowModel): number {
    return Math.max(0, ...model.versions.map((version) => version.number)) + 1;
}

export function bestCandidate(model: FlowModel): FlowVersion | undefined {
    const live = liveVersion(model);
    return [...model.versions]
        .filter(
            (version) =>
                version.status === "ready" &&
                version.kind === "trained" &&
                version.passed === true &&
                version.number !== model.canary?.version &&
                (!live || (version.scores?.[0] ?? 0) > (live.scores?.[0] ?? 0)),
        )
        .sort((a, b) => (b.scores?.[0] ?? 0) - (a.scores?.[0] ?? 0))[0];
}

export function trainingVersion(model: FlowModel): FlowVersion | undefined {
    return model.versions.find((version) => version.status === "training");
}

export function lastFailure(model: FlowModel): FlowVersion | undefined {
    return newestFirst(model).find((version) => version.status === "failed");
}

export type NextAction =
    | "add-data"
    | "train"
    | "make-live"
    | "retry"
    | "monitor"
    | "deploy"
    | "connect"
    | "watch";

export type NextStep = {
    label: string;
    detail: string;
    href: string;
    action: NextAction;
    version?: number;
    rows?: number;
};

export function errorsSpiked(model: FlowModel): boolean {
    return model.deployed && model.errors > model.usualErrors * 3;
}

export function pendingFeedback(current: FlowState, slug?: string): FeedbackRow[] {
    return current.feedback.filter(
        (row) => row.state === "pending" && (slug === undefined || row.model === slug),
    );
}

function broken(model: FlowModel): NextStep | null {
    const newest = newestFirst(model)[0];
    if (newest?.status === "failed") {
        const memory = /memory/i.test(newest.error ?? "");
        return {
            label: memory ? "Retry with QLoRA" : "Retry",
            detail: memory
                ? `v${newest.number} ran out of memory. QLoRA trains the same data and settings in 4-bit, as v${nextNumber(model)}.`
                : `v${newest.number} failed. Retry trains the same data and settings as v${nextNumber(model)}.`,
            href: versionHref(model.slug, newest.number),
            action: "retry",
            version: newest.number,
        };
    }
    if (errorsSpiked(model)) {
        return {
            label: "Open monitoring",
            detail: `Errors are at ${percent(model.errors)}; usually ${percent(model.usualErrors)}.`,
            href: modelHref(model.slug, "monitoring"),
            action: "monitor",
        };
    }
    return null;
}

function ship(model: FlowModel): NextStep | null {
    const candidate = model.live !== null ? bestCandidate(model) : undefined;
    if (!candidate) {
        return null;
    }
    return {
        label: `Deploy v${candidate.number}`,
        detail: `v${candidate.number} scores ${points(scoreDelta(model, candidate) ?? 0)} over deployed v${model.live} and passed the promotion rule.`,
        href: versionHref(model.slug, candidate.number),
        action: "make-live",
        version: candidate.number,
    };
}

function improve(model: FlowModel): NextStep | null {
    if (model.serveOnly || !model.dataset || model.accepted < model.trainAt) {
        return null;
    }
    return {
        label: `Train v${nextNumber(model)} (+${model.accepted} rows)`,
        detail: `${model.accepted} reviewed feedback rows join the training data.`,
        href: modelHref(model.slug, "training"),
        action: "train",
        rows: model.accepted,
    };
}

function start(model: FlowModel): NextStep | null {
    if (!model.dataset) {
        return {
            label: "Add data",
            detail: "Attach the examples it learns from and is scored on.",
            href: `${FLOW}/data?for=${model.slug}`,
            action: "add-data",
        };
    }
    const ready = newestFirst(model).find(
        (version) => version.status === "ready" && (version.kind === "trained" || model.serveOnly),
    );
    const training = trainingVersion(model);
    if (!ready && training) {
        return {
            label: `Watch v${training.number}`,
            detail: `v${training.number} is training; it is scored when it finishes.`,
            href: jobHref(training.jobId),
            action: "watch",
            version: training.number,
        };
    }
    if (!ready) {
        return {
            label: `Train v${nextNumber(model)}`,
            detail: "v0 Baseline is the base with instructions only; training teaches it your data.",
            href: modelHref(model.slug, "training"),
            action: "train",
        };
    }
    if (model.live === null && ready.kind === "trained") {
        return {
            label: `Deploy v${ready.number}`,
            detail: `${model.slug} then answers with v${ready.number} on the API.`,
            href: versionHref(model.slug, ready.number),
            action: "make-live",
            version: ready.number,
        };
    }
    if (!model.deployed) {
        return {
            label: "Deploy",
            detail: `Pick a version, pool and replicas so ${model.slug} answers on the API.`,
            href: modelHref(model.slug),
            action: "deploy",
        };
    }
    return null;
}

export function nextStep(model: FlowModel): NextStep | null {
    if (model.kind === "base") {
        return null;
    }
    const step = broken(model) ?? ship(model) ?? improve(model) ?? start(model);
    if (step) {
        return step;
    }
    if (model.serveOnly) {
        return {
            label: "Connect",
            detail: `${model.base} cannot be trained; call it from your app.`,
            href: modelHref(model.slug, "keys"),
            action: "connect",
        };
    }
    return {
        label: `Train v${nextNumber(model)}`,
        detail: "Train again from the base on the latest data.",
        href: modelHref(model.slug, "training"),
        action: "train",
    };
}

export function versionKey(slug: string, number: number): string {
    return `${slug}@${number}`;
}

export function liveVersion(model: FlowModel): FlowVersion | undefined {
    return model.live !== null
        ? model.versions.find((version) => version.number === model.live)
        : undefined;
}

export function findVersion(model: FlowModel, number: number): FlowVersion | undefined {
    return model.versions.find((version) => version.number === number);
}

export function newestFirst(model: FlowModel): FlowVersion[] {
    return [...model.versions].sort((left, right) => right.number - left.number);
}

export function previousVersion(model: FlowModel, version: FlowVersion): FlowVersion | undefined {
    return newestFirst(model).find((other) => other.number < version.number);
}

export function scoreDelta(model: FlowModel, version: FlowVersion): number | null {
    const live = liveVersion(model);
    if (!live?.scores || !version.scores || live.number === version.number) {
        return null;
    }
    return version.scores[0] - live.scores[0];
}

export function beatsLive(model: FlowModel, version: FlowVersion): boolean {
    const delta = scoreDelta(model, version);
    return version.passed === true && delta !== null && delta > 0;
}

export type RuleCheck = { label: string; value: string; met: boolean };

export function ruleChecks(model: FlowModel, version: FlowVersion): RuleCheck[] {
    if (!version.scores) {
        return [];
    }
    const live = liveVersion(model);
    const [floor, slack] = model.rule;
    const checks: RuleCheck[] = [
        {
            label: `${model.metrics[0]} is at least ${pct(floor)}`,
            value: pct(version.scores[0]),
            met: version.scores[0] >= floor,
        },
    ];
    if (live?.scores && live.number !== version.number) {
        const drop = version.scores[1] - live.scores[1];
        checks.push({
            label: `${model.metrics[1]} is no more than ${(slack * 100).toFixed(1)} points below the deployed version`,
            value: `${points(drop)} points`,
            met: drop >= -slack,
        });
    }
    return checks;
}

export function ruleReason(model: FlowModel, version: FlowVersion): string {
    const missed = ruleChecks(model, version).filter((check) => !check.met);
    const first = missed[0] ?? ruleChecks(model, version)[0];
    if (!first) {
        return "The promotion rule was not met.";
    }
    return `Promotion rule: ${first.label.charAt(0).toLowerCase()}${first.label.slice(1)}; it scored ${first.value}.`;
}

export type ScoreNote = { kind: "beats"; delta: number } | { kind: "below"; reason: string } | null;

export function scoreNote(model: FlowModel, version: FlowVersion): ScoreNote {
    if (!version.scores || model.live === version.number) {
        return null;
    }
    if (version.passed === false) {
        return { kind: "below", reason: ruleReason(model, version) };
    }
    const delta = scoreDelta(model, version);
    if (delta !== null && delta > 0.0005) {
        return { kind: "beats", delta };
    }
    return null;
}

export function liveShare(model: FlowModel, number: number): number | null {
    if (model.live === number) {
        return model.canary ? 100 - model.canary.share : 100;
    }
    if (model.canary?.version === number) {
        return model.canary.share;
    }
    return null;
}

export function liveSplit(model: FlowModel): string | null {
    if (model.live === null) {
        return null;
    }
    if (model.canary) {
        return `Deployed: v${model.live} ${100 - model.canary.share}% · v${model.canary.version} ${model.canary.share}%`;
    }
    const live = liveVersion(model);
    return `Deployed: v${model.live}${live?.scores ? ` · ${pct(live.scores[0])}` : ""}`;
}

export type StatusKind =
    | "canary"
    | "candidate"
    | "failed"
    | "training"
    | "setup"
    | "idle"
    | "on"
    | "off"
    | "update";

export type StatusLine = { kind: StatusKind; text: string; version?: number };

export function statusLine(model: FlowModel): StatusLine {
    if (model.kind === "base") {
        const update = model.variants.find((item) => item.update);
        if (update) {
            return { kind: "update", text: `${update.format} has an update` };
        }
        return model.deployed
            ? { kind: "on", text: "Deployed" }
            : { kind: "off", text: "Not deployed" };
    }
    const training = trainingVersion(model);
    const newest = newestFirst(model)[0];
    const candidate = bestCandidate(model);
    if (model.canary) {
        return { kind: "canary", text: liveSplit(model) ?? "" };
    }
    if (candidate && model.live !== null) {
        const delta = scoreDelta(model, candidate) ?? 0;
        return {
            kind: "candidate",
            text: `v${candidate.number} beats deployed ${points(delta)}`,
            version: candidate.number,
        };
    }
    if (newest?.status === "failed") {
        return {
            kind: "failed",
            text: `v${newest.number} failed`,
            version: newest.number,
        };
    }
    if (training) {
        return {
            kind: "training",
            text: `v${training.number} training ${Math.round((training.progress ?? 0) * 100)}%`,
            version: training.number,
        };
    }
    if (!model.dataset) {
        return { kind: "setup", text: "Needs data" };
    }
    if (model.live === null) {
        return candidate
            ? {
                  kind: "candidate",
                  text: `v${candidate.number} ready`,
                  version: candidate.number,
              }
            : { kind: "idle", text: "Not deployed" };
    }
    return model.deployed
        ? { kind: "on", text: "Deployed" }
        : { kind: "off", text: "Not deployed" };
}

export function attention(model: FlowModel): string | null {
    const line = statusLine(model);
    return ["candidate", "failed", "training", "canary", "update"].includes(line.kind)
        ? line.text
        : null;
}

export type InboxAction = "make-live" | "review" | "retry" | "update" | "monitor" | "rollout";

export type InboxItem = {
    id: string;
    model: FlowModel | null;
    text: string;
    detail: string;
    action: InboxAction;
    label: string;
    hoursAgo: number;
    atMs?: number;
    version?: number;
    variant?: string;
    job?: number;
};

function hoursOf(item: { hoursAgo: number; atMs?: number }): number {
    return item.atMs ? (Date.now() - item.atMs) / 3600000 : item.hoursAgo;
}

export function percent(value: number): string {
    const shown = value * 100;
    return `${shown < 1 ? shown.toFixed(1) : Math.round(shown)}%`;
}

function rolloutItem(current: FlowState, model: FlowModel): InboxItem | null {
    const job = failedRollout(current, model.slug);
    if (!job) {
        return null;
    }
    const memory = /memory/i.test(job.error ?? "");
    return {
        id: `rollout:${job.id}`,
        model,
        text: `${model.name}: deploy failed${memory ? ", out of memory" : ""}`,
        detail: `${job.error ?? "The rollout stopped"}. Nothing was routed to the new deployment.`,
        action: "rollout",
        label: "View rollout",
        hoursAgo: job.hoursAgo,
        atMs: job.atMs,
        job: job.id,
    };
}

export function inbox(current: FlowState): InboxItem[] {
    const items: InboxItem[] = [];
    for (const model of current.models) {
        const rollout = rolloutItem(current, model);
        if (rollout) {
            items.push(rollout);
        }
        if (model.kind === "base") {
            for (const item of model.variants.filter((v) => v.update)) {
                items.push({
                    id: `update:${model.slug}:${item.id}`,
                    model,
                    text: `${model.name} has an update`,
                    detail: `${item.format}: ${item.update}`,
                    action: "update",
                    label: "Update",
                    hoursAgo: 30,
                    variant: item.id,
                });
            }
            continue;
        }
        const candidate = bestCandidate(model);
        const delta = candidate ? scoreDelta(model, candidate) : null;
        if (candidate && delta !== null) {
            items.push({
                id: `live:${model.slug}:${candidate.number}`,
                model,
                text: `${model.name} v${candidate.number} beats deployed v${model.live} (${points(delta)})`,
                detail: `${pct(candidate.scores?.[0])} against ${pct(liveVersion(model)?.scores?.[0])} for deployed v${model.live}, and it passed the promotion rule.`,
                action: "make-live",
                label: `Deploy v${candidate.number}`,
                hoursAgo: candidate.hoursAgo,
                atMs: candidate.atMs,
                version: candidate.number,
            });
        }
        const newest = newestFirst(model)[0];
        if (newest?.status === "failed") {
            const memory = /memory/i.test(newest.error ?? "");
            items.push({
                id: `failed:${model.slug}:${newest.number}`,
                model,
                text: `${model.name} v${newest.number} failed${memory ? ": out of memory" : ""}`,
                detail: newest.error ?? "",
                action: "retry",
                label: memory ? "Retry with QLoRA" : "Open",
                hoursAgo: newest.hoursAgo,
                atMs: newest.atMs,
                version: newest.number,
            });
        }
        if (model.deployed && model.errors > model.usualErrors * 3) {
            items.push({
                id: `errors:${model.slug}`,
                model,
                text: `${model.name} errors ${percent(model.errors)} (usually ${percent(model.usualErrors)})`,
                detail: "Most failures in the last hour are timeouts from the canary version.",
                action: "monitor",
                label: "Open monitoring",
                hoursAgo: 0.6,
            });
        }
    }
    const pending = pendingFeedback(current);
    const oldest = Math.max(0, ...pending.map((row) => row.hoursAgo));
    if (pending.length >= FEEDBACK_INBOX_ROWS || (pending.length > 0 && oldest > 3 * DAY)) {
        const owners = [...new Set(pending.map((row) => row.model))].map(
            (slug) => current.models.find((model) => model.slug === slug)?.name ?? slug,
        );
        items.push({
            id: `feedback:${pending.length}`,
            model: null,
            text: `${pending.length} feedback ${pending.length === 1 ? "row" : "rows"} to review`,
            detail: `Answers people marked wrong, for ${owners.join(", ")}.`,
            action: "review",
            label: "Review",
            hoursAgo: Math.min(...pending.map((row) => row.hoursAgo)),
        });
    }
    return items
        .filter((item) => !current.dismissed.includes(item.id))
        .sort((a, b) => hoursOf(a) - hoursOf(b));
}

export const FEEDBACK_INBOX_ROWS = 10;

export const SHOWN_VERSIONS = 5;

export function shownVersions(model: FlowModel): FlowVersion[] {
    const ordered = newestFirst(model);
    const pinned = ordered.filter(
        (version) =>
            version.number === model.live ||
            version.number === model.canary?.version ||
            beatsLive(model, version),
    );
    const rest = ordered.filter((version) => !pinned.includes(version));
    const picked = [...pinned, ...rest.slice(0, Math.max(0, SHOWN_VERSIONS - pinned.length))];
    return ordered.filter((version) => picked.includes(version));
}

export function createdAt(item: { hoursAgo: number; atMs?: number }): string {
    return new Date(item.atMs ?? Date.now() - item.hoursAgo * 3600 * 1000).toISOString();
}

export function shortAgo(item: { hoursAgo: number; atMs?: number }): string {
    const hours = hoursOf(item);
    if (hours < 1) {
        return `${Math.max(1, Math.round(hours * 60))} min ago`;
    }
    if (hours < DAY) {
        return `${Math.round(hours)} h ago`;
    }
    const days = Math.round(hours / DAY);
    return days < 14 ? `${days} d ago` : `${Math.round(days / 7)} wk ago`;
}

export function timeLeft(version: FlowVersion): string {
    const left = 1 - (version.progress ?? 0);
    if (version.atMs) {
        return `${Math.max(1, Math.ceil((left * TRAIN_MS) / 1000))} s`;
    }
    return `about ${Math.max(1, Math.ceil(left * 14))} min`;
}

export function pct(value: number | null | undefined): string {
    return value === null || value === undefined ? "–" : `${(value * 100).toFixed(1)}%`;
}

export function points(delta: number): string {
    const value = (delta * 100).toFixed(1);
    return delta > 0 ? `+${value}` : delta < 0 ? `−${value.slice(1)}` : "±0.0";
}

export type VersionState = {
    label: string;
    tone: "success" | "approval" | "warning" | "destructive" | "info" | "neutral";
};

export function versionState(model: FlowModel, version: FlowVersion): VersionState {
    if (version.status === "training") {
        return { label: "Training", tone: "info" };
    }
    if (version.status === "failed") {
        return { label: "Failed", tone: "destructive" };
    }
    const share = liveShare(model, version.number);
    if (share !== null) {
        return {
            label: share === 100 ? "Deployed" : `Deployed · ${share}%`,
            tone: "success",
        };
    }
    return { label: "Ready", tone: "neutral" };
}

export const KIND_LABELS: Record<VersionKind, string> = {
    trained: "Fine-tuned",
    prompt: "Baseline",
};

export const BASELINE_HINT = "Prompt only, not fine-tuned";

export function versionName(version: {
    number: number;
    kind: VersionKind;
}): string {
    return version.kind === "prompt" ? `v${version.number} · Baseline` : `v${version.number}`;
}

export const FLOW = "/proto/flow";

export type ModelTab = "overview" | "versions" | "training" | "monitoring" | "keys" | "variants";

export function modelHref(slug: string, tab: ModelTab = "overview"): string {
    return `${FLOW}/models/${slug}${tab === "overview" ? "" : `/${tab}`}`;
}

export function versionHref(slug: string, version: number, tab?: string): string {
    return `${FLOW}/models/${slug}/versions/v${version}${tab ? `/${tab}` : ""}`;
}

export function playgroundHref(slug: string, version?: number): string {
    return `${FLOW}/playground?model=${slug}${version === undefined ? "" : `@${version}`}`;
}

export function flowHref(slug?: string, version?: number, tab?: string): string {
    if (!slug) {
        return `${FLOW}/models`;
    }
    if (version === undefined) {
        return modelHref(slug);
    }
    return versionHref(slug, version, tab);
}

export function compareHref(slug: string, a: number, b: number, deploy = false): string {
    return `${FLOW}/models/${slug}/compare?a=${a}&b=${b}${deploy ? "&deploy=1" : ""}`;
}

export function jobHref(id: number): string {
    const job = state.jobs.find((item) => item.id === id);
    return job?.kind === "train" ? `${FLOW}/training/${id}` : `${FLOW}/jobs/${id}`;
}

export function datasetHref(slug: string): string {
    return `${FLOW}/data/${slug}`;
}

export function catalogHref(id: string): string {
    return modelHref(id);
}

export type Answer = {
    id: number;
    text: string;
    expected: string;
    answers: Record<number, string>;
};

const TICKETS: [string, string, Record<number, string>][] = [
    [
        "I was charged twice for my March invoice, please refund one.",
        "refund_request",
        { 4: "billing", 5: "refund_request" },
    ],
    [
        "Can't log in since the password reset email never arrived.",
        "account_access",
        { 4: "account_access", 5: "account_access" },
    ],
    [
        "The export button does nothing on Safari 17.",
        "bug_report",
        { 4: "bug_report", 5: "bug_report" },
    ],
    [
        "Where is my order? Tracking hasn't moved in 5 days.",
        "shipping",
        { 4: "shipping", 5: "shipping" },
    ],
    [
        "Please add dark mode to the mobile app.",
        "feature_request",
        { 4: "feature_request", 5: "feature_request" },
    ],
    [
        "Refund the annual plan, we switched to monthly by mistake.",
        "refund_request",
        { 4: "billing", 5: "refund_request" },
    ],
    [
        "Our SSO login loops back to the sign-in page.",
        "account_access",
        { 4: "bug_report", 5: "account_access" },
    ],
    ["VAT number is missing from the PDF invoice.", "billing", { 4: "billing", 5: "billing" }],
    [
        "Parcel arrived damaged, want a replacement.",
        "shipping",
        { 4: "shipping", 5: "refund_request" },
    ],
    ["App crashes when uploading a 20 MB CSV.", "bug_report", { 4: "bug_report", 5: "bug_report" }],
    [
        "Change the card on file for our team plan.",
        "billing",
        { 4: "billing", 5: "account_access" },
    ],
    [
        "Two-factor codes arrive after they expire.",
        "account_access",
        { 4: "bug_report", 5: "account_access" },
    ],
    [
        "Money back for the late delivery fee, please.",
        "refund_request",
        { 4: "shipping", 5: "refund_request" },
    ],
    [
        "Would love a Slack integration for alerts.",
        "feature_request",
        { 4: "feature_request", 5: "feature_request" },
    ],
    [
        "The dashboard shows yesterday's numbers twice.",
        "bug_report",
        { 4: "billing", 5: "bug_report" },
    ],
    [
        "Can I get an invoice addressed to our parent company?",
        "billing",
        { 4: "billing", 5: "billing" },
    ],
    [
        "Locked out after changing my email address.",
        "account_access",
        { 4: "account_access", 5: "account_access" },
    ],
    [
        "Bulk-edit tags on several tickets at once.",
        "feature_request",
        { 4: "feature_request", 5: "bug_report" },
    ],
];

export const ANSWERS: Answer[] = TICKETS.map(([text, expected, answers], index) => ({
    id: 4100 + index * 13,
    text,
    expected,
    answers,
}));

const LABELS = [
    "billing",
    "refund_request",
    "account_access",
    "bug_report",
    "shipping",
    "feature_request",
];

export function answerOf(answer: Answer, number: number): string {
    const known = answer.answers[number];
    if (known) {
        return known;
    }
    const miss =
        (answer.id * (number + 3)) % 5 === 0 ||
        (number === 0 && (answer.id % 3 === 0 || answer.id % 5 === 0));
    return miss ? LABELS[(answer.id + number) % LABELS.length] : answer.expected;
}

const TICKET_DATASETS = ["tickets-archive", "support-tickets"];

export function answersFor(model: FlowModel): Answer[] {
    return TICKET_DATASETS.includes(model.dataset ?? "") ? ANSWERS : [];
}

export type RowDiff = { text: string; label: string };

export const ROWS_ADDED: RowDiff[] = [
    { text: "Refund my order, the size was wrong.", label: "refund_request" },
    {
        text: "Charge reversed but the invoice still shows unpaid.",
        label: "billing",
    },
    {
        text: "Please cancel and refund the add-on seats.",
        label: "refund_request",
    },
    {
        text: "Password manager autofill breaks the login form.",
        label: "bug_report",
    },
];

export const ROWS_REMOVED: RowDiff[] = [
    { text: "test test ignore", label: "bug_report" },
    { text: "hello?", label: "feature_request" },
    { text: "Refund", label: "billing" },
];

export const LOSS_STEPS = 720;

export function lossCurve(
    seed: number,
): { step: number; loss: number | null; heldOut: number | null }[] {
    const rows = [];
    for (let step = 0; step <= LOSS_STEPS; step += 24) {
        const progress = step / LOSS_STEPS;
        const wobble = Math.sin((step + seed * 17) / 37) * 0.03;
        const loss = 0.32 + 1.9 * Math.exp(-progress * 4.2) + wobble;
        const heldOut = step % 120 === 0 ? 0.42 + 1.7 * Math.exp(-progress * 3.6) : null;
        rows.push({
            step,
            loss: Number(loss.toFixed(3)),
            heldOut: heldOut === null ? null : Number(heldOut.toFixed(3)),
        });
    }
    return rows;
}

export type Verdict = "worse" | "better" | "same";

export function verdictOf(answer: Answer, mine: number, theirs: number): Verdict {
    const a = answerOf(answer, mine) === answer.expected;
    const b = answerOf(answer, theirs) === answer.expected;
    return a === b ? "same" : a ? "better" : "worse";
}

export type DataChoice = { number: number; rows: number };

export function datasetOf(model: FlowModel): Dataset | undefined {
    return state.datasets.find((item) => item.slug === model.dataset);
}

export function dataChoices(model: FlowModel): DataChoice[] {
    const source = datasetOf(model);
    if (!source) {
        return [];
    }
    return [0, 1, 2]
        .map((back) => ({ number: source.version - back, rows: source.rows - back * 75 }))
        .filter((choice) => choice.number >= 1);
}

export function rowsSinceLive(model: FlowModel, rows: number): number | null {
    const live = liveVersion(model);
    return live ? rows - live.data.rows : null;
}

export const DEFAULT_SETTINGS: Omit<TrainingSettings, "rows"> = {
    adapter: "LoRA",
    rank: 16,
    epochs: 2,
    learningRate: 2e-4,
    batch: 8,
};

export function rate(value: number): string {
    return value.toExponential(0);
}

export function changedSettings(chosen: TrainingSettings): string[] {
    const changes: string[] = [];
    if (chosen.rank !== DEFAULT_SETTINGS.rank) {
        changes.push(`rank ${chosen.rank}`);
    }
    if (chosen.epochs !== DEFAULT_SETTINGS.epochs) {
        changes.push(`${chosen.epochs} epochs`);
    }
    if (chosen.learningRate !== DEFAULT_SETTINGS.learningRate) {
        changes.push(`learning rate ${rate(chosen.learningRate)}`);
    }
    return changes;
}

export function previousLive(model: FlowModel): FlowVersion | undefined {
    return newestFirst(model).find(
        (version) => version.wasLive && version.number !== model.live && version.scores,
    );
}

export function shortHash(slug: string, number: number): string {
    let hash = 2166136261;
    for (const char of `${slug}@${number}`) {
        hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0").slice(0, 7);
}

export function cardHref(slug: string, number: number): string {
    return versionHref(slug, number, "card");
}

export function trainingJobs(current: FlowState, slug: string): Job[] {
    return current.jobs.filter((job) => job.model === slug && job.kind === "train");
}

export function jobOfVersion(slug: string, number: number): number | undefined {
    const model = state.models.find((item) => item.slug === slug);
    return model ? findVersion(model, number)?.jobId : undefined;
}

export const DEVICE = "gpu-a10-1";
