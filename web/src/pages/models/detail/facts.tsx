import { Link, Tooltip, TooltipContent, TooltipTrigger, cn } from "obp-ui";
import { type ReactNode, useRef, useState } from "react";
import { CopyButton } from "~/components/CopyButton";

export function parametersText(count: number): string {
    return count >= 1e9
        ? `${(count / 1e9).toFixed(1)}B`
        : `${Math.max(1, Math.round(count / 1e6))}M`;
}

function cut(element: HTMLElement | null): boolean {
    return (
        element !== null &&
        (element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight)
    );
}

export function useCutTooltip<T extends HTMLElement>() {
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
                    className={cn("min-w-0 truncate", href && "text-primary", className)}
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
            <TooltipContent className="max-w-xs whitespace-normal break-words">
                {text}
            </TooltipContent>
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
                <span ref={ref} className={cn("line-clamp-2 min-w-0 break-words", className)}>
                    {children}
                </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs whitespace-normal">{full}</TooltipContent>
        </Tooltip>
    );
}

export function Muted({ children }: { children: ReactNode }) {
    return <span className="min-w-0 truncate text-muted-foreground">{children}</span>;
}

export function Mono({ value, label }: { value: string; label: string }) {
    return (
        <>
            <Clipped text={value} className="font-mono text-sm" />
            <span className="-my-1 shrink-0">
                <CopyButton value={value} label={label} />
            </span>
        </>
    );
}

export function Fact({
    label,
    children,
    edit,
    wide = false,
}: {
    label: string;
    children: ReactNode;
    edit?: ReactNode;
    wide?: boolean;
}) {
    return (
        <div className={cn("group/row flex min-w-0 flex-col gap-0.5", wide && "col-span-full")}>
            <dt className="truncate text-sm text-muted-foreground">{label}</dt>
            <dd className="flex h-6 min-w-0 items-center gap-1 tabular-nums">
                {children}
                {edit && <span className="-my-1 shrink-0">{edit}</span>}
            </dd>
        </div>
    );
}

export function Row({
    label,
    children,
    edit,
}: {
    label: string;
    children: ReactNode;
    edit?: ReactNode;
}) {
    return (
        <div className="group/row flex min-h-7 items-center gap-3">
            <dt className="w-32 shrink-0 truncate text-sm text-muted-foreground">{label}</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-1 tabular-nums">
                {children}
                {edit}
            </dd>
        </div>
    );
}

export function Group({
    title,
    caption,
    children,
}: {
    title: string;
    caption?: string;
    children: ReactNode;
}) {
    return (
        <section className="grid gap-x-panel px-panel py-3 @xl:grid-cols-[8rem_minmax(0,1fr)]">
            <div className="flex flex-col">
                <h3 className="text-base leading-7 font-medium">{title}</h3>
                {caption && <p className="pb-1 text-sm text-muted-foreground">{caption}</p>}
            </div>
            <dl className="flex min-w-0 flex-col">{children}</dl>
        </section>
    );
}
