import { useParams } from "@tanstack/react-router";
import { Download } from "lucide-react";
import {
    Badge,
    Button,
    Link,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    cn,
    useToast,
} from "obp-ui";
import type { ReactNode } from "react";
import { Facts } from "~/components/Facts";
import { PageHeader } from "~/components/PageHeader";
import { Page, Section } from "~/components/Section";
import { count } from "~/lib/format";
import { relativeTime } from "~/lib/time";
import { ReportCard, VersionMenu, VersionPrimary } from "./flowVersionCard";
import {
    type Answer,
    type FlowModel,
    type FlowVersion,
    KIND_LABELS,
    type Verdict,
    answerOf,
    createdAt,
    findVersion,
    flowHref,
    jobHref,
    liveVersion,
    pct,
    rate,
    shortAgo,
    useFlowModel,
    verdictOf,
    versionHref,
    versionName,
    versionState,
} from "./modelsFlowData";
import { Crumbs } from "./modelsFlowParts";

type DiffRow = { label: string; before: string; after: string };

export function dataRows(a: FlowVersion, b: FlowVersion): DiffRow[] {
    return [
        {
            label: "Data version",
            before: `v${a.data.number}`,
            after: `v${b.data.number}`,
        },
        { label: "Rows", before: count(a.data.rows), after: count(b.data.rows) },
    ];
}

export function settingsRows(a: FlowVersion, b: FlowVersion): DiffRow[] {
    const of = (version: FlowVersion, pick: (s: NonNullable<FlowVersion["settings"]>) => string) =>
        version.settings ? pick(version.settings) : "—";
    return [
        { label: "Kind", before: KIND_LABELS[a.kind], after: KIND_LABELS[b.kind] },
        {
            label: "Adapter",
            before: of(a, (s) => s.adapter),
            after: of(b, (s) => s.adapter),
        },
        {
            label: "LoRA rank",
            before: of(a, (s) => String(s.rank)),
            after: of(b, (s) => String(s.rank)),
        },
        {
            label: "Epochs",
            before: of(a, (s) => String(s.epochs)),
            after: of(b, (s) => String(s.epochs)),
        },
        {
            label: "Learning rate",
            before: of(a, (s) => rate(s.learningRate)),
            after: of(b, (s) => rate(s.learningRate)),
        },
        {
            label: "Training rows",
            before: of(a, (s) => count(s.rows)),
            after: of(b, (s) => count(s.rows)),
        },
        {
            label: "Batch",
            before: of(a, (s) => String(s.batch)),
            after: of(b, (s) => String(s.batch)),
        },
    ];
}

const VERDICT_BADGES: Record<
    Verdict,
    { variant: "success" | "warning" | "neutral"; label: string }
> = {
    better: { variant: "success", label: "Better" },
    worse: { variant: "warning", label: "Worse" },
    same: { variant: "neutral", label: "Same" },
};

function Label({ value, expected }: { value: string; expected: string }) {
    const right = value === expected;
    return (
        <span className={cn("font-mono text-sm", right ? "text-foreground" : "text-destructive")}>
            {value}
            <span className="sr-only">{right ? " (right)" : " (wrong)"}</span>
        </span>
    );
}

