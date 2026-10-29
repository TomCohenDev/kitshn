// Cancel a queued job (K-1612): the machine panel of the demo machine vps with one queued job and its "Cancel" button.
// The scenario adds the job to the demo snapshot.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const job = {
  id: 41,
  machineId: "vps",
  labels: [],
  command: { kind: "restart" },
  state: "queued",
  createdAt: Date.UTC(2026, 9, 29, 15, 0),
  expiresAt: Date.UTC(2026, 9, 30, 15, 0),
  actor: "owner@example.com",
  exitCode: null,
  output: "",
};

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { snapshot?: { jobs: Array<unknown> } };
        if (data.snapshot) data.snapshot.jobs = [job, ...data.snapshot.jobs];
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    await page.locator('[data-card="vps"]').first().click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Cancel", exact: true }).first().scrollIntoViewIfNeeded();
    await shot("machine-panel");
  },
} satisfies Scenario;
