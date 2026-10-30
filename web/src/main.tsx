import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyAnimationSettings } from "./lib/animation";
import { router } from "./router";
import "./styles.css";

applyAnimationSettings(document.documentElement);

const queryClient = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 1000 } },
});

const root = document.getElementById("root");
if (root) {
    createRoot(root).render(
        <StrictMode>
            <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
                <QueryClientProvider client={queryClient}>
                    <RouterProvider router={router} />
                </QueryClientProvider>
            </ThemeProvider>
        </StrictMode>,
    );
}
