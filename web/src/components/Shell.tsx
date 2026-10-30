import { AnimatedBadge } from "@/components/motion/animated-badge";
import {
    AnimatedSidebar,
    AnimatedSidebarContent,
    AnimatedSidebarFooter,
    AnimatedSidebarGroup,
    AnimatedSidebarGroupContent,
    AnimatedSidebarGroupLabel,
    AnimatedSidebarHeader,
    AnimatedSidebarInset,
    AnimatedSidebarMenu,
    AnimatedSidebarMenuButton,
    AnimatedSidebarMenuItem,
    AnimatedSidebarProvider,
    AnimatedSidebarRail,
    AnimatedSidebarTrigger,
} from "@/components/motion/animated-sidebar";
import { ThemeToggle } from "@/components/motion/theme-toggle";
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { PanelLeft, Plus } from "lucide-react";
import { useMinibrains } from "~/api/queries";

function Initial({ name }: { name: string }) {
    return (
        <span className="grid size-5 shrink-0 place-items-center rounded-md bg-foreground text-[11px] font-semibold text-background">
            {name.slice(0, 1).toUpperCase()}
        </span>
    );
}

function MinibrainMenu() {
    const router = useRouter();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const { data } = useMinibrains();
    return (
        <AnimatedSidebarMenu>
            {(data ?? []).map((item) => (
                <AnimatedSidebarMenuItem key={item.slug}>
                    <AnimatedSidebarMenuButton
                        icon={<Initial name={item.name} />}
                        isActive={pathname.startsWith(`/m/${item.slug}/`)}
                        badge={
                            item.active_jobs > 0 ? (
                                <AnimatedBadge status="loading" size="sm" showIcon={false}>
                                    Job
                                </AnimatedBadge>
                            ) : undefined
                        }
                        onSelect={() => router.history.push(`/m/${item.slug}/data`)}
                    >
                        {item.name}
                    </AnimatedSidebarMenuButton>
                </AnimatedSidebarMenuItem>
            ))}
        </AnimatedSidebarMenu>
    );
}

export function Shell() {
    const router = useRouter();
    return (
        <AnimatedSidebarProvider className="h-screen min-h-0 overflow-hidden bg-background">
            <AnimatedSidebar
                ariaLabel="Minibrains"
                collapsible="icon"
                className="min-h-0"
                panelClassName="h-full"
            >
                <AnimatedSidebarHeader className="p-3 pb-2">
                    <div className="flex min-h-10 items-center gap-3 overflow-hidden px-2">
                        <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
                            M
                        </div>
                        <span className="truncate text-sm font-semibold group-data-[state=collapsed]/sidebar:hidden">
                            Minibrain
                        </span>
                    </div>
                </AnimatedSidebarHeader>
                <AnimatedSidebarContent className="px-2 pt-1">
                    <AnimatedSidebarGroup className="pb-2">
                        <AnimatedSidebarGroupContent>
                            <AnimatedSidebarMenu>
                                <AnimatedSidebarMenuItem>
                                    <AnimatedSidebarMenuButton
                                        icon={<Plus className="size-4" />}
                                        onSelect={() => router.history.push("/")}
                                    >
                                        New minibrain
                                    </AnimatedSidebarMenuButton>
                                </AnimatedSidebarMenuItem>
                            </AnimatedSidebarMenu>
                        </AnimatedSidebarGroupContent>
                    </AnimatedSidebarGroup>
                    <AnimatedSidebarGroup>
                        <AnimatedSidebarGroupLabel>Minibrains</AnimatedSidebarGroupLabel>
                        <AnimatedSidebarGroupContent>
                            <MinibrainMenu />
                        </AnimatedSidebarGroupContent>
                    </AnimatedSidebarGroup>
                </AnimatedSidebarContent>
                <AnimatedSidebarFooter className="p-3">
                    <ThemeToggle
                        variant="circle"
                        className="rounded-xl border border-border bg-background p-2"
                        iconClassName="size-4"
                    />
                </AnimatedSidebarFooter>
                <AnimatedSidebarRail />
            </AnimatedSidebar>
            <AnimatedSidebarInset className="min-h-0 overflow-y-auto bg-background">
                <div className="flex h-12 items-center border-b border-border px-4">
                    <AnimatedSidebarTrigger className="text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                        <PanelLeft aria-hidden="true" className="size-4" />
                    </AnimatedSidebarTrigger>
                </div>
                <Outlet />
            </AnimatedSidebarInset>
        </AnimatedSidebarProvider>
    );
}
