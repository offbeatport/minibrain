import { useRouterState } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Breadcrumbs, type Crumb } from "~/components/Breadcrumbs";
import { navGroupFor } from "~/components/navigation";

export type { Crumb };

export function PageCrumbs({ items }: { items: Crumb[] }) {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const group = navGroupFor(pathname);
    return (
        <div className="flex min-h-5 flex-wrap items-center gap-1 text-sm">
            {group && (
                <>
                    <span className="text-muted-foreground">{group}</span>
                    <ChevronRight aria-hidden="true" className="size-3.5 text-faint" />
                </>
            )}
            <Breadcrumbs items={items} />
        </div>
    );
}
