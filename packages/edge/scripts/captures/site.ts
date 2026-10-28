// Pictures for the kitshn site (site/): one idea per picture, light and dark. `crop` writes `site-<name>-<scheme>.png`.
import { homedir } from "node:os";
import { join } from "node:path";
import { DESKTOP, type Scenario } from "../capture-views.ts";

const out = join(homedir(), ".cache", "kitshn-captures", "site");

export default {
  views: [DESKTOP],
  run: async ({ page, scheme }) => {
    const crop = (name: string, x: number, y: number, width: number, height: number) =>
      page.screenshot({ path: join(out, `site-${name}-${scheme}.png`), clip: { x, y, width, height } });
    await page.getByRole("button", { name: "Close", exact: true }).first().click();
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(400);
    // Who: two circles that overlap, and the cards inside them.
    await crop("circles", 770, 150, 660, 650);

    // The card panel: who can open one app, and its deploys.
    await page.locator("[data-card]").filter({ hasText: "riffle" }).first().click();
    await page.waitForTimeout(400);
    await crop("panel", 1020, 0, 492, 620);

    // A drag shows what changes before the drop (K-502). Fit keeps the map left of the open panel.
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await page.waitForTimeout(400);
    const card = page.locator("[data-card]").filter({ hasText: "tick3d" }).first();
    const from = await card.boundingBox();
    const her = await page.getByText("Her", { exact: true }).first().boundingBox();
    if (!from || !her) throw new Error("The demo has no tick3d card or no Her circle.");
    await page.mouse.move(from.x + 40, from.y + 12);
    await page.mouse.down();
    await page.mouse.move(her.x + 10, her.y + 120, { steps: 20 });
    await page.waitForTimeout(200);
    // The panel starts at about x 1030 at this view size.
    await crop("drag", 540, 290, 480, 450);
    await page.keyboard.press("Escape");
    await page.mouse.up();

    // The offline page of a site whose machine is off (K-1106).
    // The Worker fills these fields; the dev server serves the bare file.
    await page.route("**/offline.html", async (route) => {
      const answer = await route.fetch();
      const body = (await answer.text())
        .replaceAll("{{site}}", "brew.example.com")
        .replaceAll(
          "{{reason}}",
          "The cook went home. VPS is off, so this dish is off the menu for now. It comes back when VPS is on.",
        )
        .replaceAll("{{seen}}", "12 minutes ago");
      await route.fulfill({ response: answer, body });
    });
    await page.goto(new URL("/offline.html", page.url()).href);
    await page.waitForTimeout(400);
    await crop("offline", 456, 280, 600, 420);
  },
} satisfies Scenario;
