import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import {
    Activity,
    Box,
    Check,
    ChevronDown,
    Compass,
    Database,
    Gauge,
    GraduationCap,
    Home,
    ListChecks,
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
import { resetCompute } from "./flowCompute";
import { type Role, allows, setRole, useOverlays } from "./flowOverlays";
import { TrainDialog } from "./flowTrainDialog";
import {
    FLOW,
    type FlowState,
    type Mode,
    compareHref,
    findVersion,
    jobHref,
    markVisited,
    modelHref,
    playgroundHref,
    restartJourney,
    setMode,
    useFlowState,
    versionHref,
} from "./modelsFlowData";
import { IntentDialogs } from "./modelsFlowParts";
import "./flowTokens.css";

const SECTION_LABEL = "pl-3.5 text-xs uppercase tracking-wide text-muted-foreground/45";

type Entry = {
    label: string;
    path: string;
    icon: IconComponent;
    exact?: boolean;
    role?: Role;
};

const SECTIONS: { label: string | null; items: Entry[] }[] = [
    {
        label: null,
        items: [{ label: "Home", path: FLOW, icon: Home, exact: true }],
    },
    {
        label: "Explore",
        items: [
            { label: "Models", path: `${FLOW}/models`, icon: Box },
            { label: "Discover", path: `${FLOW}/discover`, icon: Compass, role: "builder" },
            { label: "Playground", path: `${FLOW}/playground`, icon: Play },
        ],
    },
    {
        label: "Create",
        items: [
            { label: "Data", path: `${FLOW}/data`, icon: Database, role: "builder" },
            { label: "Training", path: `${FLOW}/training`, icon: GraduationCap, role: "builder" },
            { label: "Evaluations", path: `${FLOW}/evaluations`, icon: Gauge, role: "builder" },
            { label: "Feedback", path: `${FLOW}/feedback`, icon: ThumbsUp, role: "builder" },
        ],
    },
    {
        label: "Operate",
        items: [
            { label: "Monitor", path: `${FLOW}/monitor`, icon: Activity },
            { label: "Jobs", path: `${FLOW}/jobs`, icon: ListChecks, role: "builder" },
            { label: "Infrastructure", path: `${FLOW}/infrastructure`, icon: Server },
        ],
    },
    {
        label: null,
        items: [{ label: "Settings", path: `${FLOW}/settings`, icon: Settings }],
    },
];

const ROLES: { key: Role; label: string }[] = [
    { key: "viewer", label: "Viewer" },
    { key: "builder", label: "Builder" },
    { key: "admin", label: "Admin" },
];

type Step = {
    id: string;
    label: string;
    href: string;
    match?: (path: string, state: FlowState) => boolean;
    mode?: Mode;
};

type Journey = { title: string; steps: Step[] };

const INFRA = `${FLOW}/infrastructure`;
const JOURNEY_BASE = "mistral-7b";

const MODEL_PAGE = /^\/proto\/flow\/models\/(?!new$)[^/]+$/;

function focusOf(state: FlowState): string {
    return (
        state.focus ??
        state.models.find((model) => model.kind === "custom")?.slug ??
        "support-triage"
    );
}

function journeyModel(state: FlowState): string {
    const added = state.models.find(
        (model) => model.kind === "custom" && model.base === "Mistral 7B Instruct",
    );
    return added?.slug ?? focusOf(state);
}

function rolloutHref(state: FlowState, slug: string, failed: boolean): string {
    const job = state.jobs.find(
        (item) =>
            item.model === slug &&
            item.kind === "deploy" &&
            item.atMs !== undefined &&
            (!failed || item.status === "failed"),
    );
    return job ? jobHref(job.id) : modelHref(slug);
}

function infraSteps(state: FlowState): Step[] {
    const slug = journeyModel(state);
    return [
        {
            id: "infra-add",
            label: "Add model on Mistral 7B: its page downloads, then reads Not deployed",
            href: `${FLOW}/models/new?base=${JOURNEY_BASE}`,
            mode: "full",
        },
        {
            id: "infra-deploy",
            label: "Deploy: pick the version, pool and replicas",
            href: modelHref(slug),
        },
        {
            id: "infra-rollout",
            label: "The Deploy job: download, load on gpu-a10-1, attach, route",
            href: rolloutHref(state, slug, false),
        },
        {
            id: "infra-loading",
            label: "Infrastructure: it loads, then serves on gpu-a10-1",
            href: INFRA,
        },
        { id: "infra-try", label: "Use › Playground", href: playgroundHref(slug) },
        { id: "infra-traffic", label: "Infrastructure: the GPU card shows traffic", href: INFRA },
        {
            id: "infra-undeploy",
            label: "Monitoring › Deployment › Undeploy: an Undeploy job runs",
            href: modelHref(slug),
        },
        { id: "infra-unload", label: "Infrastructure: it unloads", href: INFRA },
        {
            id: "infra-fail",
            label: "Deploy fails, and you read the rollout (Advanced › 32,768 tokens)",
            href: rolloutHref(state, slug, true),
        },
    ];
}

function journeys(state: FlowState): Journey[] {
    return [
        { title: "Train and ship", steps: steps(state) },
        { title: "What runs where", steps: infraSteps(state) },
    ];
}

function steps(state: FlowState): Step[] {
    const focus = focusOf(state);
    const model = state.models.find((item) => item.slug === focus);
    const first = model ? findVersion(model, 1) : undefined;
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
            id: "evaluate",
            label: "Evaluations: pick a base from the chart",
            href: `${FLOW}/evaluations`,
            match: (path) => path.startsWith(`${FLOW}/evaluations`),
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
            id: "data",
            label: "Data page: attach a dataset",
            href: `${FLOW}/data?for=${focus}`,
            match: (path) => path.startsWith(`${FLOW}/data`),
        },
        {
            id: "training",
            label: "Model › Training: Train v1",
            href: modelHref(focus, "training"),
            match: (path) => /\/models\/[^/]+\/training$/.test(path),
        },
        {
            id: "watch",
            label: "Watch v1 train on its job page",
            href: first ? jobHref(first.jobId) : modelHref(focus, "training"),
            match: (path) => /\/(jobs|training)\/\d+$/.test(path),
        },
        {
            id: "ready",
            label: "v1 ready: v0 Baseline vs v1, Try in Playground (@1)",
            href: compareHref(focus, 0, 1),
            match: (path) => path.endsWith("/compare") || path.startsWith(`${FLOW}/playground`),
        },
        { id: "live", label: "Open v1 and deploy it", href: versionHref(focus, 1) },
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
        {
            id: "train2",
            label: "Training page: Train v2",
            href: `${FLOW}/training`,
            match: (path) => path === `${FLOW}/training`,
        },
        { id: "inbox", label: "Inbox: v2 beats deployed v1, Deploy v2", href: FLOW },
        {
            id: "jobs",
            label: "Jobs: every job, bulk retry",
            href: `${FLOW}/jobs`,
            match: (path) => path === `${FLOW}/jobs`,
        },
        {
            id: "older",
            label: "Versions: deploy an older version",
            href: modelHref(focus, "versions"),
        },
        {
            id: "export",
            label: "Export a version from its ⋯ menu",
            href: versionHref(focus, 1),
        },
    ];
}

