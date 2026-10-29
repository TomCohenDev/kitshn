// State export (K-1832): "Download state export" in the Safety panel, next to "Restore kitshn to a time…".
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.locator(".panic.opener").click();
    await page.getByRole("link", { name: "Download state export" }).waitFor();
    await shot("safety");
  },
} satisfies Scenario;
