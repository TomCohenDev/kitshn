// "Make it a repo…" in the card menu of a page (K-1127). The demo page has no address, so the scenario gives it one.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          type: string;
          snapshot?: { resources: Array<{ id: string; addresses: Array<string> }> };
        };
        for (const resource of data.snapshot?.resources ?? [])
          if (resource.id === "ci-times") resource.addresses = ["pages.example.com/ci-times"];
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.locator(".card", { hasText: "CI time table" }).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Make it a repo…" }).waitFor();
    await shot("menu");
  },
} satisfies Scenario;
