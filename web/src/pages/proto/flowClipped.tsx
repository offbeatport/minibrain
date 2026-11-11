import { Link, Tooltip, TooltipContent, TooltipTrigger } from "obp-ui";
import { type ReactNode, useRef, useState } from "react";

function cut(element: HTMLElement | null): boolean {
    return (
        element !== null &&
        (element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight)
    );
}

function useCutTooltip<T extends HTMLElement>() {
    const ref = useRef<T>(null);
    const [open, setOpen] = useState(false);
    return {
        ref,
        open,
        onOpenChange: (next: boolean) => setOpen(next && cut(ref.current)),
    };
}

export function Clipped({
    text,
    className,
    href,
}: {
    text: string;
    className?: string;
    href?: string;
}) {
    const { ref, open, onOpenChange } = useCutTooltip<HTMLSpanElement>();
    return (
        <Tooltip open={open} onOpenChange={onOpenChange}>
            <TooltipTrigger asChild>
                <span
                    ref={ref}
                    className={`min-w-0 truncate ${href ? "text-primary" : ""} ${className ?? ""}`}
                >
                    {href ? (
                        <Link href={href} className="hover:underline">
                            {text}
                        </Link>
                    ) : (
                        text
                    )}
                </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{text}</TooltipContent>
        </Tooltip>
    );
}

export function TwoLines({
    children,
    full,
    className,
}: {
    children: ReactNode;
    full: string;
    className?: string;
}) {
    const { ref, open, onOpenChange } = useCutTooltip<HTMLSpanElement>();
    return (
        <Tooltip open={open} onOpenChange={onOpenChange}>
            <TooltipTrigger asChild>
                <span ref={ref} className={`line-clamp-2 min-w-0 break-words ${className ?? ""}`}>
                    {children}
                </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{full}</TooltipContent>
        </Tooltip>
    );
}
