import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import {
    Activity,
    Box,
    Check,
    ChevronDown,
    Compass,
    Database,
    Home,
    Play,
    Search,
    Server,
    Settings,
    ThumbsUp,
} from "lucide-react";
import { Button, Kbd, Link, SegmentedTabs, ThemeToggle, cn } from "obp-ui";
import {
    AppShell,
    type IconComponent,
    NavItem,
    Rail,
    SectionLabel,
    useRailCollapsed,
} from "obp-ui/shell";
import { type ReactNode, useEffect, useState } from "react";
import { CommandPalette } from "./FlowCommand";
import {
    FLOW,
    type FlowState,
    type Mode,
    compareHref,
    markVisited,
    modelHref,
    restartJourney,
    setMode,
    useFlowState,
    versionHref,
} from "./modelsFlowData";
import { IntentDialogs } from "./modelsFlowParts";

const SECTION_LABEL = "pl-3.5 text-xs uppercase tracking-wide text-muted-foreground/45";

type Entry = {
    label: string;
    path: string;
    icon: IconComponent;
    exact?: boolean;
};

const SECTIONS: { label: string | null; items: Entry[] }[] = [
    {
        label: null,
        items: [{ label: "Home", path: FLOW, icon: Home, exact: true }],
    },
    {
        label: "Build",
        items: [
            { label: "Models", path: `${FLOW}/models`, icon: Box },
            { label: "Data", path: `${FLOW}/data`, icon: Database },
            { label: "Feedback", path: `${FLOW}/feedback`, icon: ThumbsUp },
        ],
    },
    {
        label: "Explore",
        items: [
            { label: "Discover", path: `${FLOW}/discover`, icon: Compass },
            { label: "Playground", path: `${FLOW}/playground`, icon: Play },
        ],
    },
    {
        label: "Operate",
        items: [
            { label: "Monitor", path: `${FLOW}/monitor`, icon: Activity },
            { label: "Infrastructure", path: `${FLOW}/infrastructure`, icon: Server },
        ],
    },
    {
        label: null,
        items: [{ label: "Settings", path: `${FLOW}/settings`, icon: Settings }],
    },
];

type Step = {
    id: string;
    label: string;
    href: string;
    match?: (path: string, state: FlowState) => boolean;
    mode?: Mode;
};

const MODEL_PAGE = /^\/proto\/flow\/models\/(?!new$)[^/]+$/;

function focusOf(state: FlowState): string {
    return (
        state.focus ??
        state.models.find((model) => model.kind === "custom")?.slug ??
        "support-triage"
    );
}

function steps(state: FlowState): Step[] {
    const focus = focusOf(state);
    return [
        {
            id: "home",
            label: "Home (empty: recipes)",
            href: FLOW,
            mode: "empty",
            match: (path, current) =>
                path === FLOW && !current.models.some((model) => model.kind === "custom"),
        },
        {
            id: "start",
            label: "Start from a recipe or Add model",
            href: `${FLOW}/models/new`,
            match: (path) => path === `${FLOW}/models/new`,
        },
        {
            id: "model",
            label: "Model page Overview",
            href: modelHref(focus),
            match: (path) => MODEL_PAGE.test(path),
        },
        {
            id: "training",
            label: "Training tab: attach data, Train v1",
            href: modelHref(focus, "training"),
            match: (path) => /\/models\/[^/]+\/training$/.test(path),
        },
        {
            id: "watch",
            label: "Watch training on v1's Training tab",
            href: versionHref(focus, 1, "training"),
            match: (path) => /\/versions\/v\d+\/training$/.test(path),
        },
        {
            id: "ready",
            label: "v1 ready: v0 Baseline vs v1, Try in Playground (@1)",
            href: compareHref(focus, 0, 1),
            match: (path) => path.endsWith("/compare") || path.startsWith(`${FLOW}/playground`),
        },
        { id: "live", label: "Make live", href: versionHref(focus, 1) },
        {
            id: "connect",
            label: "Connect, plus an API key",
            href: modelHref(focus, "keys"),
            match: (path) => /\/models\/[^/]+\/keys$/.test(path),
        },
        {
            id: "monitoring",
            label: "Monitoring",
            href: modelHref(focus, "monitoring"),
            match: (path) => /\/models\/[^/]+\/monitoring$/.test(path),
        },
        {
            id: "feedback",
            label: "Feedback review",
            href: `${FLOW}/feedback`,
            match: (path) => path.startsWith(`${FLOW}/feedback`),
        },
        { id: "train2", label: "Train v2", href: modelHref(focus, "training") },
        { id: "inbox", label: "Inbox: v2 beats live, Make live", href: FLOW },
        { id: "rollback", label: "Roll back", href: modelHref(focus, "versions") },
    ];
}

function go(step: Step) {
    if (step.id === "home") {
        restartJourney();
    }
}

