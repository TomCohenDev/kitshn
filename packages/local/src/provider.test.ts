import { describe, expect, it } from "vitest";
import { type ProviderReport, desiredProblem, readAnswer, readRequest, reportProblem } from "./index.ts";

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
    [
      "a card setting whose default is not one of its values (K-717)",
      t3([], {
        kinds: [
          {
            id: "t3.app",
            name: "T3 app",
            levels: { view: "view" },
            settings: [
              {
                id: "updateChannel",
                title: "Update channel",
                values: ["nightly", "daily"],
                default: "weekly",
              },
            ],
          },
        ],
      }),
    ],
    [
      "a list cell that is no column of its list (K-1625)",
      t3([
        {
          ...app,
          lists: [
            {
              id: "tasks",
              title: "Tasks",
              columns: [{ id: "name", title: "Name" }],
              rows: [{ id: "r1", cells: { name: "x", other: "y" } }],
            },
          ],
        },
      ]),
    ],
    [
      "a resource over 64 KB (K-1625)",
      t3([
        {
          ...app,
          facts: Array.from({ length: 20 }, (_, index) => ({ label: `f${index}`, value: "é".repeat(200) })),
          stickers: [],
          lists: [
            {
              id: "big",
              title: "Big",
              columns: [{ id: "c", title: "C" }],
              rows: Array.from({ length: 100 }, (_, index) => ({
                id: `r${index}`,
                cells: { c: "x".repeat(200) },
              })),
            },
            {
              id: "big2",
              title: "Big",
              columns: [{ id: "c", title: "C" }],
              rows: Array.from({ length: 100 }, (_, index) => ({
                id: `r${index}`,
                cells: { c: "x".repeat(200) },
              })),
            },
            {
              id: "big3",
              title: "Big",
              columns: [{ id: "c", title: "C" }],
              rows: Array.from({ length: 100 }, (_, index) => ({
                id: `r${index}`,
                cells: { c: "x".repeat(200) },
              })),
            },
          ],
        },
      ]),
    ],
    [
      "a list row with a command that its kind does not have (K-1625)",
      t3([
        {
          ...app,
          kind: "t3.thread",
          lists: [
            {
              id: "tasks",
              title: "Tasks",
              columns: [{ id: "name", title: "Name" }],
              rows: [{ id: "r1", cells: {}, commands: ["restart"] }],
            },
          ],
        },
      ]),
    ],
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

  it("takes a desired state part only for a kind with state, and at most 64 KB (K-709)", () => {
    const kinds = [{ id: "t3.settings", name: "settings", levels: {}, state: {} }, t3([]).kinds[0]!];
    expect(desiredProblem(kinds, "t3.settings", { theme: "dark" })).toBeNull();
    expect(desiredProblem(kinds, "t3.app", {})).toMatch(/no desired state/);
    expect(desiredProblem(kinds, "t3.settings", "x".repeat(70_000))).toMatch(/at most/);
  });
});
