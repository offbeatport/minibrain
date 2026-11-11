import { FlaskConical, GitCompare, Scale } from "lucide-react";
import {
    Badge,
    CheckboxSelect,
    CodeBlock,
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
import { useState } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page, PanelSection, PanelSections } from "~/components/Section";
import { count } from "~/lib/format";
import { type FlowModel, modelHref, pct, shortAgo, useFlowState } from "./modelsFlowData";
import { ModelAvatar } from "./modelsFlowParts";

type GraderId = "exact" | "labels" | "json" | "judge";

type TestSet = {
    id: string;
    name: string;
    model: string;
    kind: "Golden" | "Held-out";
    source: string;
    rows: number;
    graders: GraderId[];
    hoursAgo: number;
};

const TEST_SETS: TestSet[] = [
    {
        id: "triage-golden",
        name: "Triage golden set",
        model: "support-triage",
        kind: "Golden",
        source: "Checked by hand, never trained on",
        rows: 48,
        graders: ["labels", "judge"],
        hoursAgo: 4 * 24,
    },
    {
        id: "triage-held-out",
        name: "Triage held-out",
        model: "support-triage",
        kind: "Held-out",
        source: "10% of tickets-archive v10",
        rows: 212,
        graders: ["labels"],
        hoursAgo: 26,
    },
    {
        id: "invoices-golden",
        name: "Invoices golden set",
        model: "invoice-extractor",
        kind: "Golden",
        source: "Checked by hand, never trained on",
        rows: 30,
        graders: ["json"],
        hoursAgo: 12 * 24,
    },
    {
        id: "invoices-held-out",
        name: "Invoices held-out",
        model: "invoice-extractor",
        kind: "Held-out",
        source: "10% of invoices-q3 v3",
        rows: 96,
        graders: ["json"],
        hoursAgo: 9 * 24,
    },
    {
        id: "contracts-held-out",
        name: "Contracts held-out",
        model: "contract-reviewer",
        kind: "Held-out",
        source: "10% of supplier-contracts v4",
        rows: 78,
        graders: ["labels"],
        hoursAgo: 5 * 24,
    },
    {
        id: "finance-golden",
        name: "Finance questions golden set",
        model: "sql-helper",
        kind: "Golden",
        source: "Written by the finance team",
        rows: 40,
        graders: ["exact", "judge"],
        hoursAgo: 2 * 24,
    },
];

const RUBRIC = `Score the answer from 1 to 5.
5: routes the ticket to the right queue and invents nothing.
3: right queue, but the reason given is wrong or missing.
1: wrong queue, or the answer makes up order or account details.
Reply with the score and one sentence on why.`;

const GRADERS: { id: GraderId; name: string; detail: string; metric: string }[] = [
    {
        id: "exact",
        name: "Exact match",
        detail: "The answer must equal the expected text once whitespace and case are set aside.",
        metric: "Exact match",
    },
    {
        id: "labels",
        name: "Label accuracy",
        detail: "Share of rows where the predicted label is the expected one, with macro F1 beside it so a rare label still counts.",
        metric: "Label accuracy",
    },
    {
        id: "json",
        name: "JSON fields",
        detail: "Parses the answer as JSON and checks each expected field; a row passes when every field matches.",
        metric: "Field accuracy",
    },
    {
        id: "judge",
        name: "Judge model",
        detail: "Qwen3 8B, running on this install, reads each answer with the rubric below and scores it.",
        metric: "Judge score",
    },
];

type Candidate = {
    id: string;
    label: string;
    kind: "Version" | "Base";
    detail: string;
    score: number;
    cost: number;
    p95: number;
    memory: string;
};

const CANDIDATES: Candidate[] = [
    {
        id: "st-4",
        label: "support-triage@4",
        kind: "Version",
        detail: "Live · fine-tuned on Qwen3 8B",
        score: 0.867,
        cost: 9.6,
        p95: 240,
        memory: "16 GB",
    },
    {
        id: "st-5",
        label: "support-triage@5",
        kind: "Version",
        detail: "Ready · fine-tuned on Qwen3 8B",
        score: 0.881,
        cost: 9.6,
        p95: 236,
        memory: "16 GB",
    },
    {
        id: "qwen3-8b",
        label: "Qwen3 8B",
        kind: "Base",
        detail: "Prompt only, BF16",
        score: 0.712,
        cost: 9.6,
        p95: 410,
        memory: "16 GB",
    },
    {
        id: "qwen3-8b-fp8",
        label: "Qwen3 8B FP8",
        kind: "Base",
        detail: "Prompt only, FP8",
        score: 0.701,
        cost: 5.1,
        p95: 290,
        memory: "8 GB",
    },
    {
        id: "llama-3.2-1b",
        label: "Llama 3.2 1B",
        kind: "Base",
        detail: "Prompt only, BF16",
        score: 0.588,
        cost: 1.3,
        p95: 150,
        memory: "2.5 GB",
    },
    {
        id: "qwen3-0.6b",
        label: "Qwen3 0.6B",
        kind: "Base",
        detail: "Prompt only, BF16",
        score: 0.541,
        cost: 0.8,
        p95: 95,
        memory: "1.4 GB",
    },
];

