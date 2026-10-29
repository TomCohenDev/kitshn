import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type AssetSession, uploadAssets } from "./assets.ts";

/** A folder with one file, and a session that asks for every file of the manifest in one bucket. */
function site() {
  const dir = mkdtempSync(join(tmpdir(), "kitshn-assets-"));
  writeFileSync(join(dir, "index.html"), "<p>hi</p>");
  const open = async (manifest: Record<string, { hash: string }>): Promise<AssetSession> => ({
    jwt: "session",
    buckets: [Object.values(manifest).map((file) => file.hash)],
    uploadUrl: "https://upload.example/assets",
  });
  return { dir, open, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) };
}

const answer = (status: number, body: string) => new Response(body, { status });
const page = "<!DOCTYPE html><title>502 Bad Gateway</title>";

describe("asset upload (K-805)", () => {
  it("tries a failed bucket again after 5 s, then 15 s, and goes on when it lands", async () => {
    using folder = site();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(answer(502, page))
      .mockResolvedValueOnce(answer(200, JSON.stringify({ success: true, result: { jwt: "done" } })));
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(fetch);
    const pauses: Array<number> = [];
    const result = await uploadAssets(folder.dir, folder.open, async (ms) => void pauses.push(ms));
    expect([result.jwt, pauses, fetch.mock.calls.length]).toEqual(["done", [5_000], 2]);
  });

  it("fails with the status and the start of an answer that is no JSON, after three tries", async () => {
    using folder = site();
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer(502, page));
    const pauses: Array<number> = [];
    await expect(uploadAssets(folder.dir, folder.open, async (ms) => void pauses.push(ms))).rejects.toThrow(
      "the file upload answered 502: <!DOCTYPE html><title>502 Bad Gateway</title>",
    );
    expect(pauses).toEqual([5_000, 15_000]);
  });
});
