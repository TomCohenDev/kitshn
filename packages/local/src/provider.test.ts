import { describe, expect, it } from "vitest";
import { type ProviderReport, readAnswer, readRequest, reportProblem } from "./index.ts";

const t3 = (resources: ProviderReport["resources"], extra: Partial<ProviderReport> = {}): ProviderReport => ({
  name: "t3",
  online: true,
  kinds: [
    { id: "t3.app", name: "T3 app", levels: { view: "view", use: "use", control: "control" } },
    { id: "t3.thread", name: "thread", levels: { view: "view", use: "send" } },
    { id: "t3.settings", name: "settings", levels: {} },
  ],
  commands: [{ id: "restart", title: "Restart server", kinds: ["t3.app"], confirm: true }],
  resources,
  ...extra,
});
const app = { id: "app", kind: "t3.app", name: "T3 on vps", status: "running" } as const;

describe("provider reports (K-704, K-705)", () => {
  it("takes kinds with the provider prefix, known parents and free site names", () => {
    const thread = { id: "th-1", kind: "t3.thread", name: "Fix", status: "running", parent: "app" } as const;
    expect(
      reportProblem(t3([{ ...app, site: { name: "t3-vps", port: 3773 } }, thread]), [], new Set(), new Set()),
    ).toBeNull();
  });

  it.each([
    [
      "a kind of another prefix",
      t3([], { kinds: [{ id: "other.app", name: "x", levels: { view: "view" } }] }),
    ],
    [
      "a command of an unknown kind",
      t3([], { commands: [{ id: "x", title: "X", kinds: ["t3.nope"], confirm: false }] }),
    ],
    ["a resource of an unknown kind", t3([{ ...app, kind: "t3.nope" }])],
    ["a card of a kind without levels (K-709)", t3([{ ...app, kind: "t3.settings" }])],
    ["an unknown parent", t3([{ ...app, parent: "gone" }])],
    ["two resources with one id", t3([app, app])],
  ])("refuses %s", (_, report) => {
    expect(reportProblem(report, [], new Set(), new Set())).not.toBeNull();
  });

  it("refuses a site name that kitshn, sites.json or another provider holds", () => {
    const withSite = t3([{ ...app, site: { name: "shared", port: 3773 } }]);
    expect(reportProblem(withSite, [], new Set(["shared"]), new Set())).toMatch(/in use/);
    // K-817: a name of kitshn itself would put a second Access app on that host.
    expect(reportProblem(withSite, [], new Set(), new Set(["shared"]))).toMatch(/name of kitshn itself/);
    const other = { ...withSite, name: "other", kinds: [], commands: [] };
    expect(reportProblem(withSite, [other], new Set(), new Set())).toMatch(/belongs to the provider other/);
  });

  it("refuses more than 500 cards on one machine", () => {
    const many = Array.from({ length: 300 }, (_, index) => ({ ...app, id: `a${index}` }));
    expect(reportProblem(t3(many), [{ ...t3(many), name: "other" }], new Set(), new Set())).toMatch(
      /more than 500/,
    );
  });

  it("decodes a register line and refuses a provider name that kitshn's kinds use (K-302)", () => {
    const line = (provider: string) =>
      JSON.stringify({ id: "1", type: "register", provider, kinds: [], commands: [], resources: [] });
    expect(readRequest(line("t3"))).toMatchObject({
      ok: true,
      request: { type: "register", provider: "t3" },
    });
    expect(readRequest(line("site"))).toMatchObject({ ok: false, answer: { id: "1", type: "error" } });
  });

  it("keeps a grant table whole when a rule has a type that this reader does not know (K-706)", () => {
    const grant = {
      circle: {
        id: "her",
        name: "Her",
        match: "all",
        needsPasskey: false,
        rules: [{ email: "a@b.c" }, { future: 1 }],
      },
      level: "send",
      endsAt: null,
    };
    const answer = readAnswer(JSON.stringify({ type: "grants", provider: "t3", tables: { a: [grant] } }));
    expect(answer).toMatchObject({
      tables: { a: [{ circle: { rules: [{ email: "a@b.c" }, { unknown: "future" }] } }] },
    });
  });
});
