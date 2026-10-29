import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { Shell } from "./components/Shell";
import { DataPage } from "./pages/DataPage";
import { EndpointPage } from "./pages/EndpointPage";
import { HomePage } from "./pages/HomePage";
import { MinibrainLayout } from "./pages/MinibrainLayout";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { VersionsPage } from "./pages/VersionsPage";

const rootRoute = createRootRoute({ component: Shell });

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });

const minibrainRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/m/$slug",
    component: MinibrainLayout,
});

const minibrainIndexRoute = createRoute({
    getParentRoute: () => minibrainRoute,
    path: "/",
    beforeLoad: ({ params }) => {
        throw redirect({ to: "/m/$slug/data", params });
    },
});

const dataRoute = createRoute({
    getParentRoute: () => minibrainRoute,
    path: "data",
    component: DataPage,
});
const versionsRoute = createRoute({
    getParentRoute: () => minibrainRoute,
    path: "versions",
    component: VersionsPage,
});
const playgroundRoute = createRoute({
    getParentRoute: () => minibrainRoute,
    path: "playground",
    component: PlaygroundPage,
});
const endpointRoute = createRoute({
    getParentRoute: () => minibrainRoute,
    path: "endpoint",
    component: EndpointPage,
});

const routeTree = rootRoute.addChildren([
    homeRoute,
    minibrainRoute.addChildren([
        minibrainIndexRoute,
        dataRoute,
        versionsRoute,
        playgroundRoute,
        endpointRoute,
    ]),
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}
