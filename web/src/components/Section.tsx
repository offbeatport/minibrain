import type { LucideIcon } from "lucide-react";
import { cn } from "obp-ui";
import type { ReactNode } from "react";

export function Section({
    title,
    caption,
    actions,
    children,
}: {
    title: string;
    caption?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="rounded-lg border bg-card">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
                <div className="min-w-0">
                    <h2 className="text-base font-semibold">{title}</h2>
                    {caption && <p className="text-sm text-muted-foreground">{caption}</p>}
                </div>
                {actions && <div className="flex items-center gap-2">{actions}</div>}
            </header>
            <div className="p-4">{children}</div>
        </section>
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
        <section className="flex flex-col gap-2">
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
            {bare ? children : <div className="rounded-lg border bg-card p-4">{children}</div>}
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

export function ErrorLine({ error }: { error: unknown }) {
    if (!error) {
        return null;
    }
    return (
        <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : String(error)}
        </p>
    );
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