const DEFAULT_PICK = ["st-4", "qwen3-8b", "qwen3-8b-fp8", "llama-3.2-1b"];

function offsetOf(testSet: string): number {
    return [...testSet].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 7;
}

function scoreOn(candidate: Candidate, testSet: string): number {
    const shift = (offsetOf(testSet) - 3) / 100;
    return Math.max(0.3, Math.min(0.98, candidate.score + shift));
}

function UsedBy({ models }: { models: FlowModel[] }) {
    if (models.length === 0) {
        return <span className="text-muted-foreground">No model yet</span>;
    }
    return (
        <span className="flex flex-wrap gap-x-3 gap-y-1.5">
            {models.map((model) => (
                <Link
                    key={model.slug}
                    href={modelHref(model.slug)}
                    className="flex items-center gap-1.5 hover:underline"
                >
                    <ModelAvatar model={model} />
                    {model.name}
                </Link>
            ))}
        </span>
    );
}

function TestSets({ models }: { models: FlowModel[] }) {
    const shown = TEST_SETS.filter((set) => models.some((model) => model.slug === set.model));
    return (
        <PanelSection
            icon={FlaskConical}
            title="Test sets"
            description="What each model is scored on: held-out rows from its dataset, or golden sets checked by hand."
            flush
        >
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="pl-panel">Test set</TableHead>
                        <TableHead>Model</TableHead>
                        <TableHead>Kind</TableHead>
                        <TableHead className="text-right">Rows</TableHead>
                        <TableHead>Graded by</TableHead>
                        <TableHead className="pr-panel">Updated</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {shown.length === 0 && (
                        <TableRow>
                            <TableCell
                                colSpan={6}
                                className="py-6 text-center text-muted-foreground"
                            >
                                No test sets yet. Attaching a dataset to a model makes its held-out
                                set.
                            </TableCell>
                        </TableRow>
                    )}
                    {shown.map((set) => {
                        const model = models.find((item) => item.slug === set.model);
                        return (
                            <TableRow key={set.id}>
                                <TableCell className="pl-panel">
                                    <span className="flex flex-col">
                                        <span className="font-medium">{set.name}</span>
                                        <span className="text-sm text-muted-foreground">
                                            {set.source}
                                        </span>
                                    </span>
                                </TableCell>
                                <TableCell>{model && <UsedBy models={[model]} />}</TableCell>
                                <TableCell>
                                    <Badge variant={set.kind === "Golden" ? "approval" : "neutral"}>
                                        {set.kind}
                                    </Badge>
                                </TableCell>
                                <TableCell className="text-right">{count(set.rows)}</TableCell>
                                <TableCell>
                                    {set.graders
                                        .map(
                                            (id) =>
                                                GRADERS.find((grader) => grader.id === id)?.name,
                                        )
                                        .join(", ")}
                                </TableCell>
                                <TableCell className="pr-panel text-muted-foreground tabular-nums">
                                    {shortAgo(set)}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </PanelSection>
    );
}

function Graders({ models }: { models: FlowModel[] }) {
    return (
        <PanelSection
            icon={Scale}
            title="Graders"
            description="How an answer becomes a score; every version of a model is scored by the same ones."
        >
            <ul className="grid gap-4 lg:grid-cols-3">
                {GRADERS.map((grader) => {
                    const users = models.filter((model) =>
                        TEST_SETS.some(
                            (set) => set.model === model.slug && set.graders.includes(grader.id),
                        ),
                    );
                    return (
                        <li
                            key={grader.id}
                            className={cn(
                                "flex flex-col gap-3 rounded-md border p-4",
                                grader.id === "judge" && "lg:col-span-3",
                            )}
                        >
                            <div className="flex flex-col gap-1">
                                <span className="flex flex-wrap items-baseline gap-x-2">
                                    <span className="font-semibold">{grader.name}</span>
                                    <span className="text-sm text-muted-foreground">
                                        {`Reports ${grader.metric.toLowerCase()}`}
                                    </span>
                                </span>
                                <span className="text-muted-foreground">{grader.detail}</span>
                            </div>
                            {grader.id === "judge" && (
                                <CodeBlock code={RUBRIC} language="text" title="Rubric" wrap />
                            )}
                            <div className="flex flex-col gap-1.5">
                                <span className="text-sm text-muted-foreground">Used by</span>
                                <UsedBy models={users} />
                            </div>
                        </li>
                    );
                })}
            </ul>
        </PanelSection>
    );
}

const WIDTH = 640;
const HEIGHT = 300;
const PAD = { left: 48, right: 128, top: 16, bottom: 40 };

function QualityCost({ picked, testSet }: { picked: Candidate[]; testSet: string }) {
    const [hover, setHover] = useState<string | null>(null);
    const scores = picked.map((item) => scoreOn(item, testSet));
    const low = Math.max(0, Math.floor((Math.min(...scores) - 0.05) * 20) / 20);
    const high = Math.min(1, Math.ceil((Math.max(...scores) + 0.03) * 20) / 20);
    const most = Math.ceil(Math.max(...picked.map((item) => item.cost)) / 2) * 2 + 2;
    const x = (cost: number) => PAD.left + (cost / most) * (WIDTH - PAD.left - PAD.right);
    const y = (score: number) =>
        PAD.top + (1 - (score - low) / (high - low)) * (HEIGHT - PAD.top - PAD.bottom);
    const yTicks = Array.from(
        { length: Math.round((high - low) / 0.05) + 1 },
        (_, index) => low + index * 0.05,
    );
    const xTicks = Array.from({ length: most / 2 + 1 }, (_, index) => index * 2);
    const placed = picked
        .map((item) => ({ item, cx: x(item.cost), cy: y(scoreOn(item, testSet)) }))
        .sort((a, b) => a.cy - b.cy);
    let last = Number.NEGATIVE_INFINITY;
    const labels = placed.map((point) => {
        const ly = Math.max(point.cy, last + 16);
        last = ly;
        return { ...point, ly };
    });
    const active = labels.find((point) => point.item.id === hover);
    return (
        <figure className="relative flex flex-col gap-2 overflow-x-auto">
            <figcaption className="text-sm text-muted-foreground">
                Quality against cost. Up and to the left is better.
            </figcaption>
            <svg
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                width={WIDTH}
                height={HEIGHT}
                className="shrink-0"
                role="img"
                aria-label="Score against cost per 1,000 requests for each candidate"
            >
                {yTicks.map((tick) => (
                    <g key={`y${tick}`}>
                        <line
                            x1={PAD.left}
                            x2={WIDTH - PAD.right}
                            y1={y(tick)}
                            y2={y(tick)}
                            stroke="var(--border)"
                        />
                        <text
                            x={PAD.left - 8}
                            y={y(tick)}
                            textAnchor="end"
                            dominantBaseline="middle"
                            className="fill-muted-foreground text-sm tabular-nums"
                        >
                            {`${Math.round(tick * 100)}%`}
                        </text>
                    </g>
                ))}
                {xTicks.map((tick) => (
                    <text
                        key={`x${tick}`}
                        x={x(tick)}
                        y={HEIGHT - PAD.bottom + 18}
                        textAnchor="middle"
                        className="fill-muted-foreground text-sm tabular-nums"
                    >
                        {tick}
                    </text>
                ))}
                <text
                    x={(PAD.left + WIDTH - PAD.right) / 2}
                    y={HEIGHT - 4}
                    textAnchor="middle"
                    className="fill-muted-foreground text-sm"
                >
                    GPU·s per 1,000 requests
                </text>
                {labels.map((point) => (
                    <g
                        key={point.item.id}
                        onPointerEnter={() => setHover(point.item.id)}
                        onPointerLeave={() => setHover(null)}
                    >
                        <circle cx={point.cx} cy={point.cy} r={14} fill="transparent" />
                        <circle
                            cx={point.cx}
                            cy={point.cy}
                            r={hover === point.item.id ? 6 : 5}
                            fill="var(--primary)"
                            stroke="var(--card)"
                            strokeWidth={2}
                        />
                        <text
                            x={point.cx + 10}
                            y={point.ly}
                            dominantBaseline="middle"
                            className="fill-foreground text-sm"
                        >
                            {point.item.label}
                        </text>
                    </g>
                ))}
            </svg>
            {active && (
                <div
                    className="pointer-events-none absolute z-10 flex flex-col rounded-md border bg-popover px-3 py-2 text-sm shadow-e2"
                    style={{
                        left: active.cx,
                        top: active.cy + 28,
                        transform: "translate(-50%, -120%)",
                    }}
                >
                    <span className="font-medium">{active.item.label}</span>
                    <span className="tabular-nums text-muted-foreground">
                        {`${pct(scoreOn(active.item, testSet))} · ${active.item.cost.toFixed(1)} GPU·s per 1k`}
                    </span>
                </div>
            )}
        </figure>
    );
}

function Compare({ models }: { models: FlowModel[] }) {
    const sets = TEST_SETS.filter((set) => models.some((model) => model.slug === set.model));
    const [testSet, setTestSet] = useState(sets[0]?.id ?? "");
    const [chosen, setChosen] = useState<string[]>(DEFAULT_PICK);
    const picked = CANDIDATES.filter((item) => chosen.includes(item.id));
    const set = TEST_SETS.find((item) => item.id === testSet);
    const grader = GRADERS.find((item) => item.id === set?.graders[0]);
    const best = Math.max(...picked.map((item) => scoreOn(item, testSet)));
    const cheapest = Math.min(...picked.map((item) => item.cost));
    return (
        <PanelSection
            icon={GitCompare}
            title="Compare models"
            description="Score versions and bases on one test set, then pick the base worth training. Prototype scores."
        >
            <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                    <Select value={testSet} onValueChange={(value) => setTestSet(String(value))}>
                        <SelectTrigger aria-label="Test set" className="w-auto min-w-64">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {sets.map((item) => (
                                <SelectItem key={item.id} value={item.id} label={item.name}>
                                    {item.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <CheckboxSelect
                        label="Candidates"
                        allLabel="All candidates"
                        noun="candidates"
                        options={CANDIDATES.map((item) => ({
                            value: item.id,
                            label: item.label,
                            text: item.label,
                        }))}
                        value={chosen}
                        onValueChange={(value) => setChosen(value.slice(-4))}
                    />
                    <span className="text-sm text-muted-foreground tabular-nums">
                        {picked.length < 2
                            ? "Pick at least 2 candidates."
                            : `${picked.length} of 4 at most · ${set ? `${count(set.rows)} rows, graded by ${grader?.name.toLowerCase()}` : ""}`}
                    </span>
                </div>
                {picked.length >= 2 && (
                    <div className="flex flex-col gap-6">
                        <div className="overflow-x-auto rounded-md border">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Candidate</TableHead>
                                        <TableHead className="text-right">
                                            {grader?.metric ?? "Score"}
                                        </TableHead>
                                        <TableHead className="text-right">Latency p95</TableHead>
                                        <TableHead className="text-right">Cost / 1k req.</TableHead>
                                        <TableHead className="text-right">Memory</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {picked.map((item) => {
                                        const score = scoreOn(item, testSet);
                                        return (
                                            <TableRow key={item.id}>
                                                <TableCell>
                                                    <span className="flex flex-col">
                                                        <span className="font-medium">
                                                            {item.label}
                                                        </span>
                                                        <span className="text-sm text-muted-foreground">
                                                            {`${item.kind} · ${item.detail}`}
                                                        </span>
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    <span className="inline-flex items-center gap-2">
                                                        {score === best && (
                                                            <Badge variant="success">Best</Badge>
                                                        )}
                                                        {pct(score)}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-right">{`${item.p95} ms`}</TableCell>
                                                <TableCell className="text-right">
                                                    <span className="inline-flex items-center gap-2">
                                                        {item.cost === cheapest && (
                                                            <Badge variant="success">
                                                                Cheapest
                                                            </Badge>
                                                        )}
                                                        {`${item.cost.toFixed(1)} GPU·s`}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    {item.memory}
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                        <QualityCost picked={picked} testSet={testSet} />
                    </div>
                )}
            </div>
        </PanelSection>
    );
}

export function FlowEvaluationsPage() {
    const state = useFlowState();
    const custom = state.models.filter((model) => model.kind === "custom");
    return (
        <Page wide>
            <PageHeader
                title="Evaluations"
                caption="How quality is measured: the test sets versions are scored on, the graders that score them, and a side-by-side for picking a base."
            />
            <PanelSections>
                <TestSets models={custom} />
                <Graders models={custom} />
                <Compare models={custom} />
            </PanelSections>
        </Page>
    );
}
