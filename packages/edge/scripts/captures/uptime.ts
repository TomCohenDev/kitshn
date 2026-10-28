// Uptime (K-1125, K-1126): a down card on the map, and the card panel with its strip of the last 24 hours. The demo
// has no checks, so the scenario adds the uptime to the snapshots and answers the changes itself.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const now = Date.now();
const hour = 3_600_000;
const uptime = {
  riffle: { up: false, since: now - 25 * 60_000 },
  tick3d: { up: true, since: now - 30 * hour },
};
const changes = [
  { at: now - 30 * hour, up: true },
  { at: now - 9 * hour, up: false },
  { at: now - 8 * hour, up: true },
  { at: now - 25 * 60_000, up: false },
];

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.route(/\/api\/uptime\/riffle$/, (route) => route.fulfill({ json: changes }));
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { type: string; snapshot?: Record<string, unknown> };
        if (data.type === "snapshot" && data.snapshot) data.snapshot["uptime"] = uptime;
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    await page
      .locator(".name", { hasText: /^riffle$/ })
      .filter({ visible: true })
      .first()
      .click();
    await page.waitForTimeout(800);
    await shot("down");
  },
} satisfies Scenario;
