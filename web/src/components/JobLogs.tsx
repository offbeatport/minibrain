import { Logs } from "lucide-react";
import { LogViewer } from "obp-ui";
import type { JobInfo } from "~/api/client";
import { isActiveJob } from "~/api/queries";
import { useJobEvents } from "~/lib/jobs";
import { PanelSection } from "./Section";

export function JobLogsSection({ job, anchor }: { job: JobInfo; anchor?: string }) {
    const entries = useJobEvents(job.id);
    return (
        <PanelSection
            icon={Logs}
            anchor={anchor}
            title="Logs"
            tip={`What job #${job.id} printed, newest at the bottom.`}
            bare
        >
            <LogViewer
                entries={entries}
                live={isActiveJob(job)}
                quietSource="library"
                quietLabel="Show library output"
                fileName={`job-${job.id}.log`}
                label={`Log of job ${job.id}`}
                empty={isActiveJob(job) ? "Waiting for output." : "No output recorded."}
                maxHeight="28rem"
            />
        </PanelSection>
    );
}
