// A toast and the button that made it: what a second press at that button's spot hits, for the panel's Remove,
// the card menu's Unshare and the add menu's New circle, on a phone and a desktop.
import type { Locator, Page } from "playwright";
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

async function secondPress(page: Page, label: string, source: Locator, press: () => Promise<void>) {
  const box = await source.boundingBox();
  await press();
  await page.locator(".toast").waitFor();
  await page.waitForTimeout(200);
  if (!box) throw new Error(`${label}: no button`);
  // A string runs in the page, which has the DOM types that this script does not.
  const hit = await page.evaluate<string>(
    `document.elementFromPoint(${box.x + box.width / 2}, ${box.y + box.height / 2})?.closest("button, a, [role=menuitem]")?.textContent?.trim() ?? "none"`,
  );
  console.log(`${label}: a second press there hits "${hit.slice(0, 30)}"`);
}

export default {
  views: [PHONE, DESKTOP],
  run: async ({ page, view, shot }) => {
    const tap = (target: Locator) => (view.touch ? target.tap() : target.click());
    await tap(page.locator('[data-card="tick3d"]').first());
    await page.waitForTimeout(300);
    // On a phone the first tap on a dot zooms to it (K-513); the second selects.
    if (view.touch) await tap(page.locator('[data-card="tick3d"]').first());
    await page.waitForTimeout(300);
    const remove = page.getByRole("button", { name: "Remove", exact: true }).first();
    await remove.scrollIntoViewIfNeeded();
    await secondPress(page, `${view.name} panel Remove`, remove, () => tap(remove));
    await shot("after-remove");
    await page.waitForTimeout(600);
    await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
    await page.waitForTimeout(800);
    await page.keyboard.press("Escape");
    await tap(page.getByRole("button", { name: "Add", exact: true }));
    const item = page.getByRole("menuitem", { name: /^New circle/ }).first();
    await secondPress(page, `${view.name} add menu New circle`, item, () => tap(item));
    if (view.touch) return;
    await page.keyboard.press("Escape");
    await page.locator('[data-card="tick3d"]').first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Unshare from" }).click();
    const unshare = page.getByRole("menuitem", { name: "Everyone" }).first();
    await secondPress(page, `${view.name} menu Unshare`, unshare, () => unshare.click());
  },
} satisfies Scenario;
