import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initAppTheme } from "./lib/theme";
import { router } from "./router";
import "./styles.css";

initAppTheme();

const queryClient = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 1000 } },
});

const root = document.getElementById("root");
if (root) {
    createRoot(root).render(
        <StrictMode>
            <QueryClientProvider client={queryClient}>
                <RouterProvider router={router} />
            </QueryClientProvider>
        </StrictMode>,
    );
}
