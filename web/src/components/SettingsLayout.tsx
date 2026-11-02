import { useRouterState } from "@tanstack/react-router";
import { ShieldCheck, SlidersHorizontal } from "lucide-react";
import { NavItem } from "obp-ui/shell";
import type { ReactNode } from "react";
import { PageHeader } from "~/components/PageHeader";
import { Page } from "~/components/Section";

const PAGES = [
    { label: "General", href: "/settings", icon: SlidersHorizontal },
    { label: "Security", href: "/settings/security", icon: ShieldCheck },
];

export function SettingsLayout({
    caption,
    children,
}: { caption?: ReactNode; children: ReactNode }) {
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    return (
        <Page>
            <PageHeader title="Settings" caption={caption} />
            <div className="flex flex-col gap-6 md:flex-row md:items-start">
                <nav
                    aria-label="Settings pages"
                    className="flex shrink-0 gap-1 md:sticky md:top-4 md:w-48 md:flex-col"
                >
                    {PAGES.map((page) => (
                        <NavItem
                            key={page.href}
                            icon={page.icon}
                            label={page.label}
                            href={page.href}
                            active={pathname === page.href}
                            collapsed={false}
                            iconStyle="plain"
                        />
                    ))}
                </nav>
                <div className="flex min-w-0 flex-1 flex-col gap-4">{children}</div>
            </div>
        </Page>
    );
}
