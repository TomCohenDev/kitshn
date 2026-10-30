// A refused provider (K-704): the "kitshn refused T3" sticker with its tip, and the reason in the machine panel. The
// demo machines are offline, so the scenario gives the Mac a state on its way in.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const REASON =
  'The request does not match K-702: Expected a value with a length of at most 64 at ["resources"][0]["lists"][0]["rows"][4]["id"]';

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
                refusedProviders: [{ provider: "t3", reason: REASON, at: Date.now() - 12 * 60_000 }],
              },
            });
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    const sticker = page.locator('[data-card="mac"]').getByText("kitshn refused T3").first();
    await sticker.hover();
    await page.getByText("sent a list row id over 64 characters").first().waitFor();
    await shot("card-sticker");
    await sticker.click();
    await page.getByText("Details").first().waitFor();
    await shot("panel-reason");
  },
} satisfies Scenario;
