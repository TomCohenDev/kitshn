import { describe, expect, it } from "vitest";
import { cardIcon, machineOs, repoOwner } from "./icons.ts";
import type { Resource } from "./model.ts";

const card = (id: string, kind: Resource["kind"], name = id): Resource => ({
  id,
  kind,
  name,
  addresses: [],
  status: "running",
  group: null,
  machine: null,
});

describe("card icon (K-524)", () => {
  it("shows the stored site icon, versioned by its hash", () => {
    expect(cardIcon(card("a b", "site.static"), { "a b": "f00d" }, null)).toEqual({
      _tag: "site",
      src: "/api/icons/a%20b?v=f00d",
    });
  });

  it("falls back to the kind icon without an own icon", () => {
    expect(cardIcon(card("site", "site.static"), {}, null)).toEqual({ _tag: "kind" });
    expect(cardIcon(card("mac", "machine"), {}, null)).toEqual({ _tag: "kind" });
    expect(cardIcon(card("r", "repo", "not a repo name"), {}, null)).toEqual({ _tag: "kind" });
    // Part 2 gives these kinds their own icons; until then a stored icon of such a card stays unused.
    expect(cardIcon(card("app", "site.compose"), { app: "f00d" }, "linux")).toEqual({ _tag: "kind" });
  });

  it("shows the owner avatar of a repo and the system of a machine", () => {
    expect(cardIcon(card("r", "repo", "Yarden-zamir/kitshn"), {}, null)).toMatchObject({
      _tag: "avatar",
      owner: "Yarden-zamir",
      src: "https://github.com/Yarden-zamir.png?size=64",
    });
    expect(cardIcon(card("mac", "machine"), {}, "macos")).toEqual({ _tag: "os", os: "macos" });
  });

  it("reads the system from the daemon status, and has none for an unknown or missing one", () => {
    expect(machineOs("darwin 25.6.0")).toBe("macos");
    expect(machineOs("linux 6.8.0-1015-oracle")).toBe("linux");
    expect(machineOs("win32 10.0.26100")).toBe("windows");
    expect(machineOs("freebsd 14.1")).toBeNull();
    // A daemon without `os` sends nothing; the Worker reads it as the text "undefined".
    expect(machineOs("undefined")).toBeNull();
  });

  it("reads the owner of a repo name only in the form owner/name", () => {
    expect(repoOwner("Yarden-zamir/kitshn")).toBe("Yarden-zamir");
    expect(repoOwner("kitshn")).toBeNull();
    expect(repoOwner("a/b/c")).toBeNull();
    expect(repoOwner("-bad/x")).toBeNull();
    expect(repoOwner("../x")).toBeNull();
  });
});
