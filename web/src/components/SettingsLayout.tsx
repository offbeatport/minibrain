import { useRouterState } from "@tanstack/react-router";
import { ShieldCheck, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";
import { SideMenuLayout } from "~/components/SideMenu";

const PAGES = [
    { label: "General", href: "/settings", icon: SlidersHorizontal },
    { label: "Security", href: "/settings/security", icon: ShieldCheck },
];

export function SettingsLayout({ children }: { children: ReactNode }) {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    return (
        <Page>
            <PageHeader title="Settings" />
            <SideMenuLayout label="Settings pages" items={PAGES} active={pathname}>
                {children}
            </SideMenuLayout>
        </Page>
    );
}
