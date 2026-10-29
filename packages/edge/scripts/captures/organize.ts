// K-532: the demo map before and after Organize, with one stack open, and a second Organize that moves nothing.
// Reports every pair of drawn cards that overlap, and every card over a circle head or a chip row.
import { DESKTOP, type Scenario } from "../capture-views.ts";

const overlaps = `(() => {
  const cards = [...document.querySelectorAll(".world > .card")].map((element) => [element.dataset.card, element.getBoundingClientRect()]);
  const parts = [...document.querySelectorAll(".circle > .head, .circle > .members")].map((element) => [element.className, element.getBoundingClientRect()]);
  const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom && a.width > 0 && b.width > 0;
  const found = [];
  cards.forEach(([id, box], index) => {
    for (const [other, near] of cards.slice(index + 1)) if (hit(box, near)) found.push(id + " / " + other);
    for (const [part, near] of parts) if (hit(box, near)) found.push(id + " / " + part);
  });
  return found.join(", ") || "none";
})()`;

export default {
  views: [DESKTOP],
  run: async ({ page, shot, api }) => {
    const fit = () => page.getByRole("button", { name: "Fit", exact: true }).click();
    // A messy map: cards pile up on their neighbours, each in the circles it is in now.
    const { places } = (await api("/api/state")) as { places: Record<string, { x: number; y: number }> };
    const near = (id: string, dx: number, dy: number) => {
      const place = places[id];
      if (!place) throw new Error(`The demo has no card ${id}.`);
      return { x: place.x + dx, y: place.y + dy };
    };
    await api("/api/apply", {
      edits: [
        { _tag: "place", id: "mac", after: near("vps", 40, 30) },
        { _tag: "place", id: "kitshn-admin", after: near("vps", -30, 70) },
        { _tag: "place", id: "kitshn-repo", after: near("tick3d", 25, 35) },
      ],
    });
    await page.reload();
    await page.locator(".world > [data-card]").first().waitFor();
    // The group stack of riffle and its previews opens as a column (K-508).
    await page.locator('.world > .card[data-card="riffle"]').click();
    await fit();
    await page.mouse.move(5, 500);
    await page.waitForTimeout(500);
    console.log(`before: overlaps ${await page.evaluate<string>(overlaps)}`);
    await shot("before");
    await page.getByRole("button", { name: "Organize", exact: true }).click();
    await page.getByText(/^Organize: moved \d+ cards?\.$/).waitFor();
    await fit();
    await page.mouse.move(5, 500);
    await page.waitForTimeout(500);
    console.log(`after: overlaps ${await page.evaluate<string>(overlaps)}`);
    await shot("after");
    await page.getByRole("button", { name: "Organize", exact: true }).click();
    await page.getByText("Every card is in order already.").waitFor();
    console.log("second Organize: every card is in order already");
  },
} satisfies Scenario;
