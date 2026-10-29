// K-212, K-533: a timed card on the map with its end as text, its Time row in the panel, and the toast of End now.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot, api }) => {
    await api("/api/cards/tick3d/time", { endsAt: Date.now() + 60 * 60 * 1000 });
    await page.reload();
    const card = page.locator('.world > .card[data-card="tick3d"]');
    await card.waitFor();
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await card.locator(".name").click();
    await page.getByText("End now", { exact: true }).waitFor();
    await page.mouse.move(5, 500);
    await page.waitForTimeout(300);
    await shot("timed");
    await page.getByRole("button", { name: "End now", exact: true }).click();
    await page.getByText(/^Ended tick3d/).waitFor();
    await page.mouse.move(5, 500);
    await page.waitForTimeout(300);
    await shot("ended");
  },
} satisfies Scenario;
