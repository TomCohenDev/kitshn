// The progress sticker of a started action (K-538): a running "Take the address" with its step list in the tip, a
// daemon update that just ended (the checkmark), a failed redeploy, and the step list in the card panel. The scenario
// puts these actions into the snapshot on its way in.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const step = (label: string, expectedMs: number, startedAt: number | null, endedAt: number | null) => ({
  label,
  expectedMs,
  startedAt,
  endedAt,
});

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { snapshot?: Record<string, unknown> };
        const snapshot = data.snapshot;
        if (snapshot) {
          const now = Date.now();
          snapshot["progress"] = {
            tick3d: {
              action: "Take the address",
              outcome: { state: "running" },
              steps: [
                step("Make kitshn's Access application", 4_000, now - 9_000, now - 6_000),
                step("Add the route to the machine's tunnel", 3_000, now - 6_000, now - 4_000),
                step("Wait until T3 has kitshn's audience", 2_000, now - 4_000, now - 3_000),
                step("Wait until Access answers on the address", 15_000, now - 3_000, null),
                step("Move the DNS record to the tunnel", 2_000, null, null),
              ],
            },
            "kitshn-repo": {
              action: "Redeploy",
              outcome: { state: "done", at: now },
              steps: [
                step("Wait until vps takes the job", 2_000, now - 30_000, now - 29_000),
                step("Start the last build again on vps", 20_000, now - 29_000, now),
              ],
            },
            vps: {
              action: "Update daemon",
              outcome: {
                state: "failed",
                at: now,
                reason: "The new daemon did not reach kitshn within 5 minutes.",
              },
              steps: [
                step("Wait until vps is online and idle", 2_000, now - 400_000, now - 399_000),
                step("Download and check the new daemon", 20_000, now - 399_000, now - 385_000),
                step("Restart on the new release", 15_000, now - 385_000, null),
                step("Keep the new connection up for 3 minutes", 180_000, null, null),
              ],
            },
          };
        }
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    // Zoom in between the machine vps and tick3d, so the stickers read.
    const vps = await page.locator('[data-card="vps"]').first().boundingBox();
    const tick3d = await page.locator('[data-card="tick3d"]').first().boundingBox();
    if (!vps || !tick3d) throw new Error("The demo cards vps and tick3d are not on the map.");
    await page.mouse.move((vps.x + tick3d.x + tick3d.width) / 2, (vps.y + tick3d.y) / 2 + 40);
    await page.keyboard.down("Control");
    for (let turn = 0; turn < 2; turn++) await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await page.waitForTimeout(600);
    await shot("cards");
    await page.locator('[data-card="tick3d"] .sticker.action-progress').first().hover();
    await page.waitForTimeout(900);
    await shot("tip-running");
    await page.locator('[data-card="vps"] .sticker.action-progress').first().hover();
    await page.waitForTimeout(900);
    await shot("tip-failed");
    await page.locator('[data-card="vps"] .sticker.action-progress').first().click();
    await page.locator(".progress-steps").first().waitFor();
    await shot("panel-failed");
  },
} satisfies Scenario;
