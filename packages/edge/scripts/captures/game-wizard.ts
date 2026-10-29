// K-534: the Game step of the site wizard. The demo has no daemon, so the scenario marks the first machine online,
// with the capability `doors` and two listening ports.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const servers = [
  { port: 25565, process: "java", status: null, title: null },
  { port: 19132, process: "bedrock_server", status: null, title: null },
];

type View = { machine: { id: string }; online: boolean; status: Record<string, unknown> | null };

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    let first: string | null = null;
    const able = (view: View) =>
      (first ??= view.machine.id) === view.machine.id
        ? {
            ...view,
            online: true,
            servers,
            status: {
              version: "dev",
              os: "linux",
              arch: "x64",
              hostname: "vps",
              tunnel: "running",
              capabilities: ["doors"],
            },
          }
        : view;
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          type: string;
          snapshot?: { machines: Array<View> };
          view?: View;
        };
        if (data.type === "snapshot" && data.snapshot)
          data.snapshot.machines = data.snapshot.machines.map(able);
        if (data.type === "machine" && data.view) data.view = able(data.view);
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.locator(".world > [data-card]").first().waitFor();
    await page.getByRole("button", { name: "Add" }).click();
    await page.getByRole("menuitem", { name: "Add a site" }).click();
    await page.getByRole("button", { name: "Game", exact: true }).click();
    await page.getByRole("button", { name: /^25565/ }).click();
    await page.getByLabel("Name").fill("minecraft");
    await page.getByLabel("SRV service").fill("minecraft");
    await page.mouse.move(5, 500);
    await page.waitForTimeout(300);
    await shot("game-step");
  },
} satisfies Scenario;
