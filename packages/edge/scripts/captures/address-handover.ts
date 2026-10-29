// Take an address over (K-1623): a T3 provider card whose address the portal still serves, with the sticker
// "address in use", its "Take the address…" action and the confirm. The scenario turns the demo card tick3d into
// such a card in the snapshot.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { snapshot?: Record<string, unknown> };
        const snapshot = data.snapshot;
        if (snapshot) {
          snapshot["resources"] = (snapshot["resources"] as Array<Record<string, unknown>>).map((item) =>
            item["id"] === "tick3d"
              ? {
                  ...item,
                  kind: "t3.app",
                  name: "T3 on vps",
                  addresses: [],
                  status: "running",
                  machine: "vps",
                  provider: {
                    name: "t3",
                    localId: "app",
                    kindName: "T3 app",
                    levels: { view: "read", use: "standard", control: "admin" },
                    facts: [],
                    stickers: [{ text: "address in use", tone: "warn" }],
                    lists: [],
                    settings: [],
                    site: "t3-vps",
                  },
                }
              : item,
          );
          snapshot["addressHolds"] = { tick3d: "in-use" };
        }
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    await page.locator('[data-card="tick3d"]').first().click();
    await page.waitForTimeout(600);
    await shot("card-panel");
    await page.locator('[data-card="tick3d"]').first().click({ button: "right" });
    await page.waitForTimeout(600);
    const take = page.getByText("Take the address…", { exact: true }).filter({ visible: true }).first();
    await take.hover();
    await page.waitForTimeout(900);
    await shot("card-menu");
    await take.click();
    await page.waitForTimeout(600);
    await shot("confirm");
  },
} satisfies Scenario;
