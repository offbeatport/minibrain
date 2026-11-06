import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleX, type LucideIcon, RotateCcw, X } from "lucide-react";
import {
    Button,
    type ToastOptions,
    Tooltip,
    TooltipContent,
    TooltipTrigger,
    cn,
    useToast,
} from "obp-ui";
import { type ReactNode, useState } from "react";
import { type JobInfo, api, unwrap } from "~/api/client";
import { isActiveJob } from "~/api/queries";
import type { components } from "~/api/schema";
import { useCan } from "~/lib/access";
import { plural } from "~/pages/data/catalogue";
import { ConfirmAction, type Confirmation } from "~/pages/models/dialogs";

type JobAction = "cancel" | "retry";
type JobActionResult = components["schemas"]["JobActionResult"];

const DONE: Record<JobAction, string> = { cancel: "Cancelled", retry: "Retried" };
const REFUSED: Record<JobAction, string> = {
    cancel: "had already finished",
    retry: "can no longer be retried",
};

export function canCancel(job: JobInfo): boolean {
    return isActiveJob(job) && !job.cancel_requested;
}

export function canRetry(job: JobInfo): boolean {
    return job.status === "failed" || job.status === "cancelled";
}

function send(action: JobAction, jobs: JobInfo[]): Promise<JobActionResult[]> {
    const request = { body: { ids: jobs.map((job) => job.id) } };
    return unwrap(
        action === "cancel"
            ? api.POST("/api/jobs/cancel", request)
            : api.POST("/api/jobs/retry", request),
    );
}

function count(results: JobActionResult[], test: (result: JobActionResult) => boolean): number {
    return results.filter(test).length;
}

export function actionSummary(action: JobAction, results: JobActionResult[]): ToastOptions {
    const done = count(results, (result) => result.done);
    const refused = count(results, (result) => !result.done && result.status !== null);
    const missing = count(results, (result) => !result.done && result.status === null);
    const stopping = count(results, (result) => result.done && result.status === "running");
    const parts = [
        done > 0
            ? `${DONE[action]} ${plural(done, "job")}`
            : `No job ${DONE[action].toLowerCase()}`,
        refused > 0 ? `${refused.toLocaleString()} ${REFUSED[action]}` : "",
        missing > 0
            ? `${missing.toLocaleString()} no longer ${missing === 1 ? "exists" : "exist"}`
            : "",
    ];
    return {
        title: parts.filter(Boolean).join("; "),
        description:
            stopping > 0
                ? `${plural(stopping, "running job")} ${stopping === 1 ? "shows" : "show"} Cancelling until the worker stops ${stopping === 1 ? "it" : "them"}.`
                : undefined,
        tone: done === results.length ? "success" : "warning",
    };
}

function cancelConfirmation(jobs: JobInfo[], run: () => Promise<unknown>): Confirmation {
    const running = jobs.filter((job) => job.status === "running").length;
    const queued = jobs.length - running;
    const parts = [
        running > 0 ? `${plural(running, "running job")} ${running === 1 ? "stops" : "stop"}` : "",
        queued > 0
            ? `${plural(queued, "queued job")} never ${queued === 1 ? "starts" : "start"}`
            : "",
    ].filter(Boolean);
    return {
        title: `Cancel ${plural(jobs.length, "job")}?`,
        description: <p>{`${parts.join("; ")}. Retry runs any of them again from the start.`}</p>,
        confirmLabel: `Cancel ${plural(jobs.length, "job")}`,
        destructive: true,
        run,
    };
}

function BulkButton({
    icon: Icon,
    label,
    jobs,
    none,
    pending,
    onClick,
}: {
    icon: LucideIcon;
    label: string;
    jobs: JobInfo[];
    none: string;
    pending?: boolean;
    onClick: () => void;
}) {
    if (jobs.length > 0) {
        return (
            <Button variant="outline" disabled={pending} onClick={onClick}>
                <Icon aria-hidden="true" />
                <span className="tabular-nums">{`${label} ${jobs.length.toLocaleString()}`}</span>
            </Button>
        );
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex">
                    <Button variant="outline" disabled>
                        <Icon aria-hidden="true" />
                        {label}
                    </Button>
                </span>
            </TooltipTrigger>
            <TooltipContent>{none}</TooltipContent>
        </Tooltip>
    );
}

function JobSelectionBar({
    jobs,
    onClear,
    className,
}: {
    jobs: JobInfo[];
    onClear: () => void;
    className?: string;
}) {
    const toast = useToast();
    const client = useQueryClient();
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const cancellable = jobs.filter(canCancel);
    const retriable = jobs.filter(canRetry);
    const run = async (action: JobAction, targets: JobInfo[]) => {
        const results = await send(action, targets);
        toast(actionSummary(action, results));
        onClear();
        await client.invalidateQueries();
    };
    const retry = useMutation({
        mutationFn: () => run("retry", retriable),
        onError: (error) =>
            toast({ title: "Retry failed", description: error.message, tone: "destructive" }),
    });
    return (
        <div className={cn("flex min-h-8 flex-wrap items-center gap-2", className)}>
            <span className="text-sm font-medium tabular-nums">{`${jobs.length.toLocaleString()} selected`}</span>
            <Button variant="outline" onClick={onClear}>
                <X />
                Clear selection
            </Button>
            <div className="ml-auto flex flex-wrap items-center gap-2">
                <BulkButton
                    icon={RotateCcw}
                    label="Retry"
                    jobs={retriable}
                    none="None of the selected jobs failed or were cancelled."
                    pending={retry.isPending}
                    onClick={() => retry.mutate()}
                />
                <BulkButton
                    icon={CircleX}
                    label="Cancel"
                    jobs={cancellable}
                    none="None of the selected jobs is queued or running."
                    onClick={() =>
                        setConfirmation(
                            cancelConfirmation(cancellable, () => run("cancel", cancellable)),
                        )
                    }
                />
            </div>
            <ConfirmAction
                confirmation={confirmation}
                onOpenChange={(open) => !open && setConfirmation(null)}
            />
        </div>
    );
}

export function useJobSelection(rows: JobInfo[], scope: string) {
    const can = useCan();
    const [selection, setSelection] = useState({ scope, ids: [] as string[] });
    const ids = can.build && selection.scope === scope ? selection.ids : [];
    const select = (next: string[]) => setSelection({ scope, ids: next });
    return {
        enabled: can.build,
        chosen: rows.filter((job) => ids.includes(String(job.id))),
        clear: () => select([]),
        grid: can.build ? { selectedIds: ids, onSelectedIdsChange: select } : {},
    };
}

export function JobToolbar({
    selection,
    children,
}: {
    selection: ReturnType<typeof useJobSelection>;
    children: ReactNode;
}) {
    const selecting = selection.chosen.length > 0;
    return (
        <div className="grid">
            <div
                className={cn(
                    "col-start-1 row-start-1 flex flex-wrap items-center gap-2",
                    selecting && "invisible",
                )}
            >
                {children}
            </div>
            {selection.enabled && (
                <JobSelectionBar
                    jobs={selection.chosen}
                    onClear={selection.clear}
                    className={cn("col-start-1 row-start-1", !selecting && "invisible")}
                />
            )}
        </div>
    );
}
