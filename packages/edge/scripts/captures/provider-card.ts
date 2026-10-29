// Provider cards (K-704 to K-707, K-713, K-1625): a T3 thread card of the demo machine vps in the circle "Her", with its
// level named "send", the facts and stickers of a T3 app card, and the provider command in the card menu. The scenario
// adds both cards to the demo snapshot, as a daemon report of T3 would.
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
          };
        };
        if (data.snapshot) {
          data.snapshot.resources.push(app, thread);
          data.snapshot.places[app.id] = { x: 120, y: -10 };
          data.snapshot.places[thread.id] = { x: 380, y: 420 };
          data.snapshot.providerCommands["vps"] = [
            {
              name: "t3",
              commands: [{ id: "restart", title: "Restart server", kinds: ["t3.app"], confirm: true }],
            },
          ];
        }
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
