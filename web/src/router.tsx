import {
    type AnyRoute,
    type RouteComponent,
    createRootRoute,
    createRoute,
    createRouter,
    lazyRouteComponent,
} from "@tanstack/react-router";
import type { Role } from "./api/authQueries";
import { NeedsRole } from "./components/NeedsRole";
import { Shell } from "./components/Shell";
import { API_REFERENCE_PATH, MANAGEMENT_REFERENCE_PATH } from "./lib/modelLinks";
import { DataPage } from "./pages/DataPage";
import { DeploymentPage, DeploymentsPage } from "./pages/DeploymentsPage";
import { EvaluationsPage } from "./pages/EvaluationsPage";
import { FeedbackPage } from "./pages/FeedbackPage";
import { HomePage } from "./pages/HomePage";
import { InfrastructurePage } from "./pages/InfrastructurePage";
import { DiscoverPage, ModelsPage } from "./pages/ModelsPage";
import { MonitorPage } from "./pages/MonitorPage";
import { PipelinesPage } from "./pages/PlaceholderPages";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { SecurityPage } from "./pages/SecurityPage";
import { SettingsPage } from "./pages/SettingsPage";
import { JobPage } from "./pages/jobs/JobPage";
import { AddModelPage } from "./pages/models/AddModelPage";
import { DiscoverComparePage } from "./pages/models/DiscoverCompare";
import { DiscoverModelPage } from "./pages/models/DiscoverModelPage";
import { ModelCardPage } from "./pages/models/ModelCardPage";
import { ModelPage, OldModelLink } from "./pages/models/detail/ModelPage";
import { AccountsSettingsPage } from "./pages/settings/AccountsSettingsPage";
import { AuditLogPage } from "./pages/settings/AuditLogPage";
import { ConnectionsSettingsPage } from "./pages/settings/ConnectionsSettingsPage";
import { DataSettingsPage } from "./pages/settings/DataSettingsPage";
import { InstallSettingsPage } from "./pages/settings/InstallSettingsPage";
import { StorageSettingsPage } from "./pages/settings/StorageSettingsPage";
import { ModelTrainingPage, TrainingListPage } from "./pages/training/TrainingPages";

const rootRoute = createRootRoute({ component: Shell });

const ApiReferencePage = lazyRouteComponent(
    () => import("./pages/developers/ApiReferencePage"),
    "ApiReferencePage",
);

function globalPage(path: string, component: RouteComponent): AnyRoute {
    return createRoute({ getParentRoute: () => rootRoute, path, component });
}

function prototypePages(): AnyRoute[] {
    if (!import.meta.env.DEV) {
        return [];
    }
    const logos = lazyRouteComponent(() => import("./pages/proto/LogosPage"), "LogosPage");
    const modelIcons = lazyRouteComponent(
        () => import("./pages/proto/ModelIconsPage"),
        "ModelIconsPage",
    );
    return [
        globalPage("/proto/logos", logos),
        globalPage("/proto/model-icons", modelIcons),
        globalPage("/proto/models-flow", flow("FlowRedirect")),
        globalPage("/proto/models-flow/$", flow("FlowRedirect")),
        flowRoutes(),
    ];
}

type FlowPages = typeof import("./pages/proto/flowRoutes");

function flow(name: keyof FlowPages): RouteComponent {
    return lazyRouteComponent(() => import("./pages/proto/flowRoutes"), name);
}

function flowRoutes(): AnyRoute {
    const layout = createRoute({
        getParentRoute: () => rootRoute,
        path: "/proto/flow",
        component: flow("FlowShell"),
    });
    const page = (path: string, name: keyof FlowPages) =>
        createRoute({ getParentRoute: () => layout, path, component: flow(name) });
    return layout.addChildren([
        page("/", "FlowHomePage"),
        page("models", "ModelsFlowPage"),
        page("models/new", "FlowAddModelPage"),
        page("models/$model", "FlowModelPage"),
        page("models/$model/compare", "ModelsFlowComparePage"),
        page("models/$model/versions/$version", "ModelsFlowVersionPage"),
        page("models/$model/versions/$version/$tab", "ModelsFlowVersionPage"),
        page("models/$model/$tab", "FlowModelPage"),
        page("training", "FlowTrainingPage"),
        page("data", "FlowDataPage"),
        page("data/$dataset", "FlowDatasetPage"),
        page("discover", "FlowDiscoverPage"),
        page("discover/$id", "FlowCatalogPage"),
        page("playground", "FlowPlaygroundPage"),
        page("monitor", "FlowMonitorPage"),
        page("monitor/jobs", "FlowOldJobsRedirect"),
        page("jobs", "FlowJobsPage"),
        page("evaluations", "FlowEvaluationsPage"),
        page("jobs/$id", "FlowJobPage"),
        page("feedback", "FlowFeedbackPage"),
        page("infrastructure", "FlowInfrastructurePage"),
        page("settings", "FlowSettingsPage"),
    ]);
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

const routeTree = rootRoute.addChildren([
    globalPage("/", HomePage),
    globalPage("/models", ModelsPage),
    globalPage("/discover", DiscoverPage),
    globalPage("/discover/compare", DiscoverComparePage),
    globalPage("/discover/$id", DiscoverModelPage),
    globalPage("/models/new", guarded("builder", AddModelPage)),
    globalPage("/models/base/$key", OldModelLink),
    globalPage("/models/custom/$slug", OldModelLink),
    globalPage("/models/custom/$slug/versions/$number/card", OldModelLink),
    globalPage("/models/$name", ModelPage),
    globalPage("/models/$name/$tab", ModelPage),
    globalPage("/models/$name/versions/$number/card", ModelCardPage),
    globalPage("/playground", PlaygroundPage),
    globalPage("/data", guarded("builder", DataPage)),
    globalPage("/training", TrainingListPage),
    globalPage("/training/$slug", guarded("builder", ModelTrainingPage)),
    globalPage("/jobs/$id", JobPage),
    globalPage("/evaluations", EvaluationsPage),
    globalPage("/feedback", guarded("builder", FeedbackPage)),
    globalPage("/deployments", DeploymentsPage),
    globalPage("/deployments/$slug", DeploymentPage),
    globalPage("/pipelines", PipelinesPage),
    globalPage("/infrastructure", InfrastructurePage),
    globalPage("/infrastructure/$section", InfrastructurePage),
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
    ...prototypePages(),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}
