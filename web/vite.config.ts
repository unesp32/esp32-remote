import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

/**
 * Vite only knows how to *bundle*.
 *
 * What runs on Cloudflare (entrypoint, bindings, the `esp.virt.cc.cd` domain)
 * lives in `cloudflare.config.ts`; the plugin picks that file up
 * automatically, so there is deliberately nothing Cloudflare-specific here.
 */
export default defineConfig({
  plugins: [cloudflare()],
  build: {
    // Source maps keep the shipped browser code debuggable without shipping
    // the original TypeScript sources.
    sourcemap: true,
    target: "es2022",
  },
});
