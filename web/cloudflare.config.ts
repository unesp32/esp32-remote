/**
 * Cloudflare project configuration for esp32-remote.
 *
 * Read by the `cf` CLI (`cf build`, `cf deploy`, `cf dev`). Kept separate from
 * `vite.config.ts`: this file describes *what runs where* (worker entrypoint,
 * bindings, routes), while Vite only describes *how to bundle it*.
 *
 * Bindings are constructed with `bindings.*` from `cf/config` so they stay
 * type-checked against the Worker's `env`.
 */
import { bindings, defineConfig, defineWorker } from "cf/config";

const worker = defineWorker({
  name: "esp32-remote",
  compatibilityDate: "2026-11-01",

  // The Worker serves the JSON API; everything else falls through to the
  // static asset bundle produced by Vite from `index.html` + `public/`.
  entrypoint: "./src/index.ts",
  assets: {
    // Route only the API to the Worker, so assets keep their CDN caching.
    runWorkerFirst: ["/api/*"],
    notFoundHandling: "single-page-application",
  },

  // Custom domain on the `virt.cc.cd` zone (no `*.workers.dev` reliance).
  domains: ["esp.virt.cc.cd"],

  env: {
    // Created on first `cf deploy`; named binding used by `src/index.ts`.
    DB: bindings.d1({ name: "esp32-remote" }),
  },

  observability: {
    enabled: true,
    logs: { enabled: true, persist: true },
  },
});

export default defineConfig({ worker });
