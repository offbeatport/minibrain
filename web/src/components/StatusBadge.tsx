import { AnimatedBadge, type AnimatedBadgeStatus } from "@/components/motion/animated-badge";
import type { JobInfo, VersionInfo } from "~/api/client";

type BadgeSpec = { status: AnimatedBadgeStatus; label: string };

const VERSION_BADGE: Record<string, BadgeSpec> = {
    training: { status: "loading", label: "Training" },
    evaluating: { status: "loading", label: "Scoring" },
    ready: { status: "info", label: "Awaiting promote" },
    failed: { status: "danger", label: "Failed" },
};

const JOB_BADGE: Record<string, BadgeSpec> = {
    queued: { status: "neutral", label: "Queued" },
    running: { status: "loading", label: "Running" },
    cancelling: { status: "warning", label: "Cancelling" },
    done: { status: "success", label: "Done" },
    failed: { status: "danger", label: "Failed" },
    cancelled: { status: "neutral", label: "Cancelled" },
};

function Badge({ spec }: { spec: BadgeSpec }) {
    return (
        <AnimatedBadge status={spec.status} size="sm" contentKey={spec.label}>
            {spec.label}
        </AnimatedBadge>
    );
}

export function VersionStatus({ version }: { version: VersionInfo }) {
    if (version.current) {
        return <Badge spec={{ status: "success", label: "Current" }} />;
    }
    return (
        <Badge
            spec={VERSION_BADGE[version.status] ?? { status: "neutral", label: version.status }}
        />
    );
}

export function JobStatus({ job }: { job: JobInfo }) {
    return <Badge spec={JOB_BADGE[job.status] ?? { status: "neutral", label: job.status }} />;
}