export function AnswersTable({
    rows,
    mine,
    theirs,
    theirsLabel,
}: {
    rows: Answer[];
    mine: number;
    theirs: number;
    theirsLabel: string;
}) {
    return (
        <div className="overflow-x-auto rounded-md border">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead className="w-20">Row</TableHead>
                        <TableHead>Input</TableHead>
                        <TableHead>Expected</TableHead>
                        <TableHead>{`v${mine}`}</TableHead>
                        <TableHead>{theirsLabel}</TableHead>
                        <TableHead className="w-24" />
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((answer) => {
                        const verdict = verdictOf(answer, mine, theirs);
                        return (
                            <TableRow key={answer.id}>
                                <TableCell className="font-mono text-sm text-muted-foreground">
                                    {`#${answer.id}`}
                                </TableCell>
                                <TableCell className="max-w-72 truncate" title={answer.text}>
                                    {answer.text}
                                </TableCell>
                                <TableCell className="font-mono text-sm">
                                    {answer.expected}
                                </TableCell>
                                <TableCell>
                                    <Label
                                        value={answerOf(answer, mine)}
                                        expected={answer.expected}
                                    />
                                </TableCell>
                                <TableCell>
                                    <Label
                                        value={answerOf(answer, theirs)}
                                        expected={answer.expected}
                                    />
                                </TableCell>
                                <TableCell className="text-right">
                                    <Badge variant={VERDICT_BADGES[verdict].variant}>
                                        {VERDICT_BADGES[verdict].label}
                                    </Badge>
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}

function CardBlock({ title, items }: { title: string; items: [string, ReactNode][] }) {
    return (
        <section className="flex flex-col gap-2 border-t pt-4 first:border-t-0 first:pt-0">
            <h3 className="font-semibold">{title}</h3>
            <Facts items={items} />
        </section>
    );
}

function ModelCard({ model, version }: { model: FlowModel; version: FlowVersion }) {
    const toast = useToast();
    const live = liveVersion(model);
    const download = (format: string) =>
        toast({
            title: "Not in the prototype",
            description: `Would download the model card as ${format}.`,
        });
    const sha = `9f2c${(version.number * 7919).toString(16).padStart(4, "0")}e1b04d7a5c3e88f0a12bd6c4e9f7031a2b5d8c6e4f9a0b1c2d3e4f5a6b7c8d9e`;
    return (
        <Section
            title="Model card"
            caption={`Generated for v${version.number}; read-only. Edit purpose and limits on the model page.`}
            actions={
                <>
                    <Button variant="outline" onClick={() => download("Markdown")}>
                        <Download aria-hidden="true" />
                        Markdown
                    </Button>
                    <Button variant="outline" onClick={() => download("JSON")}>
                        <Download aria-hidden="true" />
                        JSON
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-4">
                <CardBlock
                    title="Purpose"
                    items={[
                        ["Task", model.description || "Chat assistant"],
                        [
                            "Output",
                            "One label from six: billing, refund_request, account_access, bug_report, shipping, feature_request",
                        ],
                    ]}
                />
                <CardBlock
                    title="Intended use"
                    items={[
                        ["Use", "Route inbound tickets before a person reads them."],
                        ["Not for", "Deciding refunds or account actions on its own."],
                        ["Owner", "Support operations"],
                    ]}
                />
                <CardBlock
                    title="Base and licence"
                    items={[
                        ["Base", model.base ?? model.name],
                        ["Licence", "Apache 2.0 · commercial use allowed"],
                        ["Method", KIND_LABELS[version.kind]],
                    ]}
                />
                <CardBlock
                    title="Data"
                    items={[
                        ["Dataset", `${model.dataset ?? "Dataset"} v${version.data.number}`],
                        [
                            "Rows",
                            <span key="r" className="tabular-nums">
                                {count(version.data.rows)}
                            </span>,
                        ],
                        ["Checks", "Passed: no duplicates, no leakage, personal data scrubbed"],
                    ]}
                />
                <CardBlock
                    title="Training"
                    items={[
                        [
                            "Settings",
                            version.settings
                                ? `SFT, ${version.settings.adapter} rank ${version.settings.rank}, ${version.settings.epochs} epochs, rate ${rate(version.settings.learningRate)}`
                                : "Not trained",
                        ],
                        [
                            "Job",
                            <Link
                                key="j"
                                href={jobHref(version.jobId)}
                                className="text-primary hover:underline"
                            >{`#${version.jobId}`}</Link>,
                        ],
                    ]}
                />
                <CardBlock
                    title="Evaluation"
                    items={model.metrics.map((metric, index) => [
                        metric,
                        <span key={metric} className="tabular-nums">
                            {pct(version.scores?.[index])}
                        </span>,
                    ])}
                />
                <CardBlock
                    title="Known limits"
                    items={[
                        [
                            "From the scores",
                            "Confuses billing with refund_request when a ticket asks for money back without the word refund.",
                        ],
                        [
                            "Written by the team",
                            "English only. Not tested on tickets longer than 2,000 characters.",
                        ],
                    ]}
                />
                <CardBlock
                    title="Approvals"
                    items={[
                        [
                            "Promotion rule",
                            version.passed === null
                                ? "Not checked"
                                : version.passed
                                  ? "Met"
                                  : "Below rule",
                        ],
                        [
                            "Live",
                            live?.number === version.number
                                ? `Live since ${relativeTime(createdAt(version))}`
                                : version.wasLive
                                  ? "Was live"
                                  : "Never",
                        ],
                    ]}
                />
                <CardBlock
                    title="Integrity"
                    items={[
                        [
                            "Adapter SHA-256",
                            <span key="h" className="font-mono text-sm break-all">
                                {sha}
                            </span>,
                        ],
                    ]}
                />
            </div>
        </Section>
    );
}

export function ModelsFlowVersionPage() {
    const params = useParams({ strict: false }) as {
        model?: string;
        version?: string;
        tab?: string;
    };
    const model = useFlowModel(params.model);
    const number = Number((params.version ?? "").replace(/^v/, ""));
    const version = model ? findVersion(model, number) : undefined;
    if (!model || !version) {
        return (
            <Page>
                <Crumbs
                    items={[
                        { label: "Models", href: flowHref() },
                        { label: `${params.model} ${params.version}` },
                    ]}
                />
                <p className="text-muted-foreground">No such version.</p>
            </Page>
        );
    }
    const crumbs = [
        { label: "Models", href: flowHref() },
        { label: model.name, href: flowHref(model.slug) },
    ];
    if (params.tab === "card") {
        return (
            <Page>
                <Crumbs
                    items={[
                        ...crumbs,
                        {
                            label: `v${version.number}`,
                            href: versionHref(model.slug, version.number),
                        },
                        { label: "Model card" },
                    ]}
                />
                <PageHeader
                    title={`v${version.number} model card`}
                    caption={`${model.name} on ${model.base} · created ${shortAgo(version)}`}
                />
                <ModelCard model={model} version={version} />
            </Page>
        );
    }
    const status = versionState(model, version);
    return (
        <Page wide>
            <Crumbs items={[...crumbs, { label: `v${version.number}` }]} />
            <PageHeader
                title={versionName(version)}
                badge={
                    <Badge
                        variant={status.tone === "destructive" ? "outline" : status.tone}
                        className={cn(
                            status.tone === "destructive" &&
                                "border-destructive/40 text-destructive",
                        )}
                    >
                        {status.label}
                    </Badge>
                }
                caption={`${model.name} on ${model.base} · created ${shortAgo(version)}`}
                actions={
                    <>
                        <VersionPrimary model={model} version={version} />
                        <VersionMenu model={model} version={version} />
                    </>
                }
            />
            <div className="rounded-lg border bg-card p-panel">
                <ReportCard model={model} version={version} />
            </div>
        </Page>
    );
}
