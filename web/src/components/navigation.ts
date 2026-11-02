import {
    Activity,
    Box,
    Compass,
    Database,
    Gauge,
    GraduationCap,
    Home,
    Play,
    Rocket,
    Server,
    Settings,
    ThumbsUp,
    Workflow,
} from "lucide-react";
import type { IconComponent } from "obp-ui/shell";

export type NavEntry = { label: string; path: string; icon: IconComponent; scoped?: boolean };

export const SECTIONS: { label: string | null; items: NavEntry[] }[] = [
    { label: null, items: [{ label: "Home", path: "/", icon: Home }] },
    {
        label: "Explore",
        items: [
            { label: "Models", path: "/models", icon: Box },
            { label: "Discover", path: "/discover", icon: Compass },
            { label: "Playground", path: "/playground", icon: Play, scoped: true },
        ],
    },
    {
        label: "Create",
        items: [
            { label: "Data", path: "/data", icon: Database },
            { label: "Training", path: "/training", icon: GraduationCap, scoped: true },
            { label: "Evaluations", path: "/evaluations", icon: Gauge, scoped: true },
            { label: "Feedback", path: "/feedback", icon: ThumbsUp, scoped: true },
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

const SETTINGS_ENTRY: NavEntry = { label: "Settings", path: "/settings", icon: Settings };

export function navEntryFor(pathname: string): NavEntry | undefined {
    const entries = [...SECTIONS.flatMap((section) => section.items), SETTINGS_ENTRY];
    const matching = entries.filter(
        (entry) =>
            pathname === entry.path ||
            (entry.path !== "/" && pathname.startsWith(`${entry.path}/`)),
    );
    return matching.sort((left, right) => right.path.length - left.path.length)[0];
}
