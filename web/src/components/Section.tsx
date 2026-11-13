import type { LucideIcon } from "lucide-react";
import {
    Card,
    CardAction,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    InfoTip,
    cn,
} from "obp-ui";
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

const FLASH =
    "relative isolate before:pointer-events-none before:absolute before:-inset-x-2.5 before:-inset-y-1 before:-z-10 before:rounded-md before:bg-highlight before:opacity-0 before:transition-opacity before:duration-150 group-data-flash/panel:before:opacity-100 motion-reduce:before:transition-none";

export function PanelSection({
    icon: Icon,
    anchor,
    title,
    description,
    tip,
    actions,
    bare = false,
    flush = false,
    children,
}: {
    icon: LucideIcon;
    anchor?: string;
    title: string;
    description?: ReactNode;
    tip?: ReactNode;
    actions?: ReactNode;
    bare?: boolean;
    flush?: boolean;
    children: ReactNode;
}) {
    return (
        <section
            id={anchor}
            className={cn("group/panel flex scroll-my-24 flex-col gap-4", bare && CARD_GRID)}
        >
            <header className={cn("flex flex-wrap items-end justify-between gap-3", FLASH)}>
                <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 className="flex items-center gap-2 text-lg font-semibold">
                        <Icon
                            aria-hidden="true"
                            className="size-5 shrink-0 text-muted-foreground"
                        />
                        {title}
                        {tip && (
                            <InfoTip label={`About ${title.toLowerCase()}`} side="right">
                                {tip}
                            </InfoTip>
                        )}
                    </h2>
                    {description && (
                        <p className="pl-7 text-sm text-muted-foreground">{description}</p>
                    )}
                </div>
                {actions && <div className="flex items-center gap-2">{actions}</div>}
            </header>
            {bare ? (
                children
            ) : flush ? (
                <Card className="gap-0 overflow-clip py-0">{children}</Card>
            ) : (
                <Card>
                    <CardContent>{children}</CardContent>
                </Card>
            )}
        </section>
    );
}

export function PanelSections({ children }: { children: ReactNode }) {
    return <div className="flex flex-col gap-10 pt-4">{children}</div>;
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
    return <p className="text-destructive">{message}</p>;
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
