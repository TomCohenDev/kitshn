// Automatic daemon updates (K-626 to K-628): the card stickers UPDATING, UPDATE FAILED and UPDATED, and the setting
// in the machine panel. The demo machines are offline, so the scenario gives them a state on its way in.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const RELEASE = "0f6f4f103c31";
const OLD = "224187cf5a22";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    let phase: "rolling" | "done" = "rolling";
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          snapshot?: {
            version: string;
            machines: Array<Record<string, unknown> & { machine: { id: string } }>;
          };
        };
        const snapshot = data.snapshot;
        if (snapshot) {
          const now = Date.now();
          snapshot.version = RELEASE;
          for (const view of snapshot.machines) {
            const status = (version: string) => ({
              version,
              os: "linux",
              arch: "x64",
              hostname: view.machine.id,
              tunnel: "running",
              capabilities: ["update", "update-gz"],
            });
            if (view.machine.id === "mac")
              Object.assign(view, {
                online: phase === "done",
                lastSeen: now,
                status: phase === "done" ? status(RELEASE) : null,
                update: { state: phase === "done" ? "updated" : "updating" },
              });
            if (view.machine.id === "vps")
              Object.assign(view, {
                online: true,
                lastSeen: now,
                status: status(OLD),
                update:
                  phase === "done"
                    ? null
                    : {
                        state: "failed",
                        reason: "The new daemon did not reach kitshn within 5 minutes.",
                      },
              });
          }
        }
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.getByText("update failed").first().waitFor();
    await shot("cards-updating-failed");
    phase = "done";
    await page.reload();
    await page.getByText("updated").first().waitFor();
    await shot("cards-updated-behind");
    await page.locator('[data-card="vps"]').getByText("behind").first().click();
    await page.getByText("Update daemon automatically").first().waitFor();
    await shot("panel-setting");
  },
} satisfies Scenario;
