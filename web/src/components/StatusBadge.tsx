import { Badge } from "obp-ui";
import type { JobInfo, VersionInfo } from "~/api/client";

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
    cancelling: { variant: "warning", label: "Cancelling" },
    done: { variant: "success", label: "Done" },
    failed: { variant: "destructive", label: "Failed" },
    cancelled: { variant: "neutral", label: "Cancelled" },
};

export function VersionStatus({ version }: { version: VersionInfo }) {
    if (version.current) {
        return <Badge variant="success">Current</Badge>;
    }
    const badge = VERSION_BADGE[version.status] ?? { variant: "neutral", label: version.status };
    return <Badge variant={badge.variant}>{badge.label}</Badge>;
}

export function JobStatus({ job }: { job: JobInfo }) {
    const badge = JOB_BADGE[job.status] ?? { variant: "neutral", label: job.status };
    return <Badge variant={badge.variant}>{badge.label}</Badge>;
}
