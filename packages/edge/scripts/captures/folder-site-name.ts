// The "Name" field of a folder site card (K-1123, K-1124). The demo has no folder site, so the scenario adds one.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as {
          type: string;
          snapshot?: { resources: Array<Record<string, unknown>>; deployedCards: Array<string> };
        };
        if (data.snapshot) {
          data.snapshot.resources.push({
            id: "folder-demo",
            kind: "site.static",
            name: "design-review",
            addresses: ["calm-otter-42.example.com"],
            status: "running",
            group: null,
            machine: null,
          });
          data.snapshot.deployedCards = [...data.snapshot.deployedCards, "folder-demo"];
        }
        socket.send(JSON.stringify(data));
      });
    });
    await page.reload();
    await page.locator(".card", { hasText: "design-review" }).first().click();
    await page.getByRole("textbox", { name: "Address name" }).waitFor();
    await shot("field");
  },
} satisfies Scenario;
