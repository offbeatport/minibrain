import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = "http://127.0.0.1:8000";

export default defineConfig({
    resolve: {
        dedupe: ["react", "react-dom"],
        alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    plugins: [tailwindcss(), react()],
    server: {
        port: 5173,
        proxy: { "/api": api, "/v1": api },
    },
    build: { target: "safari16" },
});
