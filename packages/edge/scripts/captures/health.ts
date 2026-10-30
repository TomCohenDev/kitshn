// The health check (K-630, K-631): the grid in the Machines view with a red link and its tip, a "Check now" that
// runs on the VPS, an offline machine whose row is unknown, and the "checks red" sticker on the machine card. The
// demo machines are offline, so the scenario gives them reports on their way in.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const ACCESS_REFUSED = "Access refused this machine's token";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          snapshot?: Record<string, unknown> & {
            machines: Array<Record<string, unknown> & { machine: Record<string, unknown> & { id: string } }>;
          };
        };
        const snapshot = data.snapshot;
        if (snapshot) {
          const now = Date.now();
          const ok = (provider: string) => ({ provider, failures: 0, since: null, error: null });
          const link = (machineId: string, error: string | null) => ({
            provider: "t3",
            machineId,
            status: error === null ? 200 : 302,
            ms: 140,
            failures: error === null ? 0 : 2,
            since: error === null ? null : now - 12 * 60_000,
            error,
          });
          const status = (hostname: string) => ({
            version: "dev",
            os: "Linux 6.8",
            arch: "arm64",
            hostname,
            tunnel: "running",
            capabilities: ["health"],
          });
          for (const view of snapshot.machines) {
            if (view.machine.id === "mac")
              Object.assign(view, {
                online: true,
                lastSeen: now,
                status: status("mac"),
                health: {
                  at: now - 3 * 60_000,
                  providers: [ok("t3")],
                  links: [link("vps", ACCESS_REFUSED), link("win", null)],
                },
              });
            if (view.machine.id === "vps")
              Object.assign(view, {
                online: true,
                lastSeen: now,
                status: status("vps"),
                health: { at: now - 3 * 60_000, providers: [ok("t3")], links: [link("mac", null)] },
              });
          }
          const win = snapshot.machines[0]!;
          snapshot.machines.push({
            ...win,
            machine: { ...win.machine, id: "win", name: "Windows", order: 2 },
            online: false,
            lastSeen: now - 40 * 60_000,
            health: null,
          });
          snapshot["progress"] = {
            vps: {
              action: "Check now",
              retry: null,
              canDismiss: true,
              outcome: { state: "running" },
              steps: [
                {
                  label: "Check the providers and the links",
                  expectedMs: 3_000,
                  startedAt: now - 1_000,
                  endedAt: null,
                },
              ],
            },
          };
        }
        socket.send(JSON.stringify(data));
      });
    });
    await page.goto(`${new URL(page.url()).origin}/#machines`);
    await page.reload();
    await page.getByText("Check now").first().waitFor();
    await shot("grid");
    await page.locator(".health-cell.bad").first().hover();
    await page.getByText(ACCESS_REFUSED).first().waitFor();
    await shot("grid-tip");
    await page.goto(`${new URL(page.url()).origin}/#map`);
    const sticker = page.locator('[data-card="mac"]').getByText("check red").first();
    await sticker.hover();
    await page.getByText("Health check (K-631)").first().waitFor();
    await shot("card-sticker");
  },
} satisfies Scenario;
