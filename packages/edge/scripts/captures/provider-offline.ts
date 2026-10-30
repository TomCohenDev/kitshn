// A provider without a connection (K-704, K-515): the "t3 offline since <time>" sticker with its tip, and the line
// in the machine panel. The demo machines are offline, so the scenario gives the Mac a state on its way in.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          snapshot?: { machines: Array<Record<string, unknown> & { machine: { id: string } }> };
        };
        for (const view of data.snapshot?.machines ?? [])
          if (view.machine.id === "mac")
            Object.assign(view, {
              online: true,
              lastSeen: Date.now(),
              status: {
                version: "dev",
                os: "darwin 25.6.0",
                arch: "arm64",
                hostname: "mac",
                tunnel: "running",
                offlineProviders: [
                  { provider: "t3", reason: "the connection closed", at: Date.now() - 23 * 60_000 },
                ],
              },
            });
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    const sticker = page.locator('[data-card="mac"]').getByText("t3 offline since").first();
    await sticker.hover();
    await page.getByText("Provider t3 offline since").first().waitFor();
    await shot("card-sticker");
    await sticker.click();
    await page.getByText("the connection closed").first().waitFor();
    await shot("panel-line");
  },
} satisfies Scenario;
