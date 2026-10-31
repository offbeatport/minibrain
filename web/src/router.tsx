import {
    type AnyRoute,
    type RouteComponent,
    createRootRoute,
    createRoute,
    createRouter,
    redirect,
} from "@tanstack/react-router";
import { Shell } from "./components/Shell";
import { readMinibrainParam } from "./lib/selection";
import { ComputePage } from "./pages/ComputePage";
import { DataPage } from "./pages/DataPage";
import { DeploymentsPage } from "./pages/DeploymentsPage";
import { EvaluationsPage } from "./pages/EvaluationsPage";
import { HomePage } from "./pages/HomePage";
import { BaseModelPage, CustomModelPage } from "./pages/ModelDetailPage";
import { ModelsPage } from "./pages/ModelsPage";
import { FeedbackPage, MonitorPage, PipelinesPage } from "./pages/PlaceholderPages";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TrainingPage } from "./pages/TrainingPage";

const LEGACY_TABS: Record<string, string> = {
    data: "/data",
    versions: "/evaluations",
    playground: "/playground",
    endpoint: "/deployments",
};

const rootRoute = createRootRoute({ component: Shell });

function validateMinibrain(search: Record<string, unknown>): { minibrain?: string } {
    const minibrain = readMinibrainParam(search);
    return minibrain ? { minibrain } : {};
}

function globalPage(path: string, component: RouteComponent): AnyRoute {
    return createRoute({ getParentRoute: () => rootRoute, path, component });
}

function scopedPage(path: string, component: RouteComponent): AnyRoute {
    return createRoute({
        getParentRoute: () => rootRoute,
        path,
        component,
        validateSearch: validateMinibrain,
    });
}

function legacyHref(slug: string, tab: string): string {
    return `${LEGACY_TABS[tab] ?? "/data"}?minibrain=${encodeURIComponent(slug)}`;
}

const legacyTabRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/m/$slug/$tab",
    beforeLoad: ({ params }) => {
        throw redirect({ href: legacyHref(params.slug, params.tab) });
    },
});

const legacyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/m/$slug",
    beforeLoad: ({ params }) => {
        throw redirect({ href: legacyHref(params.slug, "data") });
    },
});

function movedToSettings(path: string): AnyRoute {
    return createRoute({
        getParentRoute: () => rootRoute,
        path,
        beforeLoad: () => {
            throw redirect({ href: "/settings" });
        },
    });
}

const routeTree = rootRoute.addChildren([
    globalPage("/", HomePage),
    globalPage("/models", ModelsPage),
    globalPage("/models/base/$key", BaseModelPage),
    globalPage("/models/custom/$slug", CustomModelPage),
    scopedPage("/playground", PlaygroundPage),
    scopedPage("/data", DataPage),
    scopedPage("/training", TrainingPage),
    scopedPage("/evaluations", EvaluationsPage),
    scopedPage("/feedback", FeedbackPage),
    scopedPage("/deployments", DeploymentsPage),
    globalPage("/pipelines", PipelinesPage),
    globalPage("/compute", ComputePage),
    scopedPage("/monitor", MonitorPage),
    globalPage("/settings", SettingsPage),
    movedToSettings("/profile"),
    movedToSettings("/preferences"),
    legacyTabRoute,
    legacyRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}
