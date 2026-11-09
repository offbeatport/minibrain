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
    Server,
    Settings,
    ThumbsUp,
} from "lucide-react";
import { Button, Link, ThemeToggle, cn } from "obp-ui";
import {
    AppShell,
    type IconComponent,
    NavItem,
    Rail,
    SectionLabel,
    useRailCollapsed,
} from "obp-ui/shell";
import { type ReactNode, useEffect, useState } from "react";
import {
    FLOW,
    type FlowState,
    markVisited,
    modelHref,
    newestFirst,
    useFlowState,
    versionHref,
} from "./modelsFlowData";

const SECTION_LABEL = "pl-3.5 text-xs uppercase tracking-wide text-muted-foreground/45";

type Entry = { label: string; path: string; icon: IconComponent; exact?: boolean };

const SECTIONS: { label: string | null; items: Entry[] }[] = [
    { label: null, items: [{ label: "Home", path: FLOW, icon: Home, exact: true }] },
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
    { label: null, items: [{ label: "Settings", path: `${FLOW}/settings`, icon: Settings }] },
];

type Step = { id: string; label: string; href: string; match: (path: string) => boolean };

const MODEL_PAGE = /^\/proto\/flow\/models\/(?!new$)[^/]+(\/(versions))?$/;

function focusOf(state: FlowState): string {
    return state.focus ?? "support-triage";
}

function steps(state: FlowState): Step[] {
    const focus = focusOf(state);
    const model = state.models.find((item) => item.slug === focus);
    const newest = model
        ? newestFirst(model).find((version) => version.kind === "trained")
        : undefined;
    const training = model?.versions.find((version) => version.status === "training");
    return [
        { id: "home", label: "Home", href: FLOW, match: (path) => path === FLOW },
        {
            id: "discover",
            label: "Discover a base",
            href: `${FLOW}/discover`,
            match: (path) => path.startsWith(`${FLOW}/discover`),
        },
        {
            id: "add",
            label: "Add a model",
            href: `${FLOW}/models/new?base=qwen3-0.6b`,
            match: (path) => path === `${FLOW}/models/new`,
        },
        {
            id: "model",
            label: "Its model page",
            href: modelHref(focus),
            match: (path) => MODEL_PAGE.test(path),
        },
        {
            id: "data",
            label: "Add data",
            href: `${FLOW}/data`,
            match: (path) => path.startsWith(`${FLOW}/data`) || /\/models\/[^/]+\/data$/.test(path),
        },
        {
            id: "train",
            label: "Train v1",
            href: training ? `${FLOW}/jobs/${training.jobId}` : modelHref(focus),
            match: (path) => path.startsWith(`${FLOW}/jobs/`),
        },
        {
            id: "version",
            label: "Version page, deploy",
            href: newest ? versionHref(focus, newest.number) : versionHref("support-triage", 5),
            match: (path) => /\/versions\/v\d+/.test(path) || path.endsWith("/compare"),
        },
        {
            id: "api",
            label: "API key",
            href: modelHref(focus, "api"),
            match: (path) => /\/models\/[^/]+\/api$/.test(path),
        },
        {
            id: "playground",
            label: "Playground",
            href: `${FLOW}/playground?model=${focus}`,
            match: (path) => path.startsWith(`${FLOW}/playground`),
        },
        {
            id: "monitor",
            label: "Monitor",
            href: `${FLOW}/monitor`,
            match: (path) => path.startsWith(`${FLOW}/monitor`),
        },
        {
            id: "feedback",
            label: "Feedback",
            href: `${FLOW}/feedback`,
            match: (path) => path.startsWith(`${FLOW}/feedback`),
        },
    ];
}

function Journey({ pathname }: { pathname: string }) {
    const state = useFlowState();
    const [open, setOpen] = useState(false);
    const list = steps(state);
    const done = list.filter((step) => state.visited.includes(step.id)).length;
    const next = list.findIndex((step) => !state.visited.includes(step.id));
    return (
        <div className="relative flex items-center gap-3">
            {next >= 0 && (
                <Link href={list[next].href} className="text-sm text-primary hover:underline">
                    {`Next: ${next + 1}. ${list[next].label} →`}
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
                    className="absolute top-10 right-0 z-30 w-72 rounded-lg border bg-popover p-2 text-popover-foreground shadow-e2"
                >
                    <ol className="flex flex-col">
                        {list.map((step, index) => {
                            const visited = state.visited.includes(step.id);
                            const here = step.match(pathname);
                            return (
                                <li key={step.id}>
                                    <Link
                                        href={step.href}
                                        onClick={() => setOpen(false)}
                                        aria-current={here ? "step" : undefined}
                                        className={cn(
                                            "flex h-8 items-center gap-2 rounded-md px-2 hover:bg-secondary",
                                            here &&
                                                "bg-accent text-accent-foreground hover:bg-accent",
                                        )}
                                    >
                                        <span className="w-5 text-right text-sm text-muted-foreground tabular-nums">
                                            {index + 1}
                                        </span>
                                        <span className="flex-1 truncate">{step.label}</span>
                                        {visited && (
                                            <Check
                                                aria-label="Visited"
                                                className="size-4 text-success"
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
    return steps(state).find((step) => step.match(pathname))?.id;
}

export function FlowShell() {
    const pathname = useRouterState({ select: (state) => state.location.pathname }).replace(
        /\/$/,
        "",
    );
    const state = useFlowState();
    const step = stepFor(pathname, state);
    useEffect(() => {
        if (step) {
            markVisited(step);
        }
    }, [step]);
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
            <div className="sticky top-[env(safe-area-inset-top,0px)] z-20 flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-background px-6">
                <span className="text-sm text-muted-foreground">
                    Prototype of the proposed structure · fake data, nothing is saved
                </span>
                <Journey pathname={pathname} />
            </div>
            <Outlet />
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
