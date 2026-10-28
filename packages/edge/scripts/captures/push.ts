// Notifications (K-1905): the bell with its count, and the Notifications panel. The demo has no failed deploy, so
// the scenario answers the list itself and sets the count of the snapshot.
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

const now = Date.now();
const hour = 3_600_000;
const notification = {
  episode: "d1",
  recipients: { _tag: "owner" },
  priority: "normal",
  snoozedUntil: null,
};
const list = {
  notifications: [
    {
      ...notification,
      id: 3,
      source: "deploy",
      key: "riffle",
      card: "riffle",
      level: "error",
      title: "Deploy of riffle failed",
      text: "docker compose up failed: the image web has no tag 41be0d9.",
      actions: [{ id: "show", label: "Show card", kind: "link", path: "#map/riffle" }],
      state: "open",
      openedAt: now - 20 * 60_000,
      closedAt: null,
    },
    {
      ...notification,
      id: 2,
      source: "deploy",
      key: "tick3d",
      card: "tick3d",
      level: "warn",
      title: "Deploy of tick3d did not run",
      snoozedUntil: now + hour,
      text: "The repo waits for Allow on the map (K-819).",
      actions: [{ id: "show", label: "Show card", kind: "link", path: "#map/tick3d" }],
      state: "open",
      openedAt: now - 2 * hour,
      closedAt: null,
    },
    {
      ...notification,
      id: 1,
      source: "deploy",
      key: "tick3d",
      card: "tick3d",
      level: "error",
      title: "Deploy of tick3d failed",
      text: "The build step exited with 1.",
      actions: [{ id: "show", label: "Show card", kind: "link", path: "#map/tick3d" }],
      state: "closed",
      openedAt: now - 30 * hour,
      closedAt: now - 28 * hour,
    },
  ],
  mutes: [{ card: "her", source: "uptime", until: null }],
};

const push = {
  publicKey: "BOrJcU3wNqq2u1rXmnr0RkE7b0yJ5wCw4mFhGkYkM7aV8mLkqR0nH0a8b9QkzJ2y4g3QnV6mH0qQ5y1fQyQ0w0A",
  testAt: 0,
  devices: [
    {
      id: 1,
      label: "Android Chrome",
      email: "owner@example.com",
      levels: ["warn", "error"],
      quiet: { start: 22 * 60, end: 7 * 60, timeZone: "Asia/Jerusalem" },
      createdAt: now - 3 * 24 * hour,
      lastOkAt: now - 25 * 60_000,
      mine: true,
    },
    {
      id: 2,
      label: "Mac Chrome",
      email: "owner@example.com",
      levels: ["error"],
      quiet: null,
      createdAt: now - 40 * 24 * hour,
      lastOkAt: null,
      mine: false,
    },
  ],
};

export default {
  views: [DESKTOP, PHONE],
  run: async ({ page, shot }) => {
    // A headless browser has no push service, so the page gets a subscription that looks like a real one.
    await page.addInitScript(() => {
      const subscription = {
        endpoint: "https://fcm.googleapis.com/fcm/send/capture",
        options: { applicationServerKey: null },
        toJSON: () => ({ keys: { p256dh: "key", auth: "auth" } }),
        unsubscribe: async () => true,
      };
      // This file has no DOM types; the script runs in the page, where these globals exist.
      const page = globalThis as unknown as { navigator: { serviceWorker: object }; Notification: object };
      Object.defineProperty(page.navigator.serviceWorker, "getRegistration", {
        value: async () => ({ pushManager: { getSubscription: async () => subscription } }),
      });
      Object.defineProperty(page.Notification, "permission", { get: () => "default" });
    });
    await page.route(/\/api\/notifications$/, (route) => route.fulfill({ json: list }));
    await page.route(/\/api\/push(\?.*)?$/, (route) => route.fulfill({ json: push }));
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { type: string; snapshot?: Record<string, unknown> };
        if (data.type === "snapshot" && data.snapshot) data.snapshot["bell"] = 2;
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.goto(`${page.url().split("#")[0]}#notifications`);
    await page.locator(".push").getByText("Android Chrome").waitFor();
    await shot("view");
  },
} satisfies Scenario;
