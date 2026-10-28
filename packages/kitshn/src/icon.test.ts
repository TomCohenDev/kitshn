import { describe, expect, it } from "vitest";
import { ICON_LIMIT, iconType, pickSiteIcon } from "./icon.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0]);
const SVG = new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const text = (value: string) => new TextEncoder().encode(value);

const site = (files: Record<string, Uint8Array>) => (path: string) => files[path] ?? null;

describe("site icon (K-1112, K-1113)", () => {
  it("takes the link rel=icon of index.html over favicon.ico and the manifest", () => {
    const picked = pickSiteIcon(
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

  it("takes favicon.ico when index.html links no icon, and ignores apple-touch-icon", () => {
    const picked = pickSiteIcon(
      site({
        "/index.html": text('<link rel="apple-touch-icon" href="/touch.png">'),
        "/touch.png": PNG,
        "/favicon.ico": ICO,
      }),
    );
    expect(picked.icon).toMatchObject({ path: "/favicon.ico", type: "image/x-icon" });
  });

  it("takes the first icon of the linked web manifest, relative to the manifest", () => {
    const picked = pickSiteIcon(
      site({
        "/index.html": text("<link rel=manifest href=/assets/site.webmanifest>"),
        "/assets/site.webmanifest": text(JSON.stringify({ icons: [{ src: "icon-192.png" }, { src: "/big.png" }] })),
        "/assets/icon-192.png": PNG,
      }),
    );
    expect(picked.icon?.path).toBe("/assets/icon-192.png");
  });

  it("skips a candidate that is too large or not an image, and says why", () => {
    const picked = pickSiteIcon(
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

  it("has no icon for a site without one, so the card shows its kind icon", () => {
    const picked = pickSiteIcon(site({ "/index.html": text('<link rel="icon" href="https://cdn.example.com/x.png">') }));
    expect(picked).toEqual({ icon: null, notes: [] });
  });

  it("knows image types by their bytes, not by their name", () => {
    expect(iconType(PNG)).toBe("image/png");
    expect(iconType(text("<html><svg></svg></html>"))).toBeNull();
    expect(iconType(new Uint8Array())).toBeNull();
  });
});
