// The Usage view (K-1303): the free plan limits of the demo account and the machine samples, in the panel and full.
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

const samples: Record<string, { cpu: number; memory: number; disk: number }> = {
  mac: { cpu: 0.22, memory: 0.64, disk: 0.41 },
  vps: { cpu: 0.48, memory: 0.83, disk: 0.91 },
};

export default {
  views: [DESKTOP, PHONE],
  run: async ({ page, shot }) => {
    // The demo machines are offline; the scenario gives them a latest sample, as a running daemon does.
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { type: string; snapshot?: Record<string, unknown> };
        if (data.type === "snapshot" && data.snapshot)
          data.snapshot["machines"] = (data.snapshot["machines"] as Array<{ machine: { id: string } }>).map(
            (view) => {
              const sample = samples[view.machine.id];
              return sample ? { ...view, sample: { at: Date.now(), ...sample } } : view;
            },
          );
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.goto(`${page.url().split("#")[0]}#usage`);
    await page.locator(".usage-view .gauge").first().waitFor();
    await shot("full");
  },
} satisfies Scenario;
