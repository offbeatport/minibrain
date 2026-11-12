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
    ListChecks,
    Play,
    ScrollText,
    Server,
    ShieldCheck,
    SlidersHorizontal,
    Table2,
    ThumbsUp,
    Users,
} from "lucide-react";
import type { IconComponent } from "obp-ui/shell";
import type { Role } from "~/api/authQueries";
import { allows } from "~/lib/access";

export type NavEntry = { label: string; path: string; icon: IconComponent; role?: Role };

export type NavSection = { label: string | null; items: NavEntry[] };

export const SECTIONS: NavSection[] = [
    { label: null, items: [{ label: "Home", path: "/", icon: Home }] },
    {
        label: "Explore",
        items: [
            { label: "Models", path: "/models", icon: Box },
            { label: "Discover", path: "/discover", icon: Compass, role: "builder" },
            { label: "Playground", path: "/playground", icon: Play },
        ],
    },
    {
        label: "Create",
        items: [
            { label: "Data", path: "/data", icon: Database, role: "builder" },
            { label: "Training", path: "/training", icon: GraduationCap, role: "builder" },
            { label: "Evaluations", path: "/evaluations", icon: Gauge, role: "builder" },
            { label: "Feedback", path: "/feedback", icon: ThumbsUp, role: "builder" },
        ],
    },
    {
        label: "Operate",
        items: [
            { label: "Monitoring", path: "/monitor", icon: Activity },
            { label: "Jobs", path: "/jobs", icon: ListChecks, role: "builder" },
            { label: "Infrastructure", path: "/infrastructure", icon: Server, role: "admin" },
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

export function sectionsFor(role: Role | null | undefined): NavSection[] {
    const shown = visibleTo(role);
    return SECTIONS.map((section) => ({ ...section, items: section.items.filter(shown) })).filter(
        (section) => section.items.length > 0,
    );
}

export function isSettingsPath(pathname: string): boolean {
    return pathname === "/settings" || pathname.startsWith("/settings/");
}

export function navEntryFor(pathname: string): NavEntry | undefined {
    const entries = [...SETTINGS_PAGES, ...SECTIONS.flatMap((section) => section.items)];
    const matching = entries.filter(
        (entry) =>
            pathname === entry.path ||
            (entry.path !== "/" && pathname.startsWith(`${entry.path}/`)),
    );
    return matching.sort((left, right) => right.path.length - left.path.length)[0];
}
