// The map after the UX pass: the toolbar, the preview frame, the previews of an app, an owner's stack and the shelf.
// The demo addresses do not exist, so the scenario answers them with a tall page.
import type { Page } from "playwright";
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

const site = (host: string) =>
  `<!doctype html><body style="margin:0;font:28px system-ui;background:#fef3c7"><header style="padding:24px;background:#6c5ce7;color:#fff"><b>${host}</b></header><h1 style="padding:24px">A running app</h1><p style="padding:0 24px">The top of the page shows in the card.</p></body>`;

async function zoomAt(page: Page, selector: string, delta: number) {
  const box = await page.locator(selector).first().boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, delta);
  await page.keyboard.up("Control");
  await page.waitForTimeout(200);
}

export default {
  views: [DESKTOP, PHONE],
  run: async ({ page, view, shot }) => {
    await page.route(/example\.com/, (route) =>
      route.fulfill({ contentType: "text/html", body: site(new URL(route.request().url()).host) }),
    );
    await shot("map");
    const tick3d = page.locator('[data-card="tick3d"]').first();
    if (view.touch) await tick3d.tap();
    else {
      await zoomAt(page, '[data-card="tick3d"]', -300);
      await tick3d.click();
    }
    await page.getByRole("button", { name: "▾ Preview" }).click();
    await page.locator(".preview-frame iframe").waitFor();
    await page.waitForTimeout(400);
    await shot("preview");
    if (view.touch) return;
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(200);
    await page.locator('[data-card="riffle"]').first().click();
    await page.waitForTimeout(200);
    await shot("pr-cards");
    await page.keyboard.press("Escape");
    await page.locator('[data-card="mac"]').first().click();
    await page
      .locator('[data-card="vps"]')
      .first()
      .click({ modifiers: ["Shift"] });
    await page
      .getByRole("button", { name: /^Stack these/ })
      .first()
      .click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await shot("stack");
    await page.locator('[data-card="mac"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-card="vps"]').first().click();
    await page.waitForTimeout(200);
    await shot("stack-card-selected");
    await page.keyboard.press("Escape");
    await page.locator('[data-card="tick3d"]').first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Share with" }).click();
    await page.getByRole("menuitem", { name: "New circle…" }).waitFor();
    await shot("share-with");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^New · private/ }).click();
    await page.waitForTimeout(200);
    await shot("tray-folded");
  },
} satisfies Scenario;
