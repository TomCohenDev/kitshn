// K-1131, K-619, K-212: a drop of "localhost:5173/app" on the map opens the site wizard with what kitshn understood,
// the running servers of an online machine, the preview and the time; and the one Upload… entry of the "+" menu.
// The demo has no daemon, so the scenario marks the first machine online with servers and serves the port itself.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const servers = [
  { port: 3000, process: "node", status: 200, title: "Grafana" },
  { port: 5173, process: "node", status: 200, title: "Trek dossier" },
  { port: 8000, process: "python3", status: 404, title: null },
];
const page5173 = `<!doctype html><body style="margin:0;font:28px system-ui;background:#fef3c7"><header style="padding:24px;background:#0f766e;color:#fff"><b>Trek dossier</b></header><h1 style="padding:24px">Day 1: the pass</h1></body>`;

type View = { machine: { id: string }; online: boolean; servers?: unknown };

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    let first: string | null = null;
    const online = (view: View) =>
      (first ??= view.machine.id) === view.machine.id ? { ...view, online: true, servers } : view;
    await page.route(/^http:\/\/localhost:5173\//, (route) =>
      route.fulfill({ contentType: "text/html", body: page5173 }),
    );
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          type: string;
          snapshot?: { machines: Array<View> };
          view?: View;
        };
        if (data.type === "snapshot" && data.snapshot)
          data.snapshot.machines = data.snapshot.machines.map(online);
        if (data.type === "machine" && data.view) data.view = online(data.view);
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.locator(".world > [data-card]").first().waitFor();
    const transfer = await page.evaluateHandle(
      `(() => { const data = new DataTransfer(); data.setData("text/plain", "http://localhost:5173/app"); return data; })()`,
    );
    await page.locator(".viewport").dispatchEvent("dragover", { dataTransfer: transfer });
    await page.locator(".viewport").dispatchEvent("drop", { dataTransfer: transfer });
    await page.getByRole("dialog", { name: "Add a site" }).waitFor();
    await page.waitForTimeout(1200);
    await shot("drop-wizard");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Add" }).click();
    await page.getByRole("menuitem", { name: "Upload…" }).click();
    await page.getByRole("menuitem", { name: "A folder, as a site" }).waitFor();
    await shot("upload-menu");
  },
} satisfies Scenario;
