import { Button, Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import type { ComponentProps, ReactNode } from "react";

export function BlockedButton({
    reason,
    variant,
    size,
    children,
}: {
    reason: string;
    variant?: ComponentProps<typeof Button>["variant"];
    size?: ComponentProps<typeof Button>["size"];
    children: ReactNode;
}) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex">
                    <Button variant={variant} size={size} disabled>
                        {children}
                    </Button>
                </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{reason}</TooltipContent>
        </Tooltip>
    );
}
