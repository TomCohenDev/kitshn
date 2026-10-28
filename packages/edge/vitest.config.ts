import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // The UI tests render Preact components (menu.test.ts).
        oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
        test: { name: "node", include: ["src/**/*.test.ts"] },
      },
      {
        // The Worker and its Durable Object, in workerd through Miniflare.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // The tests check real Access tokens, so they turn off DEV_IDENTITY of a local .dev.vars.
            miniflare: {
              bindings: {
                KITSHN_HOST: "kit.example.com",
                KITSHN_ZONE: "example.com",
                ACCESS_TEAM_DOMAIN: "team.example.com",
                ACCESS_ADMIN_AUD: "admin-aud",
                ACCESS_AGENT_AUD: "agent-aud",
                DEV_IDENTITY: "",
                DEV_DEMO: "",
              },
            },
          }),
        ],
        test: { name: "workers", include: ["test/**/*.test.ts"] },
      },
    ],
  },
});
