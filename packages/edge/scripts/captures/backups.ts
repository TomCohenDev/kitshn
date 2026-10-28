// Backups (K-1819, K-1820, K-1822): the card panel, the list of runs with Restore, and "Restore kitshn to a time". The
// demo has no machine that backs up, so the scenario adds the runs to the snapshots and answers the list itself.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const now = Date.parse("2026-10-28T12:00:00Z");
const hour = 3_600_000;
const run = (index: number, state: "done" | "failed", error: string | null = null) => ({
  run: `r${index}`,
  card: "riffle",
  machineId: "vps",
  at: now - index * 24 * hour,
  state,
  bytes: state === "done" ? 2_310_000_000 + index * 4_000_000 : null,
  added: state === "done" ? 18_000_000 : null,
  error,
});
const runs = [
  run(0, "done"),
  run(1, "failed", "restic backup of data failed (1): connection reset"),
  run(2, "done"),
  run(3, "done"),
];

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.route(/\/api\/apps\/[^/]+\/backups$/, (route) => route.fulfill({ json: { runs } }));
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { type: string; snapshot?: Record<string, unknown> };
        if (data.type === "snapshot" && data.snapshot) {
          data.snapshot["backups"] = { riffle: runs[0] };
          data.snapshot["r2Bucket"] = { bytes: 3_100_000_000, at: now };
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
    await page.getByRole("button", { name: "Backups…" }).click();
    await page.locator(".scrim .dialog").getByText("connection reset").waitFor();
    await shot("runs");
    await page.locator(".scrim .dialog").getByRole("button", { name: "Restore…" }).first().click();
    await page.getByText("Restore riffle to its backup of", { exact: false }).waitFor();
    await shot("restore-confirm");
    // The confirm holds the focus; a new load is the plain way out of it.
    await page.reload();
    await page.waitForTimeout(1500);
    await page.locator(".panic.opener").click();
    await page.getByRole("button", { name: "Restore kitshn to a time…" }).click();
    await page.getByRole("dialog", { name: "Restore kitshn to a time" }).waitFor();
    await shot("restore-time");
  },
} satisfies Scenario;
