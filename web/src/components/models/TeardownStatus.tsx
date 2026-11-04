import { Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import type { Teardown } from "~/lib/teardown";
import { ProgressBar, StatusText } from "./StatusText";

export function TeardownStatus({ teardown, name }: { teardown: Teardown; name: string }) {
    const failed = teardown.state === "failed";
    const deleting = teardown.kind === "delete";
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="flex items-center gap-2 rounded-sm text-left">
                    <StatusText tone={failed || deleting ? "destructive" : "info"}>
                        {teardown.label}
                    </StatusText>
                    {!failed && (
                        <ProgressBar
                            value={null}
                            label={`${name} ${teardown.label.toLowerCase()}`}
                            className="w-16"
                            tone={deleting ? "destructive" : "primary"}
                        />
                    )}
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm whitespace-normal">
                {teardown.detail}
            </TooltipContent>
        </Tooltip>
    );
}
