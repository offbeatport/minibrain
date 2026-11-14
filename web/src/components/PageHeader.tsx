import { useRouterState } from "@tanstack/react-router";
import { cn } from "obp-ui";
import type { ReactNode } from "react";
import { type Crumb, PageCrumbs } from "~/components/PageCrumbs";
import { navEntryFor } from "~/components/navigation";

export type { Crumb };

export function PageHeader({
    title,
    caption,
    actions,
    icon,
    badge,
    crumbs,
}: {
    title: string;
    caption?: ReactNode;
    actions?: ReactNode;
    icon?: ReactNode;
    badge?: ReactNode;
    crumbs?: Crumb[];
}) {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const Icon = icon ? undefined : navEntryFor(pathname)?.icon;
    const heading = (
        <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 className="flex items-center gap-3 text-3xl font-normal">
                    {Icon && (
                        <Icon
                            aria-hidden="true"
                            className="size-7 shrink-0 text-muted-foreground"
                        />
                    )}
                    {title}
                </h1>
                {badge}
            </div>
            {caption && (
                <p className={cn("text-base text-muted-foreground", Icon && "pl-10")}>{caption}</p>
            )}
        </div>
    );
    return (
        <header className="flex flex-col gap-2 pb-3">
            <PageCrumbs items={crumbs ?? [{ label: title }]} />
            <div className="flex flex-wrap items-start justify-between gap-3">
                {icon ? (
                    <div className="flex min-w-0 items-center gap-4">
                        {icon}
                        {heading}
                    </div>
                ) : (
                    heading
                )}
                {actions && (
                    <div className="flex min-h-8 flex-wrap items-center gap-2">{actions}</div>
                )}
            </div>
        </header>
    );
}
