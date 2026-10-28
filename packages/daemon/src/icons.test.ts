import { mkdtempSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ICON_SITES_PER_PASS,
  type IconMemory,
  iconToSend,
  iconsDue,
  readTarget,
  targetIcon,
} from "./icons.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1]);

/** An app on a Unix socket, or on a localhost port, that answers each path from `files`; `/moved` redirects. */
async function app(files: Record<string, Uint8Array | string>, on: "socket" | "port" = "socket") {
  const path = join(mkdtempSync(join(tmpdir(), "kitshn-icons-")), "app.sock");
  const server = createServer((request, response) => {
    if (request.url === "/moved") {
      response.writeHead(302, { location: "/logo.png" }).end();
      return;
    }
    const body = files[request.url ?? ""];
    if (body === undefined) response.writeHead(404).end();
    else response.end(body);
  });
  if (on === "socket") await new Promise<void>((done) => server.listen(path, done));
  else await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const target =
    on === "socket" ? `unix:${path}` : `http://localhost:${(server.address() as { port: number }).port}`;
  return { target, [Symbol.asyncDispose]: () => new Promise<void>((done) => server.close(() => done())) };
}

describe("app icons (K-1114)", () => {
  it("reads the icon that the page of the app links, through its socket", async () => {
    await using site = await app({ "/": '<link rel="icon" href="/logo.png">', "/logo.png": PNG });
    expect(await targetIcon(site.target)).toMatchObject({ path: "/logo.png", type: "image/png" });
  });

  it("follows no redirect and refuses a body over the limit", async () => {
    // On a port, with a redirect target that exists, so a read that follows redirects would find an icon.
    await using site = await app(
      { "/": '<link rel="icon" href="/moved">', "/logo.png": PNG, "/big": "x".repeat(300 * 1024) },
      "port",
    );
    expect(await readTarget(site.target, "/moved")).toBeNull();
    expect(await readTarget(site.target, "/big")).toBeNull();
    expect(await targetIcon(site.target)).toBeNull();
  });

  it("reads only a socket file, not a link to one", async () => {
    await using site = await app({ "/": "<html></html>", "/favicon.ico": PNG });
    const link = join(mkdtempSync(join(tmpdir(), "kitshn-icons-")), "link.sock");
    symlinkSync(site.target.slice("unix:".length), link);
    expect(await readTarget(site.target, "/favicon.ico")).not.toBeNull();
    expect(await readTarget(`unix:${link}`, "/favicon.ico")).toBeNull();
  });

  it("reads up sites that are new, an hour old or just came up, a few per pass", () => {
    const now = 10 * 60 * 60_000;
    const memory = new Map<string, IconMemory>([
      ["fresh", { readAt: now - 1000, up: true, sent: null }],
      ["old", { readAt: now - 2 * 60 * 60_000, up: true, sent: null }],
      ["back", { readAt: now - 5 * 60_000, up: false, sent: null }],
    ]);
    const sites = ["fresh", "old", "back", "new", "down"].map((name) => ({ name, up: name !== "down" }));
    expect(iconsDue(sites, memory, now).sort()).toEqual(["back", "new", "old"]);
    const many = Array.from({ length: 10 }, (_, index) => ({ name: `s${index}`, up: true }));
    expect(iconsDue(many, new Map(), now)).toHaveLength(ICON_SITES_PER_PASS);
  });

  it("sends an icon when it changed, or again after an hour", () => {
    expect(iconToSend(null, null, 0)).toBe(true);
    expect(iconToSend({ hash: "a", at: 0 }, "a", 1000)).toBe(false);
    expect(iconToSend({ hash: "a", at: 0 }, "b", 1000)).toBe(true);
    expect(iconToSend({ hash: "a", at: 0 }, "a", 2 * 60 * 60_000)).toBe(true);
  });
});
