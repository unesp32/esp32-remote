/**
 * Cloudflare project configuration for esp32-remote.
 *
 * Read by the `cf` CLI (`cf build`, `cf deploy`, `cf dev`). Kept separate from
 * `vite.config.ts`: this file describes *what runs where* (worker entrypoint,
 * bindings, routes), while Vite only describes *how to bundle it*.
 *
 * The entrypoint is vinext's fetch handler: the App Router in `app/` is
 * compiled into the Worker, so there is no hand-written `src/index.ts`
 * dispatching requests any more.
 */
import { bindings, defineConfig, defineWorker } from "cf/config";

const worker = defineWorker({
  name: "esp32-remote",
  compatibilityDate: "2026-11-01",

  // vinext owns request handling: App Router pages, server components, server
  // actions and `app/api/**/route.ts` all run behind this handler.
  entrypoint: "vinext/server/fetch-handler",

  // Route everything through the Worker except the hashed build output, which
  // is served straight from Workers Static Assets — that is most static
  // traffic, so it costs no invocation. `vinext init` generates exactly these
  // patterns; keep both exclusions or `/_next/static/*` returns 404.
  assets: {
    htmlHandling: "none",
    notFoundHandling: "none",
    runWorkerFirst: [
      "/*",
      "!/_next/static/*",
      "!/*/_next/static/*",
      "!/manifest.webmanifest",
      "!/sw.js",
      "!/icons/*",
    ],
  },

  // Custom domain on the `virt.cc.cd` zone (no `*.workers.dev` reliance).
  domains: ["esp.virt.cc.cd"],

  env: {
    // Created on first `cf deploy`; named binding used through `cloudflare:workers`.
    DB: bindings.d1({ name: "esp32-remote" }),
  },

  observability: {
    enabled: true,
    logs: { enabled: true, persist: true },
  },
});

export default defineConfig({ worker });
