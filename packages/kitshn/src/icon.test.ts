import { describe, expect, it } from "vitest";
import { ICON_LIMIT, iconType, pageDataIcon, pickSiteIcon } from "./icon.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0]);
const SVG = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const text = (value: string) => new TextEncoder().encode(value);

const site = (files: Record<string, Uint8Array>) => (path: string) => files[path] ?? null;

describe("site icon (K-1112, K-1113)", () => {
  it("takes the link rel=icon of index.html over favicon.ico and the manifest", async () => {
    const picked = await pickSiteIcon(
      site({
        "/index.html": text(
          '<head><link rel="manifest" href="/app.webmanifest"><LINK REL="shortcut icon" href="img/logo.svg?v=2"></head>',
        ),
        "/img/logo.svg": SVG,
        "/favicon.ico": ICO,
        "/app.webmanifest": text(JSON.stringify({ icons: [{ src: "icon.png" }] })),
        "/icon.png": PNG,
      }),
    );
    expect(picked.icon).toMatchObject({ path: "/img/logo.svg", type: "image/svg+xml" });
  });

  it("takes favicon.ico when index.html links no icon, and ignores apple-touch-icon", async () => {
    const picked = await pickSiteIcon(
      site({
        "/index.html": text('<link rel="apple-touch-icon" href="/touch.png">'),
        "/touch.png": PNG,
        "/favicon.ico": ICO,
      }),
    );
    expect(picked.icon).toMatchObject({ path: "/favicon.ico", type: "image/x-icon" });
  });

  it("takes the first icon of the linked web manifest, relative to the manifest", async () => {
    const picked = await pickSiteIcon(
      site({
        "/index.html": text("<link rel=manifest href=/assets/site.webmanifest>"),
        "/assets/site.webmanifest": text(JSON.stringify({ icons: [{ src: "icon-192.png" }, { src: "/big.png" }] })),
        "/assets/icon-192.png": PNG,
      }),
    );
    expect(picked.icon?.path).toBe("/assets/icon-192.png");
  });

  it("skips a candidate that is too large or not an image, and says why", async () => {
    const picked = await pickSiteIcon(
      site({
        "/index.html": text('<link rel="icon" href="/huge.png"><link rel="icon" href="/fake.png">'),
        "/huge.png": new Uint8Array(ICON_LIMIT + 1).fill(0x89),
        "/fake.png": text("<html>not an image</html>"),
        "/favicon.ico": ICO,
      }),
    );
    expect(picked.icon?.path).toBe("/favicon.ico");
    expect(picked.notes).toHaveLength(2);
  });

  it("has no icon for a site without one, so the card shows its kind icon", async () => {
    const picked = await pickSiteIcon(site({ "/index.html": text('<link rel="icon" href="https://cdn.example.com/x.png">') }));
    expect(picked).toEqual({ icon: null, notes: [] });
  });

  it("knows image types by their bytes, not by their name", () => {
    expect(iconType(PNG)).toBe("image/png");
    expect(iconType(text("<html><svg></svg></html>"))).toBeNull();
    expect(iconType(new Uint8Array())).toBeNull();
  });

  it("reads the emoji favicon, whose quoted href holds > characters (K-1115)", () => {
    const html =
      '<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🍳</text></svg>">';
    const icon = pageDataIcon(html);
    expect(icon && iconType(icon)).toBe("image/svg+xml");
    expect(new TextDecoder().decode(icon!)).toContain("🍳</text></svg>");
  });

  it("skips links in comments, decodes entities, and takes only the first data: link (K-1115)", () => {
    const b64 = btoa(String.fromCharCode(...PNG));
    expect(pageDataIcon(`<!-- <link rel="icon" href="data:image/png;base64,${b64}"> -->`)).toBeNull();
    expect(pageDataIcon(`<!-- old --><link rel="icon" href="data:image/png;base64,${b64}">`)).toEqual(PNG);
    const quoted = pageDataIcon('<link rel="icon" href="data:image/svg+xml,<svg xmlns=&quot;http://www.w3.org/2000/svg&quot;></svg>">');
    expect(new TextDecoder().decode(quoted!)).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(pageDataIcon(`<link rel="icon" href="data:image/png;base64,%%%"><link rel="icon" href="data:image/png;base64,${b64}">`)).toBeNull();
  });

  it("reads a data: icon of a page, as base64 or as text, and ignores a link to a path (K-1115)", () => {
    const b64 = btoa(String.fromCharCode(...PNG));
    expect(pageDataIcon(`<link rel="icon" href="/a.png"><link rel="icon" href="data:image/png;base64,${b64}">`)).toEqual(PNG);
    expect(iconType(pageDataIcon(`<link rel=icon href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">`)!)).toBe("image/svg+xml");
    expect(pageDataIcon('<link rel="icon" href="/favicon.ico">')).toBeNull();
    expect(pageDataIcon('<link rel="icon" href="data:image/png;base64,%%%">')).toBeNull();
  });
});
