import {
    Activity,
    Box,
    Compass,
    Database,
    Gauge,
    GraduationCap,
    HardDrive,
    Home,
    Info,
    Play,
    Rocket,
    ScrollText,
    Server,
    ShieldCheck,
    SlidersHorizontal,
    Table2,
    ThumbsUp,
    Workflow,
} from "lucide-react";
import type { IconComponent } from "obp-ui/shell";

export type NavEntry = { label: string; path: string; icon: IconComponent };

export const SECTIONS: { label: string | null; items: NavEntry[] }[] = [
    { label: null, items: [{ label: "Home", path: "/", icon: Home }] },
    {
        label: "Explore",
        items: [
            { label: "Models", path: "/models", icon: Box },
            { label: "Discover", path: "/discover", icon: Compass },
            { label: "Playground", path: "/playground", icon: Play },
        ],
    },
    {
        label: "Create",
        items: [
            { label: "Data", path: "/data", icon: Database },
            { label: "Training", path: "/training", icon: GraduationCap },
            { label: "Evaluations", path: "/evaluations", icon: Gauge },
            { label: "Feedback", path: "/feedback", icon: ThumbsUp },
        ],
    },
    {
        label: "Run",
        items: [
            { label: "Deployments", path: "/deployments", icon: Rocket },
            { label: "Pipelines", path: "/pipelines", icon: Workflow },
            { label: "Infrastructure", path: "/infrastructure", icon: Server },
            { label: "Monitor", path: "/monitor", icon: Activity },
        ],
    },
];

export const SETTINGS_PAGES: NavEntry[] = [
    { label: "General", path: "/settings", icon: SlidersHorizontal },
    { label: "Security", path: "/settings/security", icon: ShieldCheck },
    { label: "Audit log", path: "/settings/audit", icon: ScrollText },
    { label: "Data", path: "/settings/data", icon: Table2 },
    { label: "Storage", path: "/settings/storage", icon: HardDrive },
    { label: "This install", path: "/settings/install", icon: Info },
];

export function isSettingsPath(pathname: string): boolean {
    return pathname === "/settings" || pathname.startsWith("/settings/");
}

export function navEntryFor(pathname: string): NavEntry | undefined {
    const entries = [...SECTIONS.flatMap((section) => section.items), ...SETTINGS_PAGES];
    const matching = entries.filter(
        (entry) =>
            pathname === entry.path ||
            (entry.path !== "/" && pathname.startsWith(`${entry.path}/`)),
    );
    return matching.sort((left, right) => right.path.length - left.path.length)[0];
}
