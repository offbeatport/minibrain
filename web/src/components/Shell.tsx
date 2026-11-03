import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, LogOut, Settings, SunMoon } from "lucide-react";
import { ToastProvider, type UILinkProps, UIProvider } from "obp-ui";
import {
    AccountButton,
    AccountMenu,
    type AccountMenuItem,
    AppShell,
    NavItem,
    Rail,
    SectionLabel,
} from "obp-ui/shell";
import { type MouseEvent, type ReactNode, useEffect } from "react";
import { usePerson, useSession, useSignOut } from "~/api/authQueries";
import { SECTIONS, SETTINGS_PAGES, isSettingsPath, visibleTo } from "~/components/navigation";
import { ROLE_LABELS, initialOf } from "~/lib/access";
import { appPageToReturnTo, rememberAppPage } from "~/lib/lastAppPage";
import { NoAccessPage, SetPasswordPage, SetupPage, SignInPage } from "~/pages/auth/AuthPages";

const SECTION_LABEL = "pl-3.5 text-xs uppercase tracking-wide text-muted-foreground/45";

export const SET_PASSWORD_PATH = "/reset-password";

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
    const shown = visibleTo(usePerson()?.role);
    const sections = SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter(shown),
    }));
    return (
        <>
            {sections.map((section) => (
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
    const shown = visibleTo(usePerson()?.role);
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
                {SETTINGS_PAGES.filter(shown).map((entry) => (
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

function Account() {
    const session = useSession();
    const signOut = useSignOut();
    const person = session.data?.person;
    const signedIn = person != null && person.source !== "single_user";
    const signsOut = signedIn && person.source !== "proxy";
    const name = person?.name ?? "Local user";
    const sub = signedIn
        ? (person.email ?? (person.role ? ROLE_LABELS[person.role] : "No role"))
        : "This install";
    const items: AccountMenuItem[] = [
        { icon: <Settings />, label: "Settings", href: "/settings" },
        { kind: "theme", icon: <SunMoon />, label: "Theme" },
        ...(signsOut || !signedIn
            ? [
                  {
                      icon: <LogOut />,
                      label: "Sign out",
                      separatorBefore: true,
                      disabled: !signsOut || signOut.isPending,
                      onSelect: () => signOut.mutate(),
                  },
              ]
            : []),
    ];
    return (
        <AccountMenu
            trigger={<AccountButton initial={initialOf(name)} name={name} sub={sub} />}
            items={items}
            spacing="comfortable"
        />
    );
}

function Gate({ pathname, children }: { pathname: string; children: ReactNode }) {
    const router = useRouter();
    const session = useSession();
    if (pathname === SET_PASSWORD_PATH) {
        return <SetPasswordPage onDone={() => router.history.push("/")} />;
    }
    if (session.isPending) {
        return null;
    }
    const info = session.data;
    if (info?.accounts && !info.person) {
        return info.setup ? <SetupPage session={info} /> : <SignInPage />;
    }
    if (info?.person && info.person.role == null) {
        return <NoAccessPage session={info} />;
    }
    return children;
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
            footer={<Account />}
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
            <ToastProvider>
                <Gate pathname={pathname}>
                    <AppShell rail={rail}>
                        <Outlet />
                    </AppShell>
                </Gate>
            </ToastProvider>
        </UIProvider>
    );
}
