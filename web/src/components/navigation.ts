import {
    Activity,
    Box,
    Cable,
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
    Users,
    Workflow,
} from "lucide-react";
import type { IconComponent } from "obp-ui/shell";
import type { Role } from "~/api/authQueries";
import { allows } from "~/lib/access";

export type NavEntry = { label: string; path: string; icon: IconComponent; role?: Role };

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
            { label: "Data", path: "/data", icon: Database, role: "builder" },
            { label: "Training", path: "/training", icon: GraduationCap },
            { label: "Evaluations", path: "/evaluations", icon: Gauge },
            { label: "Feedback", path: "/feedback", icon: ThumbsUp, role: "builder" },
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
    { label: "Security", path: "/settings/security", icon: ShieldCheck, role: "admin" },
    { label: "Accounts", path: "/settings/accounts", icon: Users, role: "admin" },
    { label: "Audit log", path: "/settings/audit", icon: ScrollText, role: "admin" },
    { label: "Data", path: "/settings/data", icon: Table2, role: "admin" },
    { label: "Storage", path: "/settings/storage", icon: HardDrive, role: "admin" },
    { label: "Connections", path: "/settings/connections", icon: Cable, role: "admin" },
    { label: "This install", path: "/settings/install", icon: Info, role: "admin" },
];

export function visibleTo(role: Role | null | undefined): (entry: NavEntry) => boolean {
    return (entry) => !entry.role || allows(role, entry.role);
}

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
