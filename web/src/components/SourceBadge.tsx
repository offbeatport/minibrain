import { Badge, Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";

const SOURCE_LABEL: Record<string, string> = {
    "config file": "Set by config file",
    environment: "Set by environment",
    "built in": "Always on",
};

const SOURCE_DETAIL: Record<string, string> = {
    "config file": "Set in the server's minibrain.yaml, so it can only be changed there.",
    environment: "Set by an environment variable on the server, so it can only be changed there.",
};

export function SourceBadge({ source }: { source: string }) {
    const badge = (
        <Badge variant="neutral" className="w-fit">
            {SOURCE_LABEL[source] ?? source}
        </Badge>
    );
    const detail = SOURCE_DETAIL[source];
    if (!detail) {
        return badge;
    }
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button type="button" className="w-fit rounded-sm">
                    {badge}
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{detail}</TooltipContent>
        </Tooltip>
    );
}
