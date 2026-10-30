// More progress stickers (K-538): a static deploy that uploads its files, and "Roll back this run" on its second card,
// each with its step list in the tip. The scenario puts these actions into the snapshot on its way in.
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
              action: "Deploy",
              retry: null,
              canDismiss: true,
              outcome: { state: "running" },
              steps: [
                step("Build in GitHub Actions", 30_000, now - 40_000, now - 6_000),
                step("Upload the files to Cloudflare", 10_000, now - 6_000, null),
                step("Make the new version live", 5_000, null, null),
              ],
            },
            "kitshn-repo": {
              action: "Roll back this run",
              retry: null,
              canDismiss: true,
              outcome: { state: "running" },
              steps: [
                step("Roll back kitshn site", 3_000, now - 8_000, now - 6_000),
                step("Roll back kitshn", 25_000, now - 6_000, null),
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
    for (const card of ["tick3d", "kitshn-repo"]) {
      await page.locator(`[data-card="${card}"] .sticker.action-progress`).first().hover();
      await page.waitForTimeout(900);
      await shot(`tip-${card}`);
    }
  },
} satisfies Scenario;
