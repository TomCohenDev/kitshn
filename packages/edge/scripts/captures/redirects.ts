// The "Redirects" list of a site card (K-1128). The demo has none, so the scenario adds two on their way in.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          type: string;
          snapshot?: { redirects: Record<string, Array<string>> };
        };
        if (data.snapshot)
          data.snapshot.redirects = { riffle: ["changelorg.example.com", "riffle-old.example.com"] };
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    // riffle is a stack of three: the first click spreads it, the second selects the card.
    await page.locator('[data-card="riffle"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-card="riffle"]').first().click();
    await page.getByRole("textbox", { name: "Redirect address" }).waitFor();
    await shot("panel");
  },
} satisfies Scenario;
