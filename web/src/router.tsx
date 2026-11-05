import {
    type AnyRoute,
    type RouteComponent,
    createRootRoute,
    createRoute,
    createRouter,
    lazyRouteComponent,
    redirect,
} from "@tanstack/react-router";
import type { Role } from "./api/authQueries";
import { NeedsRole } from "./components/NeedsRole";
import { Shell } from "./components/Shell";
import { hrefWith } from "./lib/listSearch";
import {
    API_REFERENCE_PATH,
    MANAGEMENT_REFERENCE_PATH,
    deploymentPageHref,
    evaluationsHref,
    modelDataHref,
    playgroundHref,
} from "./lib/modelLinks";
import { DataPage } from "./pages/DataPage";
import { DeploymentPage, DeploymentsPage } from "./pages/DeploymentsPage";
import { EvaluationsPage } from "./pages/EvaluationsPage";
import { FeedbackPage } from "./pages/FeedbackPage";
import { HomePage } from "./pages/HomePage";
import { InfrastructurePage } from "./pages/InfrastructurePage";
import { BaseModelPage, CustomModelPage } from "./pages/ModelDetailPage";
import { DiscoverPage, ModelsPage } from "./pages/ModelsPage";
import { MonitorPage } from "./pages/MonitorPage";
import { PipelinesPage } from "./pages/PlaceholderPages";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { SecurityPage } from "./pages/SecurityPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AddModelPage } from "./pages/models/AddModelPage";
import { DiscoverComparePage } from "./pages/models/DiscoverCompare";
import { DiscoverModelPage } from "./pages/models/DiscoverModelPage";
import { ModelCardPage } from "./pages/models/ModelCardPage";
import { LogosPage } from "./pages/proto/LogosPage";
import { AccountsSettingsPage } from "./pages/settings/AccountsSettingsPage";
import { AuditLogPage } from "./pages/settings/AuditLogPage";
import { ConnectionsSettingsPage } from "./pages/settings/ConnectionsSettingsPage";
import { DataSettingsPage } from "./pages/settings/DataSettingsPage";
import { InstallSettingsPage } from "./pages/settings/InstallSettingsPage";
import { StorageSettingsPage } from "./pages/settings/StorageSettingsPage";
import { ModelTrainingPage, TrainingListPage } from "./pages/training/TrainingPages";

const LEGACY_TABS: Record<string, (slug: string) => string> = {
    data: modelDataHref,
    versions: evaluationsHref,
    playground: playgroundHref,
    endpoint: deploymentPageHref,
};

const rootRoute = createRootRoute({ component: Shell });

const ApiReferencePage = lazyRouteComponent(
    () => import("./pages/developers/ApiReferencePage"),
    "ApiReferencePage",
);

function globalPage(path: string, component: RouteComponent): AnyRoute {
    return createRoute({ getParentRoute: () => rootRoute, path, component });
}

function guarded(role: Role, Component: RouteComponent): RouteComponent {
    return function Guarded() {
        return (
            <NeedsRole role={role}>
                <Component />
            </NeedsRole>
        );
    };
}

function unscopedPage(path: string, component: RouteComponent, keepModel = true): AnyRoute {
    return createRoute({
        getParentRoute: () => rootRoute,
        path,
        beforeLoad: ({ location }) => {
            const params = new URLSearchParams(location.searchStr);
            const minibrain = params.get("minibrain");
            if (minibrain === null) {
                return;
            }
            params.delete("minibrain");
            if (keepModel && minibrain && !params.has("model")) {
                params.set("model", minibrain);
            }
            throw redirect({ href: hrefWith(path, params) });
        },
        component,
    });
}

function legacyHref(slug: string, tab: string): string {
    return (LEGACY_TABS[tab] ?? modelDataHref)(slug);
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
    globalPage("/discover/compare", DiscoverComparePage),
    globalPage("/discover/$id", DiscoverModelPage),
    globalPage("/models/new", guarded("builder", AddModelPage)),
    globalPage("/models/base/$key", BaseModelPage),
    globalPage("/models/custom/$slug", CustomModelPage),
    globalPage("/models/custom/$slug/versions/$number/card", ModelCardPage),
    unscopedPage("/playground", PlaygroundPage),
    globalPage("/data", guarded("builder", DataPage)),
    createRoute({
        getParentRoute: () => rootRoute,
        path: "/data/datasets/$slug",
        beforeLoad: ({ params }) => {
            throw redirect({ href: `/data?item=dataset:${encodeURIComponent(params.slug)}` });
        },
    }),
    unscopedPage("/training", TrainingListPage),
    globalPage("/training/$slug", guarded("builder", ModelTrainingPage)),
    unscopedPage("/evaluations", EvaluationsPage),
    unscopedPage("/feedback", guarded("builder", FeedbackPage), false),
    createRoute({
        getParentRoute: () => rootRoute,
        path: "/deployments",
        beforeLoad: ({ location }) => {
            const minibrain = new URLSearchParams(location.searchStr).get("minibrain");
            if (minibrain) {
                throw redirect({ href: deploymentPageHref(minibrain) });
            }
        },
        component: DeploymentsPage,
    }),
    globalPage("/deployments/$slug", DeploymentPage),
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
    globalPage("/monitor/jobs", MonitorPage),
    globalPage("/monitor/requests", MonitorPage),
    globalPage(API_REFERENCE_PATH, ApiReferencePage),
    globalPage(MANAGEMENT_REFERENCE_PATH, ApiReferencePage),
    globalPage("/settings", SettingsPage),
    globalPage("/settings/security", guarded("admin", SecurityPage)),
    globalPage("/settings/accounts", guarded("admin", AccountsSettingsPage)),
    globalPage("/settings/audit", guarded("admin", AuditLogPage)),
    globalPage("/settings/data", guarded("admin", DataSettingsPage)),
    globalPage("/settings/storage", guarded("admin", StorageSettingsPage)),
    globalPage("/settings/connections", guarded("admin", ConnectionsSettingsPage)),
    globalPage("/settings/install", guarded("admin", InstallSettingsPage)),
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
