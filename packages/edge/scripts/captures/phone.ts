// The map on a phone (K-516, K-528): the toolbar, a pinch, the ☰ menu, the shelf sheet and the panel sheet.
import { PHONE, SMALL_PHONE, type Scenario } from "../capture-views.ts";

export default {
  views: [PHONE, SMALL_PHONE],
  run: async ({ page, view, shot, pinch }) => {
    await shot("map");
    await pinch({ x: view.width / 2, y: view.height * 0.4 }, 80, 240);
    await page.waitForTimeout(200);
    await shot("pinched");
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    if (await menu.count()) {
      await menu.tap();
      await shot("menu");
      await page.keyboard.press("Escape");
    }
    const shelf = page.locator(".tray-toggle");
    if (await shelf.count()) {
      await shelf.tap();
      await shot("shelf");
    }
  },
} satisfies Scenario;
