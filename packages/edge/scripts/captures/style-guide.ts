// The style guide at /neo-brutalism: one shot per section, in both schemes, plus the open menu and the scheme toggle.
// Reports any section that throws, and the tokens the page reads from its stylesheet.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, scheme, shot }) => {
    const errors: Array<string> = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(new URL("/neo-brutalism", page.url()).toString());
    await page.locator(".guide-entry").first().waitFor();
    console.log(
      `entries: ${await page.locator(".guide-entry").count()}, swatches: ${await page.locator(".guide-swatch").count()}`,
    );
    const sections = await page.locator(".guide > h2.label").allTextContents();
    // The toggle sets the tokens of one scheme on the page, whatever the system setting.
    const canvas = () =>
      page.evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim()`);
    const seen: Array<string> = [];
    for (const each of ["dark", "light", "system"]) {
      await page.getByRole("button", { name: each, exact: true }).click();
      seen.push(`${each}=${await canvas()}`);
    }
    console.log(`toggle (${scheme} system): ${seen.join(", ")}`);
    await shot("00-top");
    for (const [index, section] of sections.entries()) {
      await page.evaluate(`document.querySelectorAll(".guide > h2.label")[${index}].scrollIntoView()`);
      await page.waitForTimeout(250);
      await shot(`${String(index + 1).padStart(2, "0")}-${section.toLowerCase().replaceAll(" ", "-")}`);
    }
    await page.evaluate(`document.querySelectorAll(".guide > h2.label")[1].scrollIntoView()`);
    await page.getByRole("button", { name: "Open the menu" }).click();
    await page.waitForTimeout(250);
    await shot("menu");
    await page.keyboard.press("Escape");
    await page.evaluate(`document.querySelector(".guide-differences").scrollIntoView()`);
    await shot("differences");
    // One picture per entry, so each primitive shows whole.
    const entries = page.locator(".guide-entry");
    const out = `${process.env["HOME"]}/.cache/kitshn-captures/style-guide-entries`;
    for (let index = 0; index < (await entries.count()); index++)
      await entries
        .nth(index)
        .screenshot({ path: `${out}/${String(index + 1).padStart(2, "0")}-${scheme}.png` });
    console.log(`page errors: ${errors.length === 0 ? "none" : errors.join(" | ")}`);
  },
} satisfies Scenario;
