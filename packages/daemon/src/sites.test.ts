import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { addSite, parseSiteFile, probe, targetOf } from "./sites.ts";

describe("exposed sites (K-1104, K-1107)", () => {
  it("turns a port or a socket path into a tunnel target", () => {
    expect(targetOf("5173")).toBe("http://localhost:5173");
    expect(targetOf("http://127.0.0.1:5173/app")).toBe("http://localhost:5173");
    expect(targetOf("/run/app.sock")).toBe("unix:/run/app.sock");
    expect(targetOf("70000")).toEqual({ error: expect.any(String) });
    expect(targetOf("example.com")).toEqual({ error: expect.stringContaining("another host") });
  });

  it("replaces a site with the same name and refuses a bad name", () => {
    const one = addSite([], { name: "demo", target: "http://localhost:1", dev: false });
    expect(addSite(one as never, { name: "demo", target: "http://localhost:2", dev: true })).toEqual([
      { name: "demo", target: "http://localhost:2", dev: true },
    ]);
    expect(addSite([], { name: "No", target: "http://localhost:1", dev: false })).toMatch(/name/);
  });

  it("reports a listening port up and a closed one down", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    expect(await probe(`http://localhost:${port}`)).toBe(true);
    server.close();
    await new Promise((resolve) => server.once("close", resolve));
    expect(await probe(`http://localhost:${port}`)).toBe(false);
  });

  it("treats a broken sites.json as broken, not as empty", () => {
    expect(parseSiteFile({})).toBeNull();
    expect(parseSiteFile([{ name: "x" }])).toBeNull();
    expect(parseSiteFile([{ name: "x", target: "http://example.com" }])).toBeNull();
    expect(parseSiteFile([])).toEqual([]);
    // K-1104: the circle of `kitshn expose --circle` stays with its site.
    expect(parseSiteFile([{ name: "x", target: "http://localhost:1", circle: "agents" }])).toEqual([
      { name: "x", target: "http://localhost:1", dev: false, circle: "agents" },
    ]);
  });
});
