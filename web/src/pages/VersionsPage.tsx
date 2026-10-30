import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type JobInfo, type VersionInfo, api, readLog, unwrap } from "~/api/client";
import { isActiveJob, keys, useJobs, useMinibrain, useVersions } from "~/api/queries";
import { type Column, DataTable, Truncated } from "~/components/DataTable";
import { ErrorLine, type LogKind, LogPanel, Page, Progress, Section } from "~/components/Section";
import { JobStatus, VersionStatus } from "~/components/StatusBadge";
import { count, errorText, milliseconds, percent } from "~/lib/format";
import { useSlug } from "./MinibrainLayout";

const LOG_POLL_MS = 2000;
const MAX_LOG_LINES = 300;

function useInvalidate(slug: string) {
    const queryClient = useQueryClient();
    return () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: ["minibrain", slug] }),
            queryClient.invalidateQueries({ queryKey: keys.minibrains }),
        ]);
}

function describeLine(raw: string): { text: string; kind: LogKind } {
    try {
        const entry = JSON.parse(raw) as Record<string, unknown>;
        if (typeof entry.step === "number") {
            const loss = typeof entry.loss === "number" ? ` · loss ${entry.loss.toFixed(3)}` : "";
            return { text: `step ${entry.step}/${entry.steps}${loss}`, kind: "info" };
        }
        if (typeof entry.evaluated === "number") {
            return { text: `scored ${entry.evaluated}/${entry.of}`, kind: "info" };
        }
        return { text: raw, kind: "ok" };
    } catch {
        const kind = /error|traceback/i.test(raw) ? "error" : /warn/i.test(raw) ? "warn" : "plain";
        return { text: raw, kind };
    }
}

function useJobLog(job: JobInfo): string[] {
    const [lines, setLines] = useState<string[]>([]);
    const active = isActiveJob(job);
    useEffect(() => {
        let offset = 0;
        let pending = "";
        let stopped = false;
        const pull = async () => {
            const chunk = await readLog(job.id, offset);
            if (stopped || chunk.text === "") {
                return;
            }
            offset = chunk.offset;
            const parts = (pending + chunk.text).split("\n");
            pending = parts.pop() ?? "";
            setLines((previous) => [...previous, ...parts.filter(Boolean)].slice(-MAX_LOG_LINES));
        };
        pull();
        const timer = active ? window.setInterval(pull, LOG_POLL_MS) : undefined;
        return () => {
            stopped = true;
            window.clearInterval(timer);
        };
    }, [job.id, active]);
    return lines;
}

function JobPanel({ job, slug }: { job: JobInfo; slug: string }) {
    const lines = useJobLog(job);
    const invalidate = useInvalidate(slug);
    const cancel = useMutation({
        mutationFn: () =>
            unwrap(api.POST("/api/jobs/{job_id}/cancel", { params: { path: { job_id: job.id } } })),
        onSuccess: invalidate,
    });
    const label = job.kind === "train" ? "Training" : "Scoring";
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3 text-sm">
                    <span className="font-medium">
                        {label} v{job.version}
                    </span>
                    <JobStatus job={job} />
                    <span className="tabular-nums text-muted-foreground">
                        {percent(job.progress)}
                    </span>
                </div>
                {isActiveJob(job) && (
                    <Button variant="outline" size="sm" onClick={() => cancel.mutate()}>
                        Cancel
                    </Button>
                )}
            </div>
            <Progress value={job.progress} />
            {job.error && <p className="text-sm text-destructive">{job.error}</p>}
            <LogPanel lines={lines.map(describeLine)} empty="Waiting for output…" />
            <ErrorLine error={cancel.error} />
        </div>
    );
}

function CreateVersion({ slug }: { slug: string }) {
    const invalidate = useInvalidate(slug);
    const [maxRows, setMaxRows] = useState("3000");
    const [epochs, setEpochs] = useState("1");
    const create = useMutation({
        mutationFn: (body: { kind: "prompt" | "lora"; max_rows?: number; epochs?: number }) =>
            unwrap(
                api.POST("/api/minibrains/{slug}/versions", { params: { path: { slug } }, body }),
            ),
        onSuccess: invalidate,
    });
    const train = () =>
        create.mutate({ kind: "lora", max_rows: Number(maxRows), epochs: Number(epochs) });
    return (
        <Section
            title="New version"
            caption="Score the base model with a prompt first. Train when the score shows a gap worth closing."
        >
            <div className="flex flex-wrap items-end gap-8">
                <Button variant="outline" onClick={() => create.mutate({ kind: "prompt" })}>
                    Score prompt-only version
                </Button>
                <div className="flex flex-wrap items-end gap-3">
                    <div className="w-32">
                        <Input
                            label="Training rows"
                            inputMode="numeric"
                            value={maxRows}
                            onChange={setMaxRows}
                        />
                    </div>
                    <div className="w-24">
                        <Input
                            label="Epochs"
                            inputMode="decimal"
                            value={epochs}
                            onChange={setEpochs}
                        />
                    </div>
                    <Button onClick={train} disabled={create.isPending}>
                        Train new version
                    </Button>
                </div>
            </div>
            <ErrorLine error={create.error} />
        </Section>
    );
}

