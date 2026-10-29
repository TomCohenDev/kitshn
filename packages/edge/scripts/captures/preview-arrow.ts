// The preview arrow of a selected card (K-520): closed, open with the login line of a private app, and enlarged.
// The demo addresses do not exist, so the scenario answers them with a small page.
import type { Locator, Page } from "playwright";
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

const site = (host: string) =>
  `<!doctype html><body style="margin:0;font:28px system-ui;background:#fef3c7;display:grid;place-items:center;height:100vh"><h1>${host}</h1><p>a running app</p></body>`;

/** Zoomed in, as a person reads a card, so the small preview is readable in the capture. */
async function zoomIn(page: Page, card: Locator, delta = -400) {
  const box = await card.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, delta);
  await page.keyboard.up("Control");
  await page.waitForTimeout(200);
}

export default {
  views: [DESKTOP, PHONE],
  run: async ({ page, view, shot }) => {
    const zoomTo = (card: Locator, delta?: number) => zoomIn(page, card, delta);
    await page.route(/example\.com/, (route) =>
      route.fulfill({ contentType: "text/html", body: site(new URL(route.request().url()).host) }),
    );
    const card = page.locator('[data-card="tick3d"]').first();
    // On a phone the first tap on a dot zooms to it (K-513); the second selects the card.
    if (view.touch) {
      await card.tap();
      await page.waitForTimeout(300);
      await card.tap();
    } else {
      await zoomTo(card);
      await card.click();
    }
    const arrow = page.getByRole("button", { name: /▾ Preview|show the preview/i });
    await arrow.waitFor();
    await shot("closed");
    await arrow.click();
    await page.locator(".preview-frame iframe").waitFor();
    await page.waitForTimeout(300);
    await shot("open");
    await page.locator(".peek .preview-frame").getByRole("button", { name: "Enlarge" }).click();
    await page.locator(".peek-large iframe").waitFor();
    await page.waitForTimeout(300);
    await shot("large");
    if (view.touch) return;
    // A private app: the frame says that it shows only after a login.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(200);
    await zoomTo(page.locator('[data-card="riffle"]').first(), -200);
    // riffle is a stack of three: the first click spreads it, the second selects the card.
    await page.locator('[data-card="riffle"]').first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-card="riffle"]').first().click();
    await page.getByRole("button", { name: /▾ Preview|show the preview/i }).click();
    await page.locator(".preview-frame .help").waitFor();
    await shot("private");
  },
} satisfies Scenario;
