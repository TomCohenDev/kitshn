// The owner's folder upload (K-1129): "Upload a folder" in the "+" menu, "Upload a new version…" on a folder site,
// and the progress line with the hidden files that it skipped. The demo has no folder site, so tick3d counts as
// one, and the scenario answers the upload.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP, type Scenario } from "../capture-views.ts";

export default {
  views: [DESKTOP],
  run: async ({ page, shot }) => {
    await page.routeWebSocket(/\/api\/ws/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const data = JSON.parse(String(message)) as { snapshot?: { folderSites: Array<string> } };
        if (data.snapshot) data.snapshot.folderSites = ["tick3d"];
        socket.send(JSON.stringify(data));
      });
    });
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/sites/**", async (route) => {
      const step = new URL(route.request().url()).pathname.split("/").at(-1);
      if (step === "plan")
        return route.fulfill({
          json: { deployId: "d1", card: "tick3d", address: "tick3d.example.com", updated: true },
        });
      if (step === "assets") {
        const body = route.request().postDataJSON() as { manifest: Record<string, { hash: string }> };
        return route.fulfill({ json: { buckets: [Object.values(body.manifest).map((file) => file.hash)] } });
      }
      if (step === "upload") await held;
      return route.fulfill({ json: { ok: true } });
    });
    await page.reload();

    await page.getByRole("button", { name: "Add" }).click();
    await page.getByRole("menuitem", { name: "Upload a folder" }).waitFor();
    await shot("add-menu");
    await page.keyboard.press("Escape");

    // The details panel covers tick3d at this size, so the menu opens as the menu key would open it.
    await page.locator('[data-card="tick3d"]').first().dispatchEvent("contextmenu");
    await page.getByRole("menuitem", { name: "Upload a new version…" }).waitFor();
    await shot("card-menu");

    const folder = join(mkdtempSync(join(tmpdir(), "kitshn-capture-")), "tick3d");
    mkdirSync(join(folder, "css"), { recursive: true });
    writeFileSync(join(folder, "index.html"), "<!doctype html><title>tick3d</title>");
    writeFileSync(join(folder, "css", "site.css"), "body { margin: 0 }");
    // Hidden files stay out, as the CLI leaves them out (K-805).
    mkdirSync(join(folder, ".git"));
    writeFileSync(join(folder, ".git", "config"), "[core]");
    writeFileSync(join(folder, ".env"), "SECRET=1");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: "Upload a new version…" }).click();
    await (await chooser).setFiles(folder);
    await page.getByRole("status").filter({ hasText: "Uploading" }).waitFor();
    await shot("progress");
    release();
    await page.getByText("Uploaded a new version of tick3d.").waitFor();
    await shot("done");
  },
} satisfies Scenario;
