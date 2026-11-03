import { Check, Copy } from "lucide-react";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import { useState } from "react";

type CopyState = "idle" | "copied" | "failed";

const MESSAGES: Record<CopyState, string | null> = {
    idle: null,
    copied: "Copied",
    failed: "This browser blocks copying here",
};

export function CopyButton({ value, label }: { value: string; label: string }) {
    const [state, setState] = useState<CopyState>("idle");
    const copy = () => {
        if (!navigator.clipboard) {
            setState("failed");
            return;
        }
        navigator.clipboard.writeText(value).then(
            () => setState("copied"),
            () => setState("failed"),
        );
    };
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={label}
                    onClick={copy}
                    onPointerLeave={() => setState("idle")}
                    onBlur={() => setState("idle")}
                >
                    {state === "copied" ? <Check /> : <Copy />}
                </Button>
            </TooltipTrigger>
            <TooltipContent>{MESSAGES[state] ?? label}</TooltipContent>
        </Tooltip>
    );
}
