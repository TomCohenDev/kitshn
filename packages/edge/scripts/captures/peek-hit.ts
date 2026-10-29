// The ▾ of a kind sticker (K-520): what a press hits around it. Its target reaches up, down and to the right of the
// small glyph, at least 1.75rem (2.5rem on a touch screen), and never the sticker's own text.
import type { Locator } from "playwright";
import { DESKTOP, PHONE, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP, PHONE],
  schemes: ["light"],
  run: async ({ page, view, shot }) => {
    const card = page.locator('[data-card="tick3d"]').first();
    const tap = (target: Locator) => (view.touch ? target.tap() : target.click());
    await tap(card);
    // On a phone the first tap on a dot zooms to it (K-513); the second selects the card.
    if (view.touch) {
      await page.waitForTimeout(300);
      await tap(card);
    }
    const scope = view.touch ? page.locator(".overlay-panel") : card;
    const toggle = scope.getByRole("button", { name: "Show the preview" });
    await toggle.waitFor();
    const box = await toggle.boundingBox();
    const sticker = await toggle.locator("xpath=..").boundingBox();
    if (!box || !sticker) throw new Error("no ▾ or sticker");
    const hit = (x: number, y: number) =>
      page.evaluate<string>(
        `(() => { const node = document.elementFromPoint(${x}, ${y}); return node?.closest(".sticker-peek") ? "▾" : (node?.closest(".sticker") ? "sticker" : node?.className || node?.tagName || "none"); })()`,
      );
    const midY = box.y + box.height / 2;
    // The map draws a card at its zoom (a card is 190 px wide), the phone sheet at its own size.
    const cardBox = await card.boundingBox();
    const scale = view.touch || !cardBox ? 1 : cardBox.width / 190;
    const reach = Math.round((view.touch ? 40 : 27) * scale);
    const up = Math.round((view.touch ? 18 : 12) * scale);
    console.log(
      `${view.name}: ▾ ${Math.round(box.width)}×${Math.round(box.height)} px; ` +
        `centre → ${await hit(box.x + box.width / 2, midY)}, ` +
        `${reach} px right → ${await hit(box.x + reach, midY)}, ` +
        `${up} px up → ${await hit(box.x + box.width / 2, midY - up)} (zoom ${scale.toFixed(2)}), ` +
        `sticker text → ${await hit(sticker.x + 12, midY)}`,
    );
    await toggle.click();
    await page.locator(".preview-frame").waitFor();
    await shot("open");
  },
} satisfies Scenario;
