import { defineApps } from "kitshn";

// The kitshn site (site/), a static site with no build. kitshn-site.<zone> is the main address (K-817).
export default defineApps({
  site: {
    static: { output: "site" },
    deploy: [
      {
        on: "push",
        branch: "main",
        name: "prod",
        address: ["kitshn-site.yarden-zamir.com", "kitshn.com"],
        startsIn: "Everyone",
      },
      { on: "pull_request", name: "pr-{pr}", ephemeral: true },
    ],
  },
});
