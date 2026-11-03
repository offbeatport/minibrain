import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, LogOut, Settings, SunMoon } from "lucide-react";
import { type UILinkProps, UIProvider } from "obp-ui";
import {
    AccountButton,
    AccountMenu,
    type AccountMenuItem,
    AppShell,
    NavItem,
    Rail,
    SectionLabel,
} from "obp-ui/shell";
import { type MouseEvent, useEffect } from "react";
import { SECTIONS, SETTINGS_PAGES, isSettingsPath } from "~/components/navigation";
import { appPageToReturnTo, rememberAppPage } from "~/lib/lastAppPage";

const SECTION_LABEL = "pl-3.5 text-xs uppercase tracking-wide text-muted-foreground/45";

const ACCOUNT_ITEMS: AccountMenuItem[] = [
    { icon: <Settings />, label: "Settings", href: "/settings" },
    { kind: "theme", icon: <SunMoon />, label: "Theme" },
    { icon: <LogOut />, label: "Sign out", separatorBefore: true, disabled: true },
];

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

function Navigation({ pathname }: { pathname: string }) {
    return (
        <>
            {SECTIONS.map((section) => (
                <div key={section.label ?? section.items[0].path} className="flex flex-col">
                    {section.label && (
                        <SectionLabel tone="subtle" className={SECTION_LABEL}>
                            {section.label}
                        </SectionLabel>
                    )}
                    {section.items.map((entry) => (
                        <NavItem
                            key={entry.path}
                            icon={entry.icon}
                            label={entry.label}
                            href={entry.path}
                            active={
                                pathname === entry.path || pathname.startsWith(`${entry.path}/`)
                            }
                            iconStyle="plain"
                        />
                    ))}
                </div>
            ))}
        </>
    );
}

function SettingsNavigation({ pathname }: { pathname: string }) {
    return (
        <>
            <NavItem
                icon={ArrowLeft}
                label="Back"
                href={appPageToReturnTo()}
                active={false}
                iconStyle="plain"
            />
            <div className="flex flex-col">
                <SectionLabel tone="subtle" className={SECTION_LABEL}>
                    Settings
                </SectionLabel>
                {SETTINGS_PAGES.map((entry) => (
                    <NavItem
                        key={entry.path}
                        icon={entry.icon}
                        label={entry.label}
                        href={entry.path}
                        active={pathname === entry.path}
                        iconStyle="plain"
                    />
                ))}
            </div>
        </>
    );
}

export function Shell() {
    const router = useRouter();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const href = useRouterState({ select: (state) => state.location.href });
    const settings = isSettingsPath(pathname);
    useEffect(() => {
        if (!settings) {
            rememberAppPage(href);
        }
    }, [settings, href]);
    const rail = (
        <Rail
            brand={<span className="text-base font-semibold">minibrain</span>}
            brandHref="/"
            brandLabel="Home"
            toggleIcon="panel"
            togglePlacement="header"
            footer={
                <AccountMenu
                    trigger={<AccountButton initial="L" name="Local user" sub="This install" />}
                    items={ACCOUNT_ITEMS}
                    spacing="comfortable"
                />
            }
        >
            {settings ? (
                <SettingsNavigation pathname={pathname} />
            ) : (
                <Navigation pathname={pathname} />
            )}
        </Rail>
    );
    return (
        <UIProvider
            Link={KitLink}
            navigate={(href) => router.history.push(href)}
            pathname={pathname}
            paths={{ home: () => "/", settings: () => "/settings" }}
        >
            <AppShell rail={rail}>
                <Outlet />
            </AppShell>
        </UIProvider>
    );
}
