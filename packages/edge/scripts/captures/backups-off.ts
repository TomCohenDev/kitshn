// Backups off (K-1815): without KITSHN_BACKUP_KEY the card of a Compose app says so, instead of "the first runs
// tonight". The scenario sets the flag in the snapshots.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { type: string; snapshot?: Record<string, unknown> };
        if (data.type === "snapshot" && data.snapshot) {
          data.snapshot["backups"] = {};
          data.snapshot["backupsOff"] = true;
        }
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
    await page.getByRole("button", { name: "Back up now" }).scrollIntoViewIfNeeded();
    await shot("card");
  },
} satisfies Scenario;
