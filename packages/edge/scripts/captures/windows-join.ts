// "Add machine" with the join for Windows PowerShell (K-625). Local dev has no Cloudflare API, so the scenario answers
// the add call with a fixed code.
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.route("**/api/machines", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            json: {
              machineId: "win-pc",
              code: "k7q2m9x4",
              expiresAt: Date.now() + 10 * 60_000,
              command: "curl -fsSL https://kit.example.com/join | sh -s -- k7q2m9x4 https://kit.example.com",
              windowsCommand:
                "& ([scriptblock]::Create((irm https://kit.example.com/join/windows.ps1))) k7q2m9x4 https://kit.example.com",
            },
          })
        : route.continue(),
    );
    await page.goto(`${new URL(page.url()).origin}/#machines`);
    await page.getByRole("button", { name: "+ Machine" }).click();
    await page.getByRole("textbox", { name: "Machine name" }).fill("Windows PC");
    await page.keyboard.press("Enter");
    await page.getByText("On Windows, in PowerShell:").waitFor();
    await shot("add");
  },
} satisfies Scenario;
