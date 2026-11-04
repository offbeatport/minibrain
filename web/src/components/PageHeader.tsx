import { useRouterState } from "@tanstack/react-router";
import { EmptyState, cn } from "obp-ui";
import type { ReactNode } from "react";
import { Page } from "~/components/Section";
import { navEntryFor } from "~/components/navigation";

export function PageHeader({
    title,
    caption,
    actions,
    icon,
}: {
    title: string;
    caption?: ReactNode;
    actions?: ReactNode;
    icon?: ReactNode;
}) {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const Icon = icon ? undefined : navEntryFor(pathname)?.icon;
    return (
        <header className="flex flex-wrap items-end justify-between gap-3 pb-3">
            <div className="flex min-w-0 flex-col gap-1">
                <h1 className="flex items-center gap-3 text-3xl font-normal">
                    {icon}
                    {Icon && (
                        <Icon
                            aria-hidden="true"
                            className="size-7 shrink-0 text-muted-foreground"
                        />
                    )}
                    {title}
                </h1>
                {caption && (
                    <p
                        className={cn(
                            "text-base text-muted-foreground",
                            Icon && "pl-10",
                            icon && "pl-11",
                        )}
                    >
                        {caption}
                    </p>
                )}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
    );
}

export function ComingSoon({
    title,
    caption,
    body,
}: { title: string; caption: string; body: string }) {
    return (
        <Page>
            <PageHeader title={title} caption={caption} />
            <EmptyState variant="panel" title="Coming next">
                {body}
            </EmptyState>
        </Page>
    );
}
