// The daemon update of a busy machine waits (K-627, K-628): the "update waits" sticker on the card of the demo
// machine vps, with its tip. The scenario sets the update of that machine in the snapshot.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    const until = Date.now() + 80 * 60 * 1000;
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          snapshot?: { machines: Array<Record<string, unknown>> };
        };
        if (data.snapshot)
          data.snapshot.machines = data.snapshot.machines.map((view) =>
            (view["machine"] as { id: string }).id === "vps"
              ? { ...view, update: { state: "waiting", reason: "busy", until } }
              : view,
          );
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    const sticker = page.getByText("update waits", { exact: true }).filter({ visible: true }).first();
    await sticker.hover();
    await page.waitForTimeout(900);
    await shot("card");
  },
} satisfies Scenario;
