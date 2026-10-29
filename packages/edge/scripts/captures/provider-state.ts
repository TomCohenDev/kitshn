// Provider state (K-717, K-1608, K-1625): a T3 app card of the demo machine vps with its "Update channel" setting and a
// list of scheduled tasks with row commands, and the machine card with "queued 2". The scenario adds the card to the demo
// snapshot, as a daemon report of T3 would.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const levels = { view: "view", use: "use", control: "control" };
const app = {
  id: "p-t3app",
  kind: "t3.app",
  name: "T3 on vps",
  addresses: ["t3-vps.example.com"],
  status: "running",
  group: null,
  machine: "vps",
  provider: {
    name: "t3",
    localId: "app",
    kindName: "T3 app",
    levels,
    facts: [
      { label: "version", value: "0.0.31 · release", role: "version" },
      { label: "running agents", value: "2" },
    ],
    stickers: [
      { text: "2 agents", tone: "info" },
      { text: "update waits", tone: "warn" },
    ],
    site: "t3-vps",
    settings: [
      { id: "updateChannel", title: "Update channel", values: ["nightly", "daily"], default: "nightly" },
    ],
    lists: [
      {
        id: "tasks",
        title: "Scheduled tasks",
        columns: [
          { id: "name", title: "Task" },
          { id: "next", title: "Next run" },
        ],
        rows: [
          { id: "t1", cells: { name: "Nightly digest", next: "02:00" }, commands: ["run-task"] },
          { id: "t2", cells: { name: "Fork sync", next: "every hour" }, commands: ["run-task"] },
        ],
      },
    ],
  },
};
const thread = {
  ...app,
  id: "p-t3thread",
  kind: "t3.thread",
  name: "Fix the login page",
  addresses: [],
  group: null,
  provider: {
    ...app.provider,
    localId: "th-1",
    kindName: "T3 thread",
    levels: { view: "view", use: "send" },
    facts: [],
    stickers: [],
    site: null,
    settings: [],
    lists: [],
  },
};

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          snapshot?: {
            resources: Array<unknown>;
            places: Record<string, { x: number; y: number }>;
            providerCommands: Record<string, unknown>;
            cardSettings: Record<string, unknown>;
            machines: Array<{ machine: { id: string }; queued: number }>;
          };
        };
        if (data.snapshot) {
          data.snapshot.cardSettings[app.id] = { updateChannel: "daily" };
          for (const view of data.snapshot.machines) if (view.machine.id === "vps") view.queued = 2;
          data.snapshot.resources.push(app, thread);
          data.snapshot.places[app.id] = { x: 120, y: -10 };
          data.snapshot.places[thread.id] = { x: 380, y: 420 };
          data.snapshot.providerCommands["vps"] = [
            {
              name: "t3",
              commands: [
                { id: "restart", title: "Restart server", kinds: ["t3.app"], confirm: true },
                { id: "run-task", title: "Run now", kinds: ["t3.app"], confirm: false },
              ],
            },
          ];
        }
        // The server sends each change of a machine on its own, so its count stays too.
        const view = (data as { view?: { machine: { id: string }; queued: number } }).view;
        if (view?.machine.id === "vps") view.queued = 2;
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(600);
    await page.locator(`[data-card="${app.id}"]`).first().click();
    await page.waitForTimeout(500);
    await shot("app-card");
    await page.locator(`[data-card="${app.id}"]`).first().click({ button: "right" });
    await page.waitForTimeout(400);
    await shot("app-menu");
    await page.keyboard.press("Escape");
    await page.locator(`[data-card="${thread.id}"]`).first().click();
    await page.waitForTimeout(500);
    await shot("thread-card");
  },
} satisfies Scenario;
