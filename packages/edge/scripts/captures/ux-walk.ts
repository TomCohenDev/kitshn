// A walk through common owner actions, for a UX review: the add menu, the palette, a new circle, undo, History,
// the keyboard and the phone sheets.
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP, PHONE],
  run: async ({ page, view, shot }) => {
    if (view.touch) {
      await page.getByRole("button", { name: /^New · private/ }).tap();
      await shot("tray-open");
      await page.getByRole("button", { name: /^New · private/ }).tap();
      await page.locator('[data-card="riffle"]').first().tap();
      await page.waitForTimeout(300);
      await shot("group-open");
      await page.getByRole("button", { name: "Menu", exact: true }).tap();
      await shot("more-menu");
      return;
    }
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await shot("add-menu");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(300);
    await page.keyboard.type("share");
    await shot("palette");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.locator('[data-card="tick3d"]').first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Share with" }).click();
    await page.getByRole("menuitem", { name: "New circle…" }).click();
    await page.waitForTimeout(400);
    await shot("new-circle");
    await page.getByRole("button", { name: "Undo" }).first().click();
    await page.waitForTimeout(400);
    await shot("undone");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await shot("keyboard");
    await page.getByRole("button", { name: "History" }).click();
    await page.waitForTimeout(300);
    await shot("history");
  },
} satisfies Scenario;
