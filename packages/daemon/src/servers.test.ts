import { describe, expect, it } from "vitest";
import { firstBytes, parseLsof, parseSs, titleOf } from "./servers.ts";

describe("running servers (K-619)", () => {
  it("reads lsof: one entry per port, by port, without kitshn's own processes", () => {
    const output = [
      "p1123",
      "cnode",
      "f24",
      "n127.0.0.1:5173",
      "f25",
      "n[::1]:5173",
      "p2108",
      "ccloudflared",
      "f11",
      "n127.0.0.1:20241",
      "p2112",
      "cpython3",
      "f3",
      "n*:8000",
      "",
    ].join("\n");
    expect(parseLsof(output)).toEqual([
      { port: 5173, process: "node" },
      { port: 8000, process: "python3" },
    ]);
  });

  it("reads ss: only listeners of this user, with their process", () => {
    const output = [
      'LISTEN 0      511        127.0.0.1:5173       0.0.0.0:*    users:(("node",pid=812,fd=21)) uid:1000 ino:41 sk:1',
      "LISTEN 0      4096         0.0.0.0:22         0.0.0.0:*    ino:19 sk:2",
      'LISTEN 0      4096            [::]:8080          [::]:*    users:(("caddy",pid=9,fd=7)) uid:1000 ino:7 sk:3',
      'LISTEN 0      4096       127.0.0.1:9000       0.0.0.0:*    users:(("grafana",pid=77,fd=9)) uid:1001 ino:8 sk:4',
      "",
    ].join("\n");
    expect(parseSs(output, 1000)).toEqual([
      { port: 5173, process: "node" },
      { port: 8080, process: "caddy" },
    ]);
  });

  it("reads at most the byte limit of a page, also from one big chunk", async () => {
    const body = `<p>${"x".repeat(96 * 1024)}</p><title>Late</title>`;
    const text = await firstBytes(new Response(body), 64 * 1024);
    expect(new TextEncoder().encode(text).length).toBe(64 * 1024);
    expect(titleOf(text)).toBeNull();
  });

  it("takes the first title of a page", () => {
    expect(titleOf('<html><head><TITLE lang="en">\n  Vite App \n</TITLE>')).toBe("Vite App");
    expect(titleOf("<p>no title</p>")).toBeNull();
  });
});
