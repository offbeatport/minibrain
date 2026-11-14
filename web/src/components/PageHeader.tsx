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
    const titleRow = (
        <div className="flex min-w-0 items-center gap-x-3">
            <h1 className="flex min-w-0 items-center gap-3 text-3xl font-normal">
                {Icon && (
                    <Icon aria-hidden="true" className="size-7 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate" title={title}>
                    {title}
                </span>
            </h1>
            {badge && <div className="shrink-0">{badge}</div>}
        </div>
    );
    const captionLine = caption && (
        <p className={cn("text-base text-muted-foreground", Icon && "pl-10")}>{caption}</p>
    );
    const actionsBox = actions && (
        <div className="ml-auto flex min-h-8 shrink-0 items-center gap-2">{actions}</div>
    );
    return (
        <header className="flex flex-col gap-2 pb-3">
            <PageCrumbs items={crumbs ?? [{ label: title }]} />
            {icon ? (
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 grow basis-48 items-center gap-4">
                        {icon}
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                            {titleRow}
                            {captionLine}
                        </div>
                    </div>
                    {actionsBox}
                </div>
            ) : (
                <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 grow basis-48">{titleRow}</div>
                        {actionsBox}
                    </div>
                    {captionLine}
                </div>
            )}
        </header>
    );
}
