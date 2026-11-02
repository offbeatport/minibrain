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
import { DataPage } from "./pages/DataPage";
import { DeploymentsPage, EndpointPage } from "./pages/DeploymentsPage";
import { EvaluationsPage } from "./pages/EvaluationsPage";
import { HomePage } from "./pages/HomePage";
import { InfrastructurePage } from "./pages/InfrastructurePage";
import { BaseModelPage, CustomModelPage } from "./pages/ModelDetailPage";
import { DiscoverPage, ModelsPage } from "./pages/ModelsPage";
import { MonitorPage } from "./pages/MonitorPage";
import { FeedbackPage, PipelinesPage } from "./pages/PlaceholderPages";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { SecurityPage } from "./pages/SecurityPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TrainingPage } from "./pages/TrainingPage";
import { LogosPage } from "./pages/proto/LogosPage";

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
    createRoute({
        getParentRoute: () => rootRoute,
        path: "/models",
        beforeLoad: ({ location }) => {
            const params = new URLSearchParams(location.searchStr);
            if (params.get("tab") === "discover") {
                params.delete("tab");
                const rest = params.toString();
                throw redirect({ href: `/discover${rest ? `?${rest}` : ""}` });
            }
        },
        component: ModelsPage,
    }),
    globalPage("/discover", DiscoverPage),
    globalPage("/models/base/$key", BaseModelPage),
    globalPage("/models/custom/$slug", CustomModelPage),
    scopedPage("/playground", PlaygroundPage),
    scopedPage("/data", DataPage),
    scopedPage("/training", TrainingPage),
    scopedPage("/evaluations", EvaluationsPage),
    scopedPage("/feedback", FeedbackPage),
    createRoute({
        getParentRoute: () => rootRoute,
        path: "/deployments",
        validateSearch: validateMinibrain,
        beforeLoad: ({ search }) => {
            if (search.minibrain) {
                throw redirect({ href: `/deployments/${encodeURIComponent(search.minibrain)}` });
            }
        },
        component: DeploymentsPage,
    }),
    globalPage("/deployments/$slug", EndpointPage),
    globalPage("/pipelines", PipelinesPage),
    globalPage("/infrastructure", InfrastructurePage),
    globalPage("/infrastructure/$section", InfrastructurePage),
    createRoute({
        getParentRoute: () => rootRoute,
        path: "/compute",
        beforeLoad: () => {
            throw redirect({ href: "/infrastructure" });
        },
    }),
    globalPage("/monitor", MonitorPage),
    globalPage("/settings", SettingsPage),
    globalPage("/settings/security", SecurityPage),
    globalPage("/proto/logos", LogosPage),
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
