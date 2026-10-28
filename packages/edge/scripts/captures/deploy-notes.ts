// The "Deploy" row of the card panel (K-820): a failed deploy and one that did not run, because an app before it
// did not deploy. The demo has no deploy rows, so the scenario adds the notes to the snapshots on their way in.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const notes = {
  riffle: { state: "failed", reason: "the output folder site does not exist after the build." },
  tick3d: { state: "skipped", reason: "not deployed, because it needs api, which did not deploy (K-820)." },
};

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { type: string; snapshot?: Record<string, unknown> };
        if (data.type === "snapshot" && data.snapshot) data.snapshot["deployNotes"] = notes;
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    for (const name of ["riffle", "tick3d"]) {
      await page.getByText(name, { exact: true }).first().click();
      await page.getByText("Deploy", { exact: true }).first().waitFor();
      await shot(name === "riffle" ? "failed" : "not-run");
      await page.locator(".overlay-panel button", { hasText: "×" }).first().click();
    }
  },
} satisfies Scenario;
