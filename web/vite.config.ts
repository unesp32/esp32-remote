import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import vinext from "vinext";

/**
 * Vite only knows how to *bundle*.
 *
 * `vinext()` re-implements the Next.js App Router on top of Vite (that is what
 * `app/` is), and `cloudflare()` turns the result into Cloudflare Build Output.
 * What actually *runs* on Cloudflare — Worker name, the `esp.virt.cc.cd`
 * domain, the D1 binding — lives in `cloudflare.config.ts`, which the plugin
 * picks up automatically, so there is deliberately nothing
 * Cloudflare-account-specific here.
 */
export default defineConfig({
  plugins: [
    vinext(),
    // The Worker entry runs in the RSC environment, with SSR as a child —
    // that split is what makes `cloudflare:workers` (and therefore the D1
    // binding) resolvable inside server components and route handlers.
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
  build: {
    // Source maps keep the shipped browser code debuggable without shipping
    // the original TypeScript sources.
    sourcemap: true,
    target: "es2022",
  },
});
