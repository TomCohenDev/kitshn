// An open stack with previews on (K-508, K-521, K-520): each card of the column, with its preview frame, sits clear
// of the card below it. Reports the overlap in screen pixels between neighbours of the column.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const site = (host: string) =>
  `<!doctype html><body style="margin:0;font:28px system-ui;background:#fef3c7"><header style="padding:24px;background:#6c5ce7;color:#fff"><b>${host}</b></header><h1 style="padding:24px">A running app</h1></body>`;

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.route(/example\.com/, (route) =>
      route.fulfill({ contentType: "text/html", body: site(new URL(route.request().url()).host) }),
    );
    await page.getByRole("button", { name: "Previews", exact: true }).click();
    const riffle = page.locator('[data-card="riffle"]').first();
    const box = await riffle.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -180);
    await page.keyboard.up("Control");
    await page.waitForTimeout(300);
    await riffle.locator(".name").click();
    await page.waitForTimeout(300);
    await page.mouse.move(5, 500);
    await page.waitForTimeout(1500);
    const overlaps = await page.evaluate<string>(`(() => {
      const ids = ["riffle", "riffle-pr-41", "riffle-pr-42"];
      const rects = ids.map((id) => document.querySelector('.world > .card[data-card="' + id + '"]')?.getBoundingClientRect());
      return ids.slice(1).map((id, i) => {
        const above = rects[i];
        const below = rects[i + 1];
        return id + ": " + (above && below ? Math.round(above.bottom - below.top) + " px over" : "not drawn");
      }).join(", ");
    })()`);
    console.log(`column overlap (positive covers the card below): ${overlaps}`);
    await shot("open-stack");
  },
} satisfies Scenario;
