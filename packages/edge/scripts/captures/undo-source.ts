// K-1509: History says where each Undo came from. Two changes, each undone by another button, then History.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, api, shot }) => {
    const change = async (name: string, source: string) => {
      const id = name.toLowerCase();
      const circle = {
        id,
        name,
        color: "#7c3aed",
        level: "view",
        members: [],
        match: "any",
        needsPasskey: false,
        endsAt: null,
        x: 3000,
        y: 3000,
        r: 100,
      };
      const { revision } = (await api("/api/apply", { edits: [{ _tag: "circle", id, after: circle }] })) as {
        revision: number;
      };
      await api("/api/undo", { revision, source });
    };
    await change("Friends", "toast");
    await change("Team", "history");
    await page.reload();
    await page.getByRole("button", { name: "History", exact: true }).click();
    await page.locator(".history-row").first().waitFor();
    await shot("history");
  },
} satisfies Scenario;
