import { InfoTip, cn } from "obp-ui";
import type { ReactNode } from "react";

export function FormRows({ children }: { children: ReactNode }) {
    return (
        <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-y-3">
            {children}
        </div>
    );
}

export function FormRow({
    id,
    label,
    detail,
    tip,
    align = "center",
    children,
}: {
    id?: string;
    label: string;
    detail?: ReactNode;
    tip?: ReactNode;
    align?: "center" | "start";
    children: ReactNode;
}) {
    return (
        <>
            <div
                className={cn(
                    "flex min-w-0 flex-col justify-center sm:min-h-8",
                    align === "start" ? "sm:self-start" : "sm:self-center",
                )}
            >
                <span className="flex items-center gap-1.5">
                    {id ? <label htmlFor={id}>{label}</label> : <span>{label}</span>}
                    {tip && <InfoTip label={`About ${label.toLowerCase()}`}>{tip}</InfoTip>}
                </span>
                {detail && <span className="truncate text-sm text-muted-foreground">{detail}</span>}
            </div>
            <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-2 pb-3 sm:pb-0">
                {children}
            </div>
        </>
    );
}
