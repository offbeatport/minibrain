import { Badge } from "obp-ui";
import type { JobInfo } from "~/api/client";

type Variant = "success" | "info" | "approval" | "neutral" | "warning" | "destructive";

const VERSION_BADGE: Record<string, { variant: Variant; label: string }> = {
    training: { variant: "info", label: "Training" },
    evaluating: { variant: "info", label: "Scoring" },
    ready: { variant: "approval", label: "Awaiting promote" },
    failed: { variant: "destructive", label: "Failed" },
};

const JOB_BADGE: Record<string, { variant: Variant; label: string }> = {
    queued: { variant: "neutral", label: "Queued" },
    running: { variant: "info", label: "Running" },
    succeeded: { variant: "success", label: "Done" },
    failed: { variant: "destructive", label: "Failed" },
    cancelled: { variant: "neutral", label: "Cancelled" },
};

export const JOB_STATUSES = ["running", "queued", "succeeded", "failed", "cancelled"];

export const VERSION_STATES = ["live", "ready", "evaluating", "training", "failed"];

export function jobStatusLabel(status: string): string {
    return JOB_BADGE[status]?.label ?? status;
}

export function versionState(version: { status: string; live: boolean }): string {
    return version.live ? "live" : version.status;
}

export function versionStateLabel(state: string): string {
    return state === "live" ? "Live" : (VERSION_BADGE[state]?.label ?? state);
}

export function VersionState({ version }: { version: { status: string; live: boolean } }) {
    if (version.live) {
        return <Badge variant="success">Live</Badge>;
    }
    const badge = VERSION_BADGE[version.status] ?? { variant: "neutral", label: version.status };
    return <Badge variant={badge.variant}>{badge.label}</Badge>;
}

export function JobStatus({ job }: { job: JobInfo }) {
    if (job.status === "running" && job.cancel_requested) {
        return <Badge variant="warning">Cancelling</Badge>;
    }
    if (job.status === "queued" && job.attempt > 0) {
        return <Badge variant="warning">Retrying</Badge>;
    }
    const badge = JOB_BADGE[job.status] ?? { variant: "neutral", label: job.status };
    return <Badge variant={badge.variant}>{badge.label}</Badge>;
}
