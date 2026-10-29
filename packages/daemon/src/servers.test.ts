import { describe, expect, it } from "vitest";
import { parseLsof, parseSs, titleOf } from "./servers.ts";

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

  it("reads ss: the process when this user owns it, null otherwise", () => {
    const output = [
      'LISTEN 0      511        127.0.0.1:5173       0.0.0.0:*    users:(("node",pid=812,fd=21))',
      "LISTEN 0      4096         0.0.0.0:22         0.0.0.0:*",
      'LISTEN 0      4096            [::]:8080          [::]:*    users:(("caddy",pid=9,fd=7))',
      "",
    ].join("\n");
    expect(parseSs(output)).toEqual([
      { port: 22, process: null },
      { port: 5173, process: "node" },
      { port: 8080, process: "caddy" },
    ]);
  });

  it("takes the first title of a page", () => {
    expect(titleOf('<html><head><TITLE lang="en">\n  Vite App \n</TITLE>')).toBe("Vite App");
    expect(titleOf("<p>no title</p>")).toBeNull();
  });
});
