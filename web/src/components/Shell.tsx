import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { Button, ThemeToggle, type UILinkProps, UIProvider } from "obp-ui";
import { AppShell, EntityRow, Rail } from "obp-ui/shell";
import type { MouseEvent } from "react";
import type { MinibrainSummary } from "~/api/client";
import { useMinibrains } from "~/api/queries";

function KitLink({ href, onClick, ...rest }: UILinkProps) {
    const router = useRouter();
    const follow = (event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
        if (event.defaultPrevented || modified || event.button !== 0) {
            return;
        }
        event.preventDefault();
        router.history.push(href);
    };
    return <a href={href} onClick={follow} {...rest} />;
}

function Initial({ name, active }: { name: string; active: boolean }) {
    return (
        <span className="relative grid size-8 flex-none place-items-center rounded-md border bg-card text-sm font-semibold">
            {name.slice(0, 1).toUpperCase()}
            {active && (
                <span
                    aria-hidden="true"
                    className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-info"
                />
            )}
        </span>
    );
}

function meta(item: MinibrainSummary): string {
    if (item.active_jobs > 0) {
        return "Job running";
    }
    return item.current_version === null ? "No version yet" : `Serving v${item.current_version}`;
}

function MinibrainList({ pathname }: { pathname: string }) {
    const { data } = useMinibrains();
    return (
        <div className="flex flex-col gap-0.5 px-3">
            {(data ?? []).map((item) => (
                <EntityRow
                    key={item.slug}
                    name={item.name}
                    href={`/m/${item.slug}/data`}
                    avatar={<Initial name={item.name} active={item.active_jobs > 0} />}
                    metaLabel={meta(item)}
                    selected={pathname.startsWith(`/m/${item.slug}/`)}
                />
            ))}
        </div>
    );
}

export function Shell() {
    const router = useRouter();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const rail = (
        <Rail
            brand={<span className="text-base font-semibold">Minibrain</span>}
            brandCollapsed={<span className="text-base font-semibold">M</span>}
            brandHref="/"
            footer={<ThemeToggle />}
        >
            <div className="px-3 pb-2">
                <Button asChild variant="outline" size="sm" className="w-full">
                    <KitLink href="/">New minibrain</KitLink>
                </Button>
            </div>
            <MinibrainList pathname={pathname} />
        </Rail>
    );
    return (
        <UIProvider
            Link={KitLink}
            navigate={(href) => router.history.push(href)}
            pathname={pathname}
            paths={{ home: () => "/" }}
        >
            <AppShell rail={rail}>
                <Outlet />
            </AppShell>
        </UIProvider>
    );
}
