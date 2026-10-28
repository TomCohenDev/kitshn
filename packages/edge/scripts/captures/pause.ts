// The big red button (K-1504): the Safety panel, the lid, and a clip of the press with its sound.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  clip: { lead: 2, length: 7 },
  run: async ({ page, shot, mark }) => {
    await shot("toolbar");
    await page.locator(".panic.opener").click();
    await shot("safety-panel");
    await page.locator(".lid").click();
    await page.waitForTimeout(300);
    await shot("lid-open");
    mark();
    await page.locator(".safety .mushroom").click();
    await page.waitForTimeout(3000);
    await shot("paused");
  },
} satisfies Scenario;
