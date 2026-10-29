// Live preview frames (K-520): the still loading state, a frame that never loads, a framed or focused card drawn
// over its neighbours, and a sideways wheel on the map that never becomes the browser's back swipe.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const site = (host: string) =>
  `<!doctype html><body style="margin:0;font:28px system-ui;background:#fef3c7"><header style="padding:24px;background:#6c5ce7;color:#fff"><b>${host}</b></header><h1 style="padding:24px">A running app</h1></body>`;

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    // tick3d answers after 4 s, riffle never answers, every other demo address at once.
    await page.route(/example\.com/, async (route) => {
      const host = new URL(route.request().url()).host;
      if (host.startsWith("riffle.")) return;
      if (host.startsWith("tick3d.")) await new Promise((resolve) => setTimeout(resolve, 4000));
      await route.fulfill({ contentType: "text/html", body: site(host) }).catch(() => undefined);
    });
    const wheel = await page.evaluate<{ prevented: boolean; overscroll: string }>(`(() => {
      const event = new WheelEvent("wheel", { deltaX: -60, bubbles: true, cancelable: true });
      document.querySelector(".viewport").dispatchEvent(event);
      return { prevented: event.defaultPrevented, overscroll: getComputedStyle(document.documentElement).overscrollBehaviorX };
    })()`);
    console.log(
      `sideways wheel on the map: defaultPrevented=${wheel.prevented}, html overscroll-behavior-x=${wheel.overscroll}`,
    );
    await page.getByRole("button", { name: "Previews", exact: true }).click();
    const tick3d = page.locator('[data-card="tick3d"]').first();
    const box = await tick3d.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -260);
    await page.keyboard.up("Control");
    await page.waitForTimeout(800);
    await shot("loading");
    await page.waitForTimeout(4500);
    const layers = await page.evaluate<string>(
      `[...document.querySelectorAll(".world > .card")].filter((card) => card.style.getPropertyValue("--layer")).map((card) => card.dataset.card + "=" + card.style.getPropertyValue("--layer")).join(", ")`,
    );
    console.log(`cards with a layer: ${layers}`);
    const focus = await page.evaluate<string>(`(() => {
      const card = document.querySelector('.world > .card[data-card="riffle"]');
      card.querySelector("button").focus();
      const head = document.querySelector(".circle .head");
      return "focused riffle z=" + getComputedStyle(card).zIndex + ", circle head z=" + getComputedStyle(head).zIndex;
    })()`);
    console.log(focus);
    await shot("loaded");
    await page.waitForTimeout(16_000);
    await shot("not-available");
  },
} satisfies Scenario;
