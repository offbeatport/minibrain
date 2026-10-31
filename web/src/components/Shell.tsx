import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import {
    Activity,
    Box,
    Cpu,
    Database,
    Gauge,
    GraduationCap,
    Home,
    LogOut,
    Play,
    Rocket,
    Settings,
    SunMoon,
    ThumbsUp,
    Workflow,
} from "lucide-react";
import { type UILinkProps, UIProvider } from "obp-ui";
import {
    AccountButton,
    AccountMenu,
    type AccountMenuItem,
    AppShell,
    type IconComponent,
    NavItem,
    Rail,
    SectionLabel,
} from "obp-ui/shell";
import type { MouseEvent } from "react";
import { readMinibrainParam, rememberedMinibrain } from "~/lib/selection";

type NavEntry = { label: string; path: string; icon: IconComponent; scoped?: boolean };

const SECTIONS: { label: string | null; items: NavEntry[] }[] = [
    { label: null, items: [{ label: "Home", path: "/", icon: Home }] },
    {
        label: "Explore",
        items: [
            { label: "Models", path: "/models", icon: Box },
            { label: "Playground", path: "/playground", icon: Play, scoped: true },
        ],
    },
    {
        label: "Create",
        items: [
            { label: "Data", path: "/data", icon: Database, scoped: true },
            { label: "Training", path: "/training", icon: GraduationCap, scoped: true },
            { label: "Evaluations", path: "/evaluations", icon: Gauge, scoped: true },
            { label: "Feedback", path: "/feedback", icon: ThumbsUp, scoped: true },
        ],
    },
    {
        label: "Run",
        items: [
            { label: "Deployments", path: "/deployments", icon: Rocket, scoped: true },
            { label: "Pipelines", path: "/pipelines", icon: Workflow },
            { label: "Compute", path: "/compute", icon: Cpu },
            { label: "Monitor", path: "/monitor", icon: Activity, scoped: true },
        ],
    },
];

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

function hrefFor(entry: NavEntry, minibrain: string | null): string {
    return entry.scoped && minibrain
        ? `${entry.path}?minibrain=${encodeURIComponent(minibrain)}`
        : entry.path;
}

function Navigation({ pathname, minibrain }: { pathname: string; minibrain: string | null }) {
    return (
        <>
            {SECTIONS.map((section) => (
                <div key={section.label ?? section.items[0].path} className="flex flex-col">
                    {section.label && (
                        <SectionLabel
                            tone="subtle"
                            className="pl-3.5 text-xs uppercase tracking-wide text-muted-foreground/45"
                        >
                            {section.label}
                        </SectionLabel>
                    )}
                    {section.items.map((entry) => (
                        <NavItem
                            key={entry.path}
                            icon={entry.icon}
                            label={entry.label}
                            href={hrefFor(entry, minibrain)}
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

export function Shell() {
    const router = useRouter();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const requested = useRouterState({
        select: (state) => readMinibrainParam(state.location.search),
    });
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
            <Navigation pathname={pathname} minibrain={requested ?? rememberedMinibrain()} />
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
