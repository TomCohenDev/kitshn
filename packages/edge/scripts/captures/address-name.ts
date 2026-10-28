// The "Name" field of a page card (K-1120), its "Set address…" menu entry, and the read-only note on a card that a
// repo deploys. The demo page has no address and the demo has no deploys, so the scenario adds both on their way in.
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP, PHONE],
  run: async ({ page, view, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          type: string;
          snapshot?: {
            resources: Array<{ id: string; addresses: Array<string> }>;
            deployedCards: Array<string>;
          };
        };
        if (data.snapshot) data.snapshot.deployedCards = ["riffle"];
        for (const resource of data.snapshot?.resources ?? [])
          if (resource.id === "ci-times") resource.addresses = ["pages.example.com/calm-otter-42"];
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    const card = page.locator(".card", { hasText: "CI time table" }).first();
    if (view.touch) {
      await page.locator(".tray-toggle").tap();
      await card.tap();
    } else await card.click();
    const field = page.getByRole("textbox", { name: "Address name" });
    await field.waitFor();
    await shot("field");
    if (view.touch) return;
    await card.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Set address…" }).waitFor();
    await shot("menu");
    await page.keyboard.press("Escape");
    // riffle is a stack of three: the first click spreads it, the second selects the card.
    await page.locator('[data-card="riffle"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-card="riffle"]').first().click();
    await page.getByText("Its repo sets this address").waitFor();
    await shot("repo");
  },
} satisfies Scenario;
