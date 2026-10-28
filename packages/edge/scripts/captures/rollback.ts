// Rollback (K-821): the dialog of one card, the dialog of a run, and the kept builds on the machine card. The demo has
// no deploy history, so the scenario answers the rollback lists itself and adds the kept size to the snapshots.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const hour = 3_600_000;
const now = Date.parse("2026-10-28T12:00:00Z");
const choices = [
  { deployId: "d3", sha: "9f1c2ab77e", at: now, run: "4412.1", note: null, why: "This deploy serves now." },
  { deployId: "d2", sha: "41be0d913c", at: now - 26 * hour, run: "4398.1", note: null, why: null },
  {
    deployId: "d1",
    sha: "c07a55e0d1",
    at: now - 75 * hour,
    run: "4371.1",
    note: null,
    why: "The machine keeps only the build before the last one.",
  },
];
const steps = [
  { card: "riffle-web", name: "riffle-web", deployId: "w2", sha: "8d0e3f1a2b", why: null },
  { card: "riffle", name: "riffle", deployId: "d2", sha: "41be0d913c", why: null },
];

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.route(/\/api\/apps\/[^/]+\/rollbacks$/, (route) => route.fulfill({ json: { choices } }));
    await page.route(/\/api\/apps\/[^/]+\/run-rollback$/, (route) => route.fulfill({ json: { steps } }));
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { type: string; snapshot?: Record<string, unknown> };
        if (data.type === "snapshot" && data.snapshot)
          data.snapshot["machines"] = (data.snapshot["machines"] as Array<Record<string, unknown>>).map(
            (view) => ({
              ...view,
              status: {
                version: "local",
                os: "linux 6.8",
                arch: "x64",
                hostname: "vps",
                tunnel: "running",
                ...(view["status"] as object | null),
                keptBytes: 734_003_200,
              },
            }),
          );
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    const close = () => page.locator(".overlay-panel button", { hasText: "×" }).first().click();
    await page
      .locator(".name", { hasText: /^riffle$/ })
      .filter({ visible: true })
      .first()
      .click();
    await page.getByRole("button", { name: "Roll back…" }).click();
    await page.getByRole("button", { name: "Roll back to 41be0d9" }).waitFor();
    await shot("card");
    await page.locator(".scrim .dialog").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Roll back this run…" }).click();
    await page.getByRole("button", { name: "Roll back 2 cards" }).waitFor();
    await shot("run");
    await page.locator(".scrim .dialog").getByRole("button", { name: "Close", exact: true }).click();
    await close();
    await page.locator(".name", { hasText: "VPS" }).filter({ visible: true }).first().click();
    await page.getByText("kept builds up to", { exact: false }).waitFor();
    await shot("machine-kept");
  },
} satisfies Scenario;
