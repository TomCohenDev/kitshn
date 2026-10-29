// A card dragged out of a circle to the bottom of the map: whether the toast of that drop covers the card, so that
// grabbing the card again presses Undo (the climbing removals of 2026-10-28).
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    const card = page.locator('[data-card="tick3d"]').first();
    const from = await card.boundingBox();
    if (!from) throw new Error("no tick3d card");
    // The bottom centre of the open map, just above the hint line, where the toast shows.
    const to = await page.evaluate<{ x: number; y: number }>(
      `({ x: (innerWidth - parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--panel-width") || "0") - 24) / 2, y: (document.querySelector(".hint")?.getBoundingClientRect().top ?? innerHeight) - 40 })`,
    );
    await page.mouse.move(from.x + from.width / 2, from.y + 12);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    await page.locator(".toast").waitFor();
    await page.waitForTimeout(300);
    const dropped = await card.boundingBox();
    const undo = await page.locator(".toast").getByRole("button", { name: "Undo" }).boundingBox();
    console.log(`card ${JSON.stringify(dropped)}`);
    console.log(`undo ${JSON.stringify(undo)}`);
    if (dropped) {
      const hit = await page.evaluate<string>(
        `document.elementFromPoint(${dropped.x + dropped.width / 2}, ${dropped.y + dropped.height / 2})?.closest("button, [data-card], .toast")?.textContent?.trim().slice(0, 40) ?? "none"`,
      );
      console.log(`a press on the card centre hits: ${hit}`);
    }
    await shot("dropped");
  },
} satisfies Scenario;