function Journey({ pathname }: { pathname: string }) {
    const state = useFlowState();
    const [open, setOpen] = useState(false);
    const list = steps(state);
    const done = list.filter((step) => state.visited.includes(step.id)).length;
    const next = list.findIndex((step) => !state.visited.includes(step.id));
    return (
        <div className="relative flex min-w-0 items-center gap-3">
            {next >= 0 && (
                <Link
                    href={list[next].href}
                    onClick={() => go(list[next])}
                    title={list[next].label}
                    className="hidden max-w-72 truncate text-sm text-primary hover:underline xl:block"
                >
                    {`Next: ${next + 1}. ${list[next].label}`}
                </Link>
            )}
            <Button
                variant="outline"
                aria-expanded={open}
                aria-controls="flow-journey"
                onClick={() => setOpen(!open)}
            >
                Journey
                <span className="text-muted-foreground tabular-nums">{`${done} of ${list.length}`}</span>
                <ChevronDown
                    aria-hidden="true"
                    className={cn(
                        "transition-transform duration-100 motion-reduce:transition-none",
                        open && "rotate-180",
                    )}
                />
            </Button>
            {open && (
                <nav
                    id="flow-journey"
                    aria-label="Journey"
                    onKeyDown={(event) => event.key === "Escape" && setOpen(false)}
                    className="absolute top-10 right-0 z-30 w-96 rounded-lg border bg-popover p-2 text-popover-foreground shadow-e2"
                >
                    <ol className="flex flex-col">
                        {list.map((step, index) => {
                            const visited = state.visited.includes(step.id);
                            const here = step.match?.(pathname, state) ?? false;
                            return (
                                <li key={step.id}>
                                    <Link
                                        href={step.href}
                                        onClick={() => {
                                            go(step);
                                            setOpen(false);
                                        }}
                                        aria-current={here ? "step" : undefined}
                                        className={cn(
                                            "flex min-h-8 items-center gap-2 rounded-md px-2 py-1 hover:bg-secondary",
                                            here &&
                                                "bg-accent text-accent-foreground hover:bg-accent",
                                        )}
                                    >
                                        <span className="w-5 shrink-0 text-right text-sm text-muted-foreground tabular-nums">
                                            {index + 1}
                                        </span>
                                        <span className="flex-1">{step.label}</span>
                                        {visited && (
                                            <Check
                                                aria-label="Done"
                                                className="size-4 shrink-0 text-success"
                                            />
                                        )}
                                    </Link>
                                </li>
                            );
                        })}
                    </ol>
                </nav>
            )}
        </div>
    );
}

function Navigation({ pathname, pending }: { pathname: string; pending: number }) {
    return (
        <>
            {SECTIONS.map((section) => (
                <div key={section.label ?? section.items[0].path} className="flex flex-col">
                    {section.label && (
                        <SectionLabel tone="subtle" className={SECTION_LABEL}>
                            {section.label}
                        </SectionLabel>
                    )}
                    {section.items.map((entry) => {
                        const counted = entry.label === "Feedback" && pending > 0;
                        return (
                            <NavItem
                                key={entry.path}
                                icon={entry.icon}
                                label={
                                    counted ? (
                                        <span className="flex flex-1 items-center justify-between gap-2">
                                            {entry.label}
                                            <span className="text-sm text-muted-foreground tabular-nums">
                                                {pending}
                                            </span>
                                        </span>
                                    ) : (
                                        entry.label
                                    )
                                }
                                title={entry.label}
                                href={entry.path}
                                active={
                                    entry.exact
                                        ? pathname === entry.path
                                        : pathname === entry.path ||
                                          pathname.startsWith(`${entry.path}/`)
                                }
                                iconStyle="plain"
                            />
                        );
                    })}
                </div>
            ))}
        </>
    );
}

function stepFor(pathname: string, state: FlowState): string | undefined {
    return steps(state).find((step) => step.match?.(pathname, state))?.id;
}

const MODES = [
    { key: "empty", label: "Empty install" },
    { key: "full", label: "With models" },
];

export function FlowShell() {
    const pathname = useRouterState({
        select: (state) => state.location.pathname,
    }).replace(/\/$/, "");
    const state = useFlowState();
    const [searching, setSearching] = useState(false);
    const step = stepFor(pathname, state);
    useEffect(() => {
        if (step) {
            markVisited(step);
        }
    }, [step]);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                setSearching((open) => !open);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
    const pending = state.feedback.filter((row) => row.state === "pending").length;
    const rail = (
        <Rail
            brand={<span className="text-base font-semibold">minibrain</span>}
            brandHref={FLOW}
            brandLabel="Home"
            toggleIcon="panel"
            togglePlacement="header"
            footer={<RailFooter />}
        >
            <Navigation pathname={pathname} pending={pending} />
        </Rail>
    );
    return (
        <AppShell rail={rail}>
            <div className="sticky top-[env(safe-area-inset-top,0px)] z-20 flex h-12 shrink-0 items-center gap-3 border-b bg-background px-6">
                <Button
                    variant="outline"
                    onClick={() => setSearching(true)}
                    className="w-64 justify-start text-muted-foreground"
                >
                    <Search aria-hidden="true" />
                    Search
                    <Kbd className="ml-auto">⌘K</Kbd>
                </Button>
                <SegmentedTabs
                    tabs={MODES}
                    active={state.mode}
                    onSelect={(key) => setMode(key as Mode)}
                />
                <span className="hidden truncate text-sm text-muted-foreground 2xl:inline">
                    Prototype · fake data, nothing is saved
                </span>
                <div className="ml-auto flex min-w-0 items-center">
                    <Journey pathname={pathname} />
                </div>
            </div>
            <Outlet />
            <IntentDialogs />
            <CommandPalette open={searching} onOpenChange={setSearching} />
        </AppShell>
    );
}

function RailFooter() {
    if (useRailCollapsed()) {
        return null;
    }
    return (
        <div className="flex items-center justify-between gap-2 px-2">
            <Link
                href="/models"
                className="text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
                Leave prototype
            </Link>
            <ThemeToggle />
        </div>
    );
}

export function FlowRedirect() {
    const router = useRouter();
    useEffect(() => {
        router.history.replace(FLOW);
    }, [router]);
    return null;
}

export function Stub({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-6 pt-8 pb-6">
            <h1 className="text-3xl font-normal">{title}</h1>
            {children}
        </div>
    );
}
