import { Link, Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import type { ModelRow } from "~/api/client";
import { StatusText, type Tone } from "~/components/models/StatusText";
import { deploymentPageHref, modelPageHref } from "~/lib/modelLinks";
import { exactTime, relativeTime } from "~/lib/time";

const DEPLOYMENT_TONES: Record<string, Tone> = {
    running: "success",
    starting: "info",
    unhealthy: "destructive",
    stopping: "info",
    stop_failed: "destructive",
};

const DEPLOYMENT_STATES: Record<string, string> = {
    running: "Live",
    starting: "Starting",
    unhealthy: "Unhealthy",
    stopping: "Stopping",
    stop_failed: "Stop failed",
};

export function Deployment({ row, short = false }: { row: ModelRow; short?: boolean }) {
    const { state } = row.deployment;
    const label = short ? (DEPLOYMENT_STATES[state] ?? row.deployment.label) : row.deployment.label;
    if (state === "not_deployed") {
        return <span className="text-muted-foreground">{label}</span>;
    }
    const href =
        row.kind === "custom" ? deploymentPageHref(row.key) : modelPageHref(row.key, "api");
    return (
        <Link href={href} className="hover:underline">
            <StatusText tone={DEPLOYMENT_TONES[state] ?? "neutral"}>{label}</StatusText>
        </Link>
    );
}

export function Updated({ value }: { value: string }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className="whitespace-nowrap rounded-sm tabular-nums text-muted-foreground"
                >
                    <time dateTime={value}>{relativeTime(value)}</time>
                </button>
            </TooltipTrigger>
            <TooltipContent>{exactTime(value)}</TooltipContent>
        </Tooltip>
    );
}
