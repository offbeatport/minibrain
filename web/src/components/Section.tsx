import type { LucideIcon } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle, cn } from "obp-ui";
import type { ReactNode } from "react";

const FLUSH_GRID =
    "px-0 [--data-grid-surface:var(--card)] [&_[data-slot=data-grid]]:rounded-none [&_[data-slot=data-grid]]:border-0";

const CARD_GRID =
    "[--data-grid-surface:var(--card)] [&_[data-slot=data-grid]]:rounded-xl [&_[data-slot=data-grid]]:bg-card";

export function Section({
    title,
    caption,
    actions,
    flush = false,
    children,
}: {
    title: string;
    caption?: ReactNode;
    actions?: ReactNode;
    flush?: boolean;
    children: ReactNode;
}) {
    return (
        <Card className={cn(flush && "gap-0 overflow-clip pb-0")}>
            <CardHeader className={cn(flush && "border-b")}>
                <CardTitle>
                    <h2>{title}</h2>
                </CardTitle>
                {caption && <CardDescription>{caption}</CardDescription>}
                {actions && <CardAction className="flex items-center gap-2">{actions}</CardAction>}
            </CardHeader>
            <CardContent className={cn(flush && FLUSH_GRID)}>{children}</CardContent>
        </Card>
    );
}

export function PanelSection({
    icon: Icon,
    title,
    description,
    actions,
    bare = false,
    children,
}: {
    icon: LucideIcon;
    title: string;
    description?: ReactNode;
    actions?: ReactNode;
    bare?: boolean;
    children: ReactNode;
}) {
    return (
        <section className={cn("flex flex-col gap-2", bare && CARD_GRID)}>
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 className="flex items-center gap-2 text-lg font-semibold">
                        <Icon
                            aria-hidden="true"
                            className="size-5 shrink-0 text-muted-foreground"
                        />
                        {title}
                    </h2>
                    {description && (
                        <p className="pl-7 text-sm text-muted-foreground">{description}</p>
                    )}
                </div>
                {actions && <div className="flex items-center gap-2">{actions}</div>}
            </header>
            {bare ? (
                children
            ) : (
                <Card>
                    <CardContent>{children}</CardContent>
                </Card>
            )}
        </section>
    );
}

export function PanelSections({ children }: { children: ReactNode }) {
    return <div className="flex flex-col gap-8 pt-2">{children}</div>;
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="min-w-24">
            <div className="text-sm text-muted-foreground">{label}</div>
            <div className="text-base font-semibold tabular-nums">{value}</div>
        </div>
    );
}

export function errorMessage(error: unknown): string | undefined {
    if (!error) {
        return undefined;
    }
    return error instanceof Error ? error.message : String(error);
}

export function ErrorLine({ error }: { error: unknown }) {
    const message = errorMessage(error);
    if (!message) {
        return null;
    }
    return <p className="text-sm text-destructive">{message}</p>;
}

export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
    return (
        <div
            className={cn(
                "mx-auto flex w-full flex-col gap-4 px-6 pt-8 pb-6",
                wide ? "max-w-[96rem]" : "max-w-6xl",
            )}
        >
            {children}
        </div>
    );
}
