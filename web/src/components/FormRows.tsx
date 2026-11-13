import { InfoTip, cn } from "obp-ui";
import { type ReactNode, useId } from "react";

export const FORM_ROW_GAP = "gap-y-6";
export const FORM_GROUP_GAP = "gap-10";
const ROWS_GAP = "gap-y-label sm:gap-y-6";
const STACKED_ROW_END = "pb-4 sm:pb-0";
const GROUP_RULE = "border-t pt-10 first:border-t-0 first:pt-0";

type LabelWidth = "wide" | "narrow";

const COLUMNS: Record<LabelWidth, string> = {
    wide: "sm:grid-cols-[12rem_minmax(0,1fr)]",
    narrow: "sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-x-4",
};

export function FormRows({
    labels = "wide",
    children,
}: {
    labels?: LabelWidth;
    children: ReactNode;
}) {
    return (
        <div className={cn("grid grid-cols-1 gap-x-6", ROWS_GAP, COLUMNS[labels])}>{children}</div>
    );
}

export function FormGroup({ title, children }: { title?: string; children: ReactNode }) {
    const id = useId();
    return (
        <section
            aria-labelledby={title ? id : undefined}
            className={cn("flex flex-col gap-4", GROUP_RULE)}
        >
            {title && (
                <h3 id={id} className="font-medium">
                    {title}
                </h3>
            )}
            <FormRows labels="narrow">{children}</FormRows>
        </section>
    );
}

const CONTROL_WIDTHS = {
    select: "sm:max-w-sm",
    text: "sm:max-w-sm",
    short: "sm:max-w-64",
    wide: "sm:max-w-lg",
    full: "",
} as const;

export function FormControl({
    width = "select",
    children,
}: {
    width?: keyof typeof CONTROL_WIDTHS;
    children: ReactNode;
}) {
    return (
        <div className={cn("flex w-full flex-col gap-1.5", CONTROL_WIDTHS[width])}>{children}</div>
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
            <div
                className={cn("flex min-h-8 min-w-0 flex-wrap items-center gap-2", STACKED_ROW_END)}
            >
                {children}
            </div>
        </>
    );
}
