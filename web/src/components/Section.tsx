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

export function Page({ children }: { children: ReactNode }) {
    return <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 py-5">{children}</div>;
}
