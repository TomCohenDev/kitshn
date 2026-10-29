import { describe, expect, it } from "vitest";
import { parseSiteInput, serversOf } from "./sites.ts";

describe("parseSiteInput (K-1131)", () => {
  it.each([
    ["5565", 5565, []],
    [":5565", 5565, []],
    ["localhost:5565", 5565, []],
    [" http://127.0.0.1:5565/ ", 5565, []],
    ["http://[::1]:5565/app?x=1#top", 5565, ["Left out /app?x=1#top: the site starts at /."]],
    ["https://localhost:8443", 8443, ["kitshn reaches the server over http on its machine."]],
    ["http://app.localhost", 80, ["No port given, so kitshn takes 80."]],
  ])("reads %s as a local port", (text, port, notes) => {
    expect(parseSiteInput(text)).toEqual({ kind: "port", port, notes });
  });

  it("keeps a socket path, and names another host as remote", () => {
    expect(parseSiteInput("/run/app.sock")).toEqual({ kind: "socket", path: "/run/app.sock" });
    expect(parseSiteInput("https://Foo.Bar/x")).toEqual({ kind: "remote", host: "foo.bar" });
  });

  it.each(["", "70000", "0", "ftp://localhost:21", "/run/my app.sock", "http://"])(
    "refuses %j with a reason",
    (text) => {
      expect(parseSiteInput(text)).toEqual({ kind: "invalid", reason: expect.any(String) });
    },
  );
});

describe("serversOf (K-619)", () => {
  it("keeps valid entries by port, cuts long text, and drops the rest", () => {
    expect(
      serversOf([
        { port: 8080, process: "node", status: 200, title: "x".repeat(100) },
        { port: 70000, process: "bad" },
        "junk",
        { port: 22, process: null, status: null, title: null },
      ]),
    ).toEqual([
      { port: 22, process: null, status: null, title: null },
      { port: 8080, process: "node", status: 200, title: "x".repeat(80) },
    ]);
    expect(serversOf(null)).toEqual([]);
  });
});
