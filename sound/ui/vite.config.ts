// LiveStage Sound screens: the operator app (index.html) and the backstage phone page (backstage.html).
// Built into sound/dist/, which the service serves. `pnpm sound:dev` serves them with hot reload on 1452
// and forwards the API and WebSocket to a running service (pnpm sound:serve).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const here = import.meta.dirname;
const service = `http://127.0.0.1:${process.env.SOUND_HTTP_PORT ?? 1450}`;

export default defineConfig({
  root: here,
  base: "./",
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1452,
    strictPort: true,
    proxy: { "/api": service, "/photos": service, "/ws": { target: service.replace("http", "ws"), ws: true } },
  },
  build: {
    outDir: path.resolve(here, "../dist"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: { input: { index: path.resolve(here, "index.html"), backstage: path.resolve(here, "backstage.html") } },
  },
});
