import { Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import type { components } from "~/api/schema";
import { StatusText, type Tone } from "./StatusText";

export type Health = components["schemas"]["Health"];
export type HealthAction = components["schemas"]["HealthAction"];
export type FileState = NonNullable<components["schemas"]["ModelFile"]["state"]>;

export const FILE_STATES: Record<FileState, { label: string; tone: Tone }> = {
    ok: { label: "Matches", tone: "success" },
    corrupt: { label: "Corrupt", tone: "destructive" },
    missing: { label: "Missing", tone: "destructive" },
    wrong_size: { label: "Wrong size", tone: "destructive" },
    unchecked: { label: "Not checked", tone: "neutral" },
};

export function HealthStatus({ health }: { health: Health }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="rounded-sm text-left">
                    <StatusText tone="destructive">{health.label}</StatusText>
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-normal">{health.detail}</TooltipContent>
        </Tooltip>
    );
}