function PromoteButton({ slug, version }: { slug: string; version: VersionInfo }) {
    const invalidate = useInvalidate(slug);
    const [blocked, setBlocked] = useState<string | null>(null);
    const promote = useMutation({
        mutationFn: (override: boolean) =>
            unwrap(
                api.POST("/api/minibrains/{slug}/versions/{number}/promote", {
                    params: { path: { slug, number: version.number } },
                    body: { override },
                }),
            ),
        onSuccess: () => {
            setBlocked(null);
            return invalidate();
        },
        onError: (error) => setBlocked(errorText(error)),
    });
    if (version.current || version.status !== "ready") {
        return null;
    }
    if (blocked?.includes("scores below")) {
        return (
            <Button
                variant="outline"
                size="sm"
                title={blocked}
                onClick={() => promote.mutate(true)}
            >
                Promote anyway
            </Button>
        );
    }
    return (
        <Button size="sm" title={blocked ?? undefined} onClick={() => promote.mutate(false)}>
            Promote
        </Button>
    );
}

function versionColumns(slug: string, onSelect: (number: number) => void): Column<VersionInfo>[] {
    return [
        {
            key: "number",
            header: "Version",
            width: "90px",
            cell: (row) => (
                <button
                    type="button"
                    className="font-mono text-primary"
                    onClick={() => onSelect(row.number)}
                >
                    v{row.number}
                </button>
            ),
        },
        {
            key: "kind",
            header: "Kind",
            width: "120px",
            cell: (row) => (row.kind === "lora" ? "Trained" : "Prompt-only"),
        },
        {
            key: "status",
            header: "Status",
            width: "190px",
            cell: (row) => <VersionStatus version={row} />,
        },
        {
            key: "golden",
            header: "Test set",
            align: "right",
            cell: (row) => percent(row.golden?.accuracy),
        },
        {
            key: "held",
            header: "Held-out",
            align: "right",
            cell: (row) => percent(row.held_out?.accuracy),
        },
        {
            key: "f1",
            header: "Macro F1",
            align: "right",
            cell: (row) => row.held_out?.macro_f1.toFixed(3) ?? "–",
        },
        {
            key: "invalid",
            header: "Invalid",
            align: "right",
            cell: (row) => percent(row.held_out?.invalid_rate),
        },
        {
            key: "p50",
            header: "p50",
            align: "right",
            cell: (row) => milliseconds(row.latency_p50_ms),
        },
        {
            key: "tokens",
            header: "Prompt tokens",
            align: "right",
            cell: (row) => count(row.prompt_tokens),
        },
        {
            key: "promote",
            header: "",
            width: "150px",
            align: "right",
            cell: (row) => <PromoteButton slug={slug} version={row} />,
        },
    ];
}

type Mistake = VersionInfo["mistakes"][number];

const MISTAKE_COLUMNS: Column<Mistake>[] = [
    { key: "input", header: "Input", cell: (row) => <Truncated text={row.input} /> },
    {
        key: "gold",
        header: "Expected",
        width: "260px",
        cell: (row) => <span className="font-mono">{row.gold}</span>,
    },
    {
        key: "output",
        header: "Got",
        width: "260px",
        cell: (row) => <span className="font-mono text-destructive">{row.output}</span>,
    },
];

export function VersionsPage() {
    const slug = useSlug();
    const { data: detail } = useMinibrain(slug);
    const { data: versions } = useVersions(slug);
    const { data: jobs } = useJobs(slug);
    const [selected, setSelected] = useState<number | null>(null);
    const active = (jobs ?? []).filter(isActiveJob);
    const recent = (jobs ?? []).filter((job) => !isActiveJob(job)).slice(0, 1);
    const shown = versions?.find((version) => version.number === selected) ?? versions?.[0];
    if (!detail) {
        return null;
    }
    if (!detail.snapshot) {
        return (
            <Page>
                <p className="text-sm text-muted-foreground">
                    Build the dataset on the Data tab first.
                </p>
            </Page>
        );
    }
    return (
        <Page>
            <CreateVersion slug={slug} />
            {(active.length > 0 || recent.length > 0) && (
                <Section title="Jobs" caption="One job runs at a time; the rest wait in the queue.">
                    <div className="flex flex-col gap-6">
                        {[...active, ...recent].map((job) => (
                            <JobPanel key={job.id} job={job} slug={slug} />
                        ))}
                    </div>
                </Section>
            )}
            <Section
                title="Versions"
                caption="Every version is scored on the same test set and held-out rows. Promotion is blocked when a version scores below the current one on held-out rows."
            >
                <DataTable
                    columns={versionColumns(slug, setSelected)}
                    rows={versions ?? []}
                    empty="No versions yet."
                    rowHeight={52}
                />
            </Section>
            {shown && shown.mistakes.length > 0 && (
                <Section
                    title={`Mistakes in v${shown.number}`}
                    caption="Up to 20 held-out rows it got wrong."
                >
                    <DataTable columns={MISTAKE_COLUMNS} rows={shown.mistakes} />
                </Section>
            )}
        </Page>
    );
}
