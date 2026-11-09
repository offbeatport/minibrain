import { useSyncExternalStore } from "react";
import type { AvatarChoice } from "./avatarDicebear";

export type VersionKind = "trained" | "prompt";
export type VersionStatus = "ready" | "training" | "failed";

export type TrainingSettings = {
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
    rollbackErrors: boolean;
    rollbackScore: boolean;
    run: { version: number; minutesLeft: number } | null;
};

export type RecentAnswer = { question: string; answer: string; minutesAgo: number };

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
    licence: string;
    task: string;
    gpuSeconds: number;
    replicas: string[];
    variants: BaseVariant[];
    autopilot: Autopilot | null;
    pinned: boolean;
    recent: RecentAnswer[];
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
    return { rank, epochs, learningRate, rows, batch: 8 };
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
    trained(6, [0.859, 0.839], true, 5 * DAY, {
        data: data(8, 2140, 0, 0),
        settings: settings(32, 2, 1e-4, 1928),
    }),
    trained(7, null, null, 4 * DAY, {
        status: "failed",
        error: "Out of memory at step 212 of 720 on gpu-a10-1. Lower the batch or switch on gradient checkpointing.",
        data: data(8, 2140, 0, 0),
        settings: settings(64, 3, 1e-4, 1928),
    }),
    trained(8, [0.842, 0.81], false, 3 * DAY, {
        data: data(9, 2310, 220, 50),
        settings: settings(32, 3, 1e-4, 2079),
    }),
    trained(9, [0.861, 0.842], true, 2 * DAY, {
        data: data(9, 2310, 0, 0),
        settings: settings(32, 4, 5e-5, 2079),
    }),
    trained(10, [0.83, 0.79], false, DAY, {
        data: data(10, 2290, 12, 32),
        settings: settings(16, 3, 2e-4, 2061),
    }),
    trained(11, [0.865, 0.851], true, 2, {
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
    trained(3, [0.851, 0.748], true, 1.2, {
        data: data(4, 1190, 50, 0),
        settings: settings(16, 3, 2e-4, 1071),
    }),
];

const CONTRACT_REVIEWER: FlowVersion[] = [
    promptOnly([0.58, 0.51], false, 20 * DAY, 420),
    trained(1, [0.74, 0.69], true, 15 * DAY, {
        wasLive: true,
        data: data(2, 610, 190, 0),
        settings: settings(16, 3, 2e-4, 549),
    }),
    trained(2, [0.792, 0.751], true, 8 * DAY, {
        data: data(3, 780, 180, 10),
        settings: settings(16, 4, 2e-4, 702),
    }),
    trained(3, null, null, 5, {
        status: "failed",
        jobId: 1176,
        error: "Held-out loss rose for two epochs in a row, so training stopped at epoch 2 of 4. More varied rows usually help.",
        data: data(4, 1020, 260, 20),
        settings: settings(32, 4, 2e-4, 918),
    }),
    trained(4, null, null, 0.7, {
        status: "training",
        progress: 0.45,
        jobId: 1187,
        data: data(4, 1020, 0, 0),
        settings: settings(16, 3, 2e-4, 918),
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
    | "licence"
    | "task"
    | "gpuSeconds"
    | "replicas"
    | "variants"
    | "autopilot"
    | "pinned"
    | "recent"
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
            replicas: ["gpu-a10-1", "gpu-a10-3"],
            traffic: [120, 140, 132, 168, 150, 60, 41],
            previous: 760,
            p95: 410,
        }),
        variant("fp8", "FP8", "8 GB", "qwen3-8b-fp8", 5.1, {
            live: true,
            trainable: false,
            replicas: ["gpu-a10-2"],
            traffic: [90, 120, 108, 132, 138, 30, 34],
            previous: 560,
            p95: 290,
        }),
        variant("gguf-q4", "GGUF Q4", "5 GB", "qwen3-8b-gguf", 3.8, {
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
        variant("fp8", "FP8", "1.3 GB", "llama-3.2-1b-fp8", 0.9, { trainable: false }),
    ],
};

type Extra = Pick<FlowModel, "task" | "gpuSeconds" | "replicas" | "p95" | "recent"> & {
    autopilot?: Autopilot;
};

function answer(question: string, text: string, minutesAgo: number): RecentAnswer {
    return { question, answer: text, minutesAgo };
}

const EXTRA: Record<string, Extra> = {
    "support-triage": {
        task: "Classify",
        gpuSeconds: 9.6,
        replicas: ["gpu-a10-1", "gpu-a10-2"],
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
        replicas: ["gpu-a10-2"],
        p95: 310,
        autopilot: {
            threshold: 50,
            canary: 10,
            minutes: 60,
            rollbackErrors: true,
            rollbackScore: true,
            run: { version: 3, minutesLeft: 42 },
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
        recent: [
            answer("Clause 14.2: supplier may raise prices at any time.", "risky", 35),
            answer("Clause 3.1: payment within 30 days of invoice.", "standard", 52),
            answer("Clause 9: unlimited liability for the buyer.", "risky", 80),
        ],
    },
    guy1: {
        task: "Classify",
        gpuSeconds: 0.7,
        replicas: ["gpu-a10-1"],
        p95: 95,
        recent: [answer("test", "billing", 300)],
    },
    "sql-helper": { task: "SQL", gpuSeconds: 3.8, replicas: [], p95: 0, recent: [] },
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
    const p95s = live.map((item) => item.p95 ?? 0);
    return {
        ...model,
        deployed: live.length > 0,
        traffic: sumDays(model.variants.map((item) => item.traffic)),
        previous: model.variants.reduce((total, item) => total + item.previous, 0),
        serveOnly: model.variants.length > 0 && model.variants.every((item) => !item.trainable),
        size: model.variants[0]?.size ?? model.size,
        gpuSeconds: Math.min(...model.variants.map((item) => item.gpuSeconds), 99),
        replicas: [...new Set(live.flatMap((item) => item.replicas))],
        p95: p95s.length > 0 ? Math.max(...p95s) : 0,
    };
}

const RAW: RawModel[] = [
    {
        slug: "support-triage",
        name: "Support triage",
        kind: "custom",
        publisher: "Qwen",
        base: "Qwen3 8B",
        description: "Routes support tickets to one of six queues.",
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
        ...week([88, 102, 95, 120, 131, 40, 22], 512),
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
        live: 2,
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
        ...week([0, 2, 0, 5, 1, 0, 3], 4),
        serveOnly: false,
        size: null,
        versions: GUY1,
    },
    {
        slug: "sql-helper",
        name: "SQL helper",
        kind: "custom",
        publisher: "Qwen",
        base: "Qwen3 8B GGUF",
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
    {
        slug: "qwen3-8b",
        name: "Qwen3 8B",
        kind: "base",
        publisher: "Qwen",
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
    },
    {
        slug: "qwen3-0.6b",
        name: "Qwen3 0.6B",
        kind: "base",
        publisher: "Qwen",
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
    },
    {
        slug: "llama-3.2-1b",
        name: "Llama 3.2 1B",
        kind: "base",
        publisher: "Meta",
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
    },
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

const FIXED_JOBS = new Set([1176, 1187]);

const INITIAL: FlowModel[] = RAW.map((model, index) => {
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
        accepted: 0,
        p95: extra?.p95 ?? 0,
        errors:
            model.slug === "contract-reviewer"
                ? 0.021
                : model.deployed || model.kind === "base"
                  ? 0.002
                  : 0,
        licence: LICENCES[model.publisher] ?? "Apache 2.0",
        task: extra?.task ?? "Base",
        gpuSeconds: extra?.gpuSeconds ?? 0,
        replicas: extra?.replicas ?? [],
        variants: VARIANTS[model.slug] ?? [],
        autopilot: extra?.autopilot ?? null,
        pinned: false,
        recent: extra?.recent ?? BASE_RECENT,
    });
});

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
    { name: "Conflicting labels", state: "ok", detail: "No text carries two labels." },
    {
        name: "Label balance",
        state: "warning",
        detail: "feature_request has 9% of rows; the others 13 to 24%.",
    },
    { name: "Leakage", state: "ok", detail: "No held-out text appears in training." },
    { name: "Personal data", state: "ok", detail: "Emails and phone numbers scrubbed (41 rows)." },
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

export type JobKind = "train" | "score" | "download" | "import";
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
        minutes: version.status === "ready" ? (version.kind === "prompt" ? 2 : 14) : null,
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
    return { id, kind, model, version: null, status: "done", progress: 1, hoursAgo, minutes };
}

function jobsOf(models: FlowModel[]): Job[] {
    const versionJobs = models.flatMap((model) =>
        model.versions.map((version) => versionJob(model, version)),
    );
    const others: Job[] = [
        transfer(1201, "download", "qwen3-8b", 6 * DAY, 9),
        transfer(1202, "download", "llama-3.2-1b", 15 * DAY, 4),
        transfer(1203, "import", "qwen3-0.6b", 35 * DAY, 1),
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
    return [...versionJobs, ...others].sort((a, b) => a.hoursAgo - b.hoursAgo);
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

const FEEDBACK: FeedbackRow[] = [
    feedback(
        301,
        "support-triage",
        "Need my money back for the duplicate seat.",
        "billing",
        "refund_request",
        3,
    ),
    feedback(
        302,
        "support-triage",
        "The app logs me out every 5 minutes.",
        "account_access",
        "bug_report",
        5,
    ),
    feedback(
        303,
        "support-triage",
        "Courier left the parcel at the wrong address.",
        "billing",
        "shipping",
        20,
    ),
    feedback(
        304,
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
    downloaded: boolean;
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
    flags: { downloaded?: boolean; serveOnly?: boolean } = {},
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
        downloaded: flags.downloaded ?? false,
        serveOnly: flags.serveOnly ?? false,
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
        { downloaded: true },
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
        { downloaded: true },
    ),
    entry(
        "qwen3-8b-gguf",
        "Qwen3 8B GGUF",
        "Qwen",
        "8.2B",
        ["5.0 GB", "7 GB"],
        "Apache 2.0",
        "32K",
        "Quantised for serving on one GPU or CPU; cannot be trained.",
        { downloaded: true, serveOnly: true },
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

export type FlowState = {
    models: FlowModel[];
    datasets: Dataset[];
    jobs: Job[];
    feedback: FeedbackRow[];
    keys: Record<string, string[]>;
    visited: string[];
    focus: string | null;
    examples: number;
};

let state: FlowState = {
    models: INITIAL,
    datasets: DATASETS,
    jobs: jobsOf(INITIAL),
    feedback: FEEDBACK,
    keys: { "support-triage": ["mb_live_7Qx2…"] },
    visited: [],
    focus: null,
    examples: 0,
};
const listeners = new Set<() => void>();

function set(change: (current: FlowState) => FlowState) {
    state = change(state);
    for (const listener of listeners) {
        listener();
    }
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
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

function update(slug: string, change: (model: FlowModel) => FlowModel) {
    set((current) => ({
        ...current,
        models: current.models.map((model) => (model.slug === slug ? change(model) : model)),
    }));
}

function setJob(id: number, change: (job: Job) => Job) {
    set((current) => ({
        ...current,
        jobs: current.jobs.map((job) => (job.id === id ? change(job) : job)),
    }));
}

export function markVisited(step: string) {
    if (!state.visited.includes(step)) {
        set((current) => ({ ...current, visited: [...current.visited, step] }));
    }
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

export function deployVersion(slug: string, number: number) {
    const first = !state.models.find((model) => model.slug === slug)?.deployed;
    const known = state.feedback.some((row) => row.model === slug);
    update(slug, (model) => ({
        ...model,
        live: number,
        deployed: true,
        replicas: model.replicas.length > 0 ? model.replicas : ["gpu-a10-1"],
        versions: model.versions.map((version) =>
            version.number === model.live ? { ...version, wasLive: true } : version,
        ),
    }));
    if (first && !known) {
        set((current) => ({
            ...current,
            feedback: [...arrivingFeedback(slug), ...current.feedback],
        }));
    }
}

export function undeployModels(slugs: string[]) {
    set((current) => ({
        ...current,
        models: current.models.map((model) =>
            slugs.includes(model.slug)
                ? summarise({
                      ...model,
                      deployed: false,
                      live: null,
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
        item.live ? item : { ...item, live: true, replicas: ["gpu-a10-2"], p95: item.p95 ?? 180 },
    );
}

export function undeployVariants(keys: string[]) {
    changeVariants(keys, (item) => ({ ...item, live: false, replicas: [] }));
}

export function deleteVariantFiles(keys: string[]) {
    changeVariants(keys, (item) => (item.live ? item : null));
}

export function togglePin(slug: string) {
    update(slug, (model) => ({ ...model, pinned: !model.pinned }));
}

export function setAutopilot(slug: string, autopilot: Autopilot | null) {
    update(slug, (model) => ({ ...model, autopilot }));
}

export function baseModelSlug(name: string): string {
    const found = state.models.find(
        (model) =>
            model.kind === "base" &&
            (model.name === name ||
                (model.variants.length > 1 && name.startsWith(`${model.name} `))),
    );
    return found?.slug ?? slugify(name);
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

export function createModel(name: string, baseId: string, avatar: AvatarChoice): string {
    const base = catalogEntry(baseId) ?? CATALOG[0];
    const taken = new Set(state.models.map((model) => model.slug));
    const stem = slugify(name) || "model";
    let slug = stem;
    for (let suffix = 2; taken.has(slug); suffix += 1) {
        slug = `${stem}-${suffix}`;
    }
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
        licence: base.licence,
        task: "Classify",
        gpuSeconds: 0,
        replicas: [],
        variants: [],
        autopilot: null,
        pinned: false,
        recent: [],
    };
    set((current) => ({ ...current, models: [model, ...current.models], focus: slug }));
    return slug;
}

export function uploadSample(): string {
    const slug = "support-tickets";
    if (!state.datasets.some((item) => item.slug === slug)) {
        const uploaded = {
            ...dataset(slug, "Support tickets", SAMPLE_FILE, 2140, 1, 0),
            atMs: Date.now(),
        };
        set((current) => ({ ...current, datasets: [uploaded, ...current.datasets] }));
    }
    return slug;
}

let nextJob = 1300;

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
    const source = state.datasets.find((item) => item.slug === model.dataset);
    const last = newestFirst(model).find((version) => version.settings)?.settings;
    return last ?? settings(16, 3, 2e-4, source?.split[0] ?? 1926);
}

function tick(slug: string, number: number, jobId: number, timer: number) {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job || job.status !== "running") {
        window.clearInterval(timer);
        return;
    }
    const progress = Math.min(1, job.progress + TICK_MS / TRAIN_MS);
    const owner = state.models.find((item) => item.slug === slug);
    const scores = progress >= 1 && owner ? nextScores(owner, number) : null;
    setJob(jobId, (item) => ({
        ...item,
        progress,
        status: scores ? "done" : "running",
        minutes: scores ? 12 : null,
    }));
    update(slug, (current) => ({
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

export function startTraining(slug: string, recipe: TrainingSettings): number {
    const model = state.models.find((item) => item.slug === slug);
    if (!model) {
        return 0;
    }
    const source = state.datasets.find((item) => item.slug === model.dataset);
    const number = Math.max(0, ...model.versions.map((version) => version.number)) + 1;
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
        data: data(source?.version ?? 1, (source?.rows ?? 2140) + added, added, 0),
        settings: { ...recipe, rows: recipe.rows + added },
        p50: 44,
    };
    update(slug, (current) => ({
        ...current,
        accepted: 0,
        versions: [...current.versions, version],
    }));
    set((current) => ({
        ...current,
        jobs: [{ ...versionJob(model, version), atMs: Date.now() }, ...current.jobs],
    }));
    const timer = window.setInterval(() => tick(slug, number, jobId, timer), TICK_MS);
    return jobId;
}

export function cancelJobs(ids: number[]) {
    set((current) => ({
        ...current,
        jobs: current.jobs.map((job) =>
            ids.includes(job.id) && (job.status === "running" || job.status === "queued")
                ? { ...job, status: "cancelled" }
                : job,
        ),
    }));
}

export function retryJobs(ids: number[]) {
    set((current) => ({
        ...current,
        jobs: current.jobs.map((job) =>
            ids.includes(job.id) && (job.status === "failed" || job.status === "cancelled")
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
    set((current) => ({
        ...current,
        keys: { ...current.keys, [slug]: [...(current.keys[slug] ?? []), `${key.slice(0, 12)}…`] },
    }));
    return key;
}

export function saveExample() {
    set((current) => ({ ...current, examples: current.examples + 1 }));
}

export function countRequest(slug: string) {
    update(slug, (model) => ({
        ...model,
        traffic: [...model.traffic.slice(0, -1), (model.traffic.at(-1) ?? 0) + 1],
    }));
}

export type NextStep = { label: string; detail: string; href: string; train?: boolean };

function nextNumber(model: FlowModel): number {
    return Math.max(0, ...model.versions.map((version) => version.number)) + 1;
}

function deployCandidate(model: FlowModel): FlowVersion | undefined {
    const live = liveVersion(model);
    return newestFirst(model).find(
        (version) =>
            version.passed === true &&
            version.kind === "trained" &&
            (!live ||
                (version.number > live.number &&
                    (version.scores?.[0] ?? 0) > (live.scores?.[0] ?? 0))),
    );
}

export function nextStep(current: FlowState, model: FlowModel): NextStep | null {
    if (model.kind === "base") {
        return null;
    }
    const pending = current.feedback.filter(
        (row) => row.model === model.slug && row.state === "pending",
    ).length;
    const training = model.versions.find((version) => version.status === "training");
    const live = liveVersion(model);
    const candidate = deployCandidate(model);
    if (!model.dataset) {
        return {
            label: "Add data",
            detail: "Pick or upload the examples it learns from and is scored on.",
            href: modelHref(model.slug, "data"),
        };
    }
    if (training) {
        return {
            label: `Training v${training.number} · ${Math.round((training.progress ?? 0) * 100)}%`,
            detail: "It is scored against v0 when it finishes.",
            href: jobHref(training.jobId),
        };
    }
    if (model.serveOnly && !model.versions.some((version) => version.kind === "trained")) {
        return {
            label: "Switch base to train",
            detail: `${model.base} is serve-only: GGUF weights cannot be trained. Its v0 can still be deployed.`,
            href: modelHref(model.slug),
        };
    }
    if (!model.versions.some((version) => version.kind === "trained")) {
        return {
            label: "Train v1",
            detail: "v0 is the base with instructions only; training teaches it your labels.",
            href: modelHref(model.slug),
            train: true,
        };
    }
    if (candidate) {
        return {
            label: `Deploy v${candidate.number}`,
            detail: live
                ? `It beats live v${live.number} and passed the promotion rule.`
                : "It passed the promotion rule.",
            href: versionHref(model.slug, candidate.number),
        };
    }
    if (model.accepted > 0) {
        return {
            label: `Train v${nextNumber(model)} (+${model.accepted} accepted ${model.accepted === 1 ? "row" : "rows"})`,
            detail: "Accepted feedback joins the training data.",
            href: modelHref(model.slug),
            train: true,
        };
    }
    if (pending > 0) {
        return {
            label: `Review ${pending} feedback ${pending === 1 ? "row" : "rows"}`,
            detail: "People flagged answers as wrong.",
            href: `${FLOW}/feedback`,
        };
    }
    return {
        label: "Try it in the Playground",
        detail: "Nothing needs doing.",
        href: `${FLOW}/playground?model=${model.slug}`,
    };
}

export function versionKey(slug: string, number: number): string {
    return `${slug}@${number}`;
}

export function liveVersion(model: FlowModel): FlowVersion | undefined {
    return model.deployed && model.live !== null
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

export function attention(model: FlowModel): string | null {
    const newest = newestFirst(model)[0];
    if (!newest) {
        return null;
    }
    const training = model.versions.find((version) => version.status === "training");
    if (training) {
        return `v${training.number} training · ${Math.round((training.progress ?? 0) * 100)}%`;
    }
    if (newest.status === "failed") {
        return `v${newest.number} failed`;
    }
    const better = newestFirst(model).find((version) => beatsLive(model, version));
    if (better) {
        return `v${better.number} beats live`;
    }
    return null;
}

export const SHOWN_VERSIONS = 5;

export function shownVersions(model: FlowModel): FlowVersion[] {
    const ordered = newestFirst(model);
    const pinned = ordered.filter(
        (version) => version.number === liveVersion(model)?.number || beatsLive(model, version),
    );
    const rest = ordered.filter((version) => !pinned.includes(version));
    const picked = [...pinned, ...rest.slice(0, Math.max(0, SHOWN_VERSIONS - pinned.length))];
    return ordered.filter((version) => picked.includes(version));
}

export function createdAt(item: { hoursAgo: number; atMs?: number }): string {
    return new Date(item.atMs ?? Date.now() - item.hoursAgo * 3600 * 1000).toISOString();
}

export function shortAgo(item: { hoursAgo: number; atMs?: number }): string {
    const hours = item.atMs ? (Date.now() - item.atMs) / 3600000 : item.hoursAgo;
    if (hours < 1) {
        return `${Math.max(1, Math.round(hours * 60))} min ago`;
    }
    if (hours < DAY) {
        return `${Math.round(hours)} h ago`;
    }
    const days = Math.round(hours / DAY);
    return days < 14 ? `${days} d ago` : `${Math.round(days / 7)} wk ago`;
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
    if (liveVersion(model)?.number === version.number) {
        return { label: "Live", tone: "success" };
    }
    if (version.passed === false) {
        return { label: "Rejected", tone: "warning" };
    }
    return { label: "Passed", tone: "approval" };
}

export const KIND_LABELS: Record<VersionKind, string> = {
    trained: "Trained",
    prompt: "Prompt only",
};

export const FLOW = "/proto/flow";

export type ModelTab = "overview" | "versions" | "data" | "api";

export function modelHref(slug: string, tab: ModelTab = "overview"): string {
    return `${FLOW}/models/${slug}${tab === "overview" ? "" : `/${tab}`}`;
}

export function versionHref(slug: string, version: number, tab?: string): string {
    return `${FLOW}/models/${slug}/versions/v${version}${tab ? `/${tab}` : ""}`;
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
    return `${FLOW}/jobs/${id}`;
}

export function datasetHref(slug: string): string {
    return `${FLOW}/data/${slug}`;
}

export function catalogHref(id: string): string {
    return `${FLOW}/discover/${id}`;
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
    const miss = (answer.id * (number + 3)) % 5 === 0;
    return miss ? LABELS[(answer.id + number) % LABELS.length] : answer.expected;
}

const TICKET_DATASETS = ["tickets-archive", "support-tickets"];

export function answersFor(model: FlowModel): Answer[] {
    return TICKET_DATASETS.includes(model.dataset ?? "") ? ANSWERS : [];
}

export type RowDiff = { text: string; label: string };

export const ROWS_ADDED: RowDiff[] = [
    { text: "Refund my order, the size was wrong.", label: "refund_request" },
    { text: "Charge reversed but the invoice still shows unpaid.", label: "billing" },
    { text: "Please cancel and refund the add-on seats.", label: "refund_request" },
    { text: "Password manager autofill breaks the login form.", label: "bug_report" },
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
