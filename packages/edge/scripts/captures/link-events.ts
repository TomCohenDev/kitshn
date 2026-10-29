// Cross-machine work (K-1610): the History view with exec runs and forwarded tool calls that source machines report.
// The scenario adds two events to the demo snapshot: one that both machines reported, and one without the target's report.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const events = [
  {
    id: 2,
    at: Date.UTC(2026, 9, 29, 14, 5),
    source: "mac",
    target: "vps",
    kind: "exec",
    thread: "Fix the login page",
    side: "source",
    name: "git",
    cwd: "/home/kcw/riffle",
    outcome: "succeeded",
    exitCode: 0,
    partner: { side: "target", name: "exec", outcome: "succeeded", exitCode: 0 },
    check: "paired",
  },
  {
    id: 1,
    at: Date.UTC(2026, 9, 29, 14, 1),
    source: "mac",
    target: "vps",
    kind: "tool",
    thread: "Fix the login page",
    side: "source",
    name: "t3_thread_read",
    cwd: null,
    outcome: "refused",
    exitCode: null,
    partner: null,
    check: "no target report",
  },
];

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { snapshot?: { linkEvents: Array<unknown> } };
        if (data.snapshot) data.snapshot.linkEvents = events;
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "History", exact: true }).first().click();
    await page.waitForTimeout(600);
    await page.getByText("Cross-machine work").first().scrollIntoViewIfNeeded();
    await shot("history");
  },
} satisfies Scenario;