function go(step: Step) {
    if (step.id === "home") {
        restartJourney();
        resetCompute("empty");
    } else if (step.mode) {
        setMode(step.mode);
    }
}

function Journey({ pathname, compact }: { pathname: string; compact: boolean }) {
    const state = useFlowState();
    const [open, setOpen] = useState(false);
    const groups = journeys(state);
    const list = groups.flatMap((group) => group.steps);
    const done = list.filter((step) => state.visited.includes(step.id)).length;
    const next = list.findIndex((step) => !state.visited.includes(step.id));
    const nextGroup = groups.find((group) => group.steps.includes(list[next]));
    const nextNumber = nextGroup ? nextGroup.steps.indexOf(list[next]) + 1 : next + 1;
    return (
        <div className="relative flex min-w-0 items-center gap-3">
            {next >= 0 && (
                <Link
                    href={list[next].href}
                    onClick={() => go(list[next])}
                    title={list[next].label}
                    className={cn(
                        "hidden max-w-72 truncate text-sm text-primary hover:underline",
                        compact ? "2xl:block" : "xl:block",
                    )}
                >
                    {`Next: ${nextNumber}. ${list[next].label}`}
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
                    className="absolute top-10 right-0 z-30 flex max-h-[calc(100dvh-5rem)] w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto rounded-lg border bg-popover p-2 text-popover-foreground shadow-e2"
                >
                    {groups.map((group) => (
                        <div key={group.title} className="flex flex-col">
                            <h2 className="px-2 py-1 text-sm text-muted-foreground">
                                {group.title}
                            </h2>
                            <ol className="flex flex-col">
                                {group.steps.map((step, index) => {
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
                        </div>
                    ))}
                </nav>
            )}
        </div>
    );
}

function Navigation({ pathname, pending }: { pathname: string; pending: number }) {
    const { role } = useOverlays();
    const sections = SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter((entry) => allows(role, entry.role ?? "viewer")),
    })).filter((section) => section.items.length > 0);
    return (
        <>
            {sections.map((section) => (
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
    const { role } = useOverlays();
    const [searching, setSearching] = useState(false);
    const step = stepFor(pathname, state);
    const onModels = pathname === `${FLOW}/models`;
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
                    className="w-52 justify-start text-muted-foreground"
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
                <SegmentedTabs
                    tabs={ROLES}
                    active={role}
                    onSelect={(key) => setRole(key as Role)}
                />
                <span className="hidden truncate text-sm text-muted-foreground 2xl:inline">
                    Prototype · fake data, nothing is saved
                </span>
                <div className="ml-auto flex min-w-0 items-center">
                    <Journey pathname={pathname} compact={onModels} />
                </div>
            </div>
            <Outlet />
            <TrainDialog />
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
