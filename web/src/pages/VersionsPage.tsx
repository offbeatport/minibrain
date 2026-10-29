import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Button, Input, Label } from "obp-ui";
import { type LogLineData, LogView } from "obp-ui/console";
import { useEffect, useState } from "react";
import { type JobInfo, type VersionInfo, api, readLog, unwrap } from "~/api/client";
import { isActiveJob, keys, useJobs, useMinibrain, useVersions } from "~/api/queries";
import { DataTable } from "~/components/DataTable";
import { ErrorLine, Page, Section } from "~/components/Section";
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

function describeLine(raw: string): LogLineData {
    try {
        const entry = JSON.parse(raw) as Record<string, unknown>;
        if (typeof entry.step === "number") {
            const loss = typeof entry.loss === "number" ? ` · loss ${entry.loss.toFixed(3)}` : "";
            return { msg: `step ${entry.step}/${entry.steps}${loss}`, kind: "info" };
        }
        if (typeof entry.evaluated === "number") {
            return { msg: `scored ${entry.evaluated}/${entry.of}`, kind: "info" };
        }
        return { msg: raw, kind: "ok" };
    } catch {
        const kind = /error|traceback/i.test(raw) ? "error" : /warn/i.test(raw) ? "warn" : "msg";
        return { msg: raw, kind };
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
        <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm">
                    <span className="font-semibold">
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
            <div className="h-1 overflow-hidden bg-secondary">
                <div
                    className="h-full bg-primary"
                    style={{ width: `${Math.round(job.progress * 100)}%` }}
                />
            </div>
            {job.error && <p className="text-sm text-destructive">{job.error}</p>}
            <LogView
                lines={lines.map(describeLine)}
                className="max-h-64"
                empty="Waiting for output…"
            />
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
            <div className="flex flex-wrap items-end gap-6">
                <Button variant="outline" onClick={() => create.mutate({ kind: "prompt" })}>
                    Score prompt-only version
                </Button>
                <div className="flex flex-wrap items-end gap-2">
                    <div className="flex flex-col gap-1">
                        <Label htmlFor="max-rows">Training rows</Label>
                        <Input
                            id="max-rows"
                            className="w-28 tabular-nums"
                            inputMode="numeric"
                            value={maxRows}
                            onChange={(event) => setMaxRows(event.target.value)}
                        />
                    </div>
                    <div className="flex flex-col gap-1">
                        <Label htmlFor="epochs">Epochs</Label>
                        <Input
                            id="epochs"
                            className="w-20 tabular-nums"
                            inputMode="decimal"
                            value={epochs}
                            onChange={(event) => setEpochs(event.target.value)}
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
    if (blocked) {
        return (
            <div className="flex flex-col items-start gap-1">
                <span className="max-w-56 text-sm text-warning">{blocked}</span>
                {blocked.includes("scores below") && (
                    <Button variant="outline" size="xs" onClick={() => promote.mutate(true)}>
                        Promote anyway
                    </Button>
                )}
            </div>
        );
    }
    return (
        <Button size="xs" onClick={() => promote.mutate(false)}>
            Promote
        </Button>
    );
}

function versionColumns(
    slug: string,
    onSelect: (number: number) => void,
): ColumnDef<VersionInfo, unknown>[] {
    return [
        {
            header: "Version",
            id: "version",
            cell: ({ row }) => (
                <button
                    type="button"
                    className="font-mono text-primary"
                    onClick={() => onSelect(row.original.number)}
                >
                    v{row.original.number}
                </button>
            ),
        },
        {
            header: "Kind",
            id: "kind",
            cell: ({ row }) => (row.original.kind === "lora" ? "Trained" : "Prompt-only"),
        },
        {
            header: "Status",
            id: "status",
            cell: ({ row }) => <VersionStatus version={row.original} />,
        },
        {
            header: "Test set",
            id: "golden",
            cell: ({ row }) => percent(row.original.golden?.accuracy),
        },
        {
            header: "Held-out",
            id: "held",
            cell: ({ row }) => percent(row.original.held_out?.accuracy),
        },
        {
            header: "Macro F1",
            id: "f1",
            cell: ({ row }) => row.original.held_out?.macro_f1.toFixed(3) ?? "–",
        },
        {
            header: "Invalid",
            id: "invalid",
            cell: ({ row }) => percent(row.original.held_out?.invalid_rate),
        },
        { header: "p50", id: "p50", cell: ({ row }) => milliseconds(row.original.latency_p50_ms) },
        {
            header: "Prompt tokens",
            id: "tokens",
            cell: ({ row }) => count(row.original.prompt_tokens),
        },
        {
            header: "",
            id: "promote",
            cell: ({ row }) => <PromoteButton slug={slug} version={row.original} />,
        },
    ];
}

type Mistake = VersionInfo["mistakes"][number];

const MISTAKE_COLUMNS: ColumnDef<Mistake, unknown>[] = [
    { header: "Input", accessorKey: "input" },
    {
        header: "Expected",
        accessorKey: "gold",
        cell: (info) => <span className="font-mono">{String(info.getValue())}</span>,
    },
    {
        header: "Got",
        accessorKey: "output",
        cell: (info) => (
            <span className="font-mono text-destructive">{String(info.getValue())}</span>
        ),
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
                    <div className="flex flex-col gap-3">
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
