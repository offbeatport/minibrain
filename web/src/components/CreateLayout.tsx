import { type LucideIcon, X } from "lucide-react";
import { Button, Card, cn } from "obp-ui";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { FORM_GROUP_GAP } from "./FormRows";

export function CreateLayout({
    form,
    summary,
    summaryLabel = "Summary",
    submit,
    disabled,
    status,
    problem = false,
    onSubmit,
    onCancel,
    onKeyDown,
}: {
    form: ReactNode;
    summary: ReactNode;
    summaryLabel?: string;
    submit: ReactNode;
    disabled: boolean;
    status: ReactNode;
    problem?: boolean;
    onSubmit: () => void;
    onCancel: () => void;
    onKeyDown?: (event: KeyboardEvent<HTMLFormElement>) => void;
}) {
    const send = (event: FormEvent) => {
        event.preventDefault();
        onSubmit();
    };
    const actions = (statusClass?: string) => (
        <>
            <p
                aria-live="polite"
                className={cn(
                    "min-w-0 flex-1 truncate tabular-nums",
                    problem ? "text-destructive" : "text-muted-foreground",
                    statusClass,
                )}
            >
                {status}
            </p>
            <Button type="button" variant="outline" className="ml-auto" onClick={onCancel}>
                <X aria-hidden="true" />
                Cancel
            </Button>
            <Button type="submit" disabled={disabled}>
                {submit}
            </Button>
        </>
    );
    return (
        <form noValidate className="@container" onSubmit={send} onKeyDown={onKeyDown}>
            <div className="grid gap-6 @3xl:grid-cols-[minmax(0,1fr)_20rem]">
                <div className="flex min-w-0 flex-col gap-6 [&>:last-child]:flex-1">{form}</div>
                <aside aria-label={summaryLabel} className="flex min-w-0 flex-col [&>*]:flex-1">
                    {summary}
                </aside>
            </div>
            <div className="mt-6 hidden items-center gap-3 border-t pt-4 @3xl:flex">
                {actions()}
            </div>
            <div
                className={cn(
                    "sticky bottom-0 z-10 -mx-6 -mb-6 mt-6 flex items-center gap-3 border-t bg-background px-6 pt-3",
                    "pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] @3xl:hidden",
                )}
            >
                {actions("@max-md:sr-only")}
            </div>
        </form>
    );
}

export function FormCard({ children }: { children: ReactNode }) {
    return <Card className={cn("p-panel", FORM_GROUP_GAP)}>{children}</Card>;
}

export function SummaryCard({ children }: { children: ReactNode }) {
    return <Card className="gap-0 divide-y py-0">{children}</Card>;
}

export function SummarySection({
    title,
    info,
    children,
}: {
    title: string;
    info?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="flex flex-col gap-2.5 px-panel py-4">
            <h3 className="flex items-center gap-1.5 font-medium">
                {title}
                {info}
            </h3>
            {children}
        </section>
    );
}

export function SummaryIcon({ icon: Icon }: { icon: LucideIcon }) {
    return (
        <span aria-hidden="true" className="flex h-lh shrink-0 items-center">
            <Icon className="size-4 text-muted-foreground" />
        </span>
    );
}

export function SummaryLine({
    icon,
    className,
    children,
}: {
    icon: LucideIcon;
    className?: string;
    children: ReactNode;
}) {
    return (
        <span className={cn("flex min-w-0 items-start gap-2", className)}>
            <SummaryIcon icon={icon} />
            <span className="min-w-0">{children}</span>
        </span>
    );
}

export function SummaryFacts({ children }: { children: ReactNode }) {
    return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">{children}</dl>;
}

export function SummaryFact({
    icon,
    label,
    children,
}: {
    icon?: LucideIcon;
    label: string;
    children: ReactNode;
}) {
    return (
        <div className="contents">
            <dt className="flex items-start gap-2 text-muted-foreground">
                {icon && <SummaryIcon icon={icon} />}
                {label}
            </dt>
            <dd className="min-w-0 text-right tabular-nums">{children}</dd>
        </div>
    );
}

export function BlockedReasons({ reasons }: { reasons: string[] }) {
    if (reasons.length === 0) {
        return null;
    }
    return (
        <ul role="alert" className="flex flex-col gap-1.5 px-panel py-4 text-destructive">
            {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
            ))}
        </ul>
    );
}
