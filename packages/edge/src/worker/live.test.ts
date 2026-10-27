import { describe, expect, it } from "vitest";
import type { DesiredAccess, PolicyBody } from "../core/access.ts";
import type { AccessRow } from "./access-sync.ts";
import {
  type IngressAccess,
  type LiveSite,
  escapeHtml,
  ingressAccess,
  liveSiteId,
  offlineReason,
  parseSites,
  reachableAddresses,
  seenText,
  sitesNeedingRoutes,
  tunnelConfig,
} from "./live.ts";

const site = (name: string, machineId: string, up: boolean, dev = false): LiveSite => ({
  id: `live-${machineId}-${name}`,
  machineId,
  name,
  address: `${name}.example.com`,
  target: "http://localhost:5173",
  dev,
  up,
  lastUp: 0,
  state: "ok",
});

const bypass: IngressAccess = { kind: "bypass" };

describe("live sites (K-1104 to K-1108)", () => {
  it("routes each site through the tunnel, with Host localhost for a dev server", () => {
    expect(tunnelConfig([site("b", "m", true, true), site("a", "m", true)], () => bypass).config.ingress).toEqual([
      { hostname: "a.example.com", service: "http://localhost:5173" },
      {
        hostname: "b.example.com",
        service: "http://localhost:5173",
        originRequest: { httpHostHeader: "localhost" },
      },
      { service: "http_status:404" },
    ]);
  });

  it("makes cloudflared check the Access JWT, and writes no rule without an audience tag (K-603)", () => {
    const access = new Map<string, IngressAccess>([
      ["a", { kind: "check", teamName: "team", aud: "aud-a" }],
      ["b", { kind: "check", teamName: "team", aud: "aud-b" }],
      ["c", { kind: "unknown" }],
    ]);
    const sites = [site("a", "m", true), site("b", "m", true, true), site("c", "m", true)];
    expect(tunnelConfig(sites, (item) => access.get(item.name)!).config.ingress).toEqual([
      {
        hostname: "a.example.com",
        service: "http://localhost:5173",
        originRequest: { access: { required: true, teamName: "team", audTag: ["aud-a"] } },
      },
      {
        hostname: "b.example.com",
        service: "http://localhost:5173",
        originRequest: {
          httpHostHeader: "localhost",
          access: { required: true, teamName: "team", audTag: ["aud-b"] },
        },
      },
      { service: "http_status:404" },
    ]);
  });

  it("checks every application except one with a Bypass policy (K-403)", () => {
    const policy = (decision: PolicyBody["decision"]): PolicyBody => ({
      name: decision,
      decision,
      include: [],
      require: [],
      exclude: [],
    });
    const app = (policyKeys: Array<string>) => ({
      name: "app",
      type: "self_hosted" as const,
      domain: "x",
      session_duration: "720h",
      same_site_cookie_attribute: "lax" as const,
      policyKeys,
    });
    const desired: DesiredAccess = {
      policies: new Map([
        ["policy:everyone:people", policy("bypass")],
        ["policy:owner:people", policy("allow")],
      ]),
      apps: new Map([
        ["app:live-m-pub:pub.example.com", app(["policy:everyone:people", "policy:owner:people"])],
        ["app:live-m-priv:priv.example.com", app(["policy:owner:people"])],
      ]),
    };
    const row = (key: string, aud: string): [string, AccessRow] => [
      key,
      { key, cfId: "cf", aud, body: "{}", tried: "", error: null },
    ];
    const rows = new Map([
      row("app:live-m-pub:pub.example.com", "aud-pub"),
      row("app:live-m-priv:priv.example.com", "aud-priv"),
      row("app:live-m-new:new.example.com", ""),
    ]);
    const of = (name: string, domain = "team.cloudflareaccess.com") =>
      ingressAccess(site(name, "m", true), desired, rows, domain);
    expect(of("pub")).toEqual({ kind: "bypass" });
    expect(of("priv")).toEqual({ kind: "check", teamName: "team", aud: "aud-priv" });
    expect(of("new")).toEqual({ kind: "unknown" });
    expect(() => of("priv", "")).toThrow(/ACCESS_TEAM_DOMAIN/);
  });

  it("needs an offline route when the site is down or its machine is offline", () => {
    const sites = [site("up", "on", true), site("down", "on", false), site("away", "off", true)];
    expect(sitesNeedingRoutes(sites, new Set(["on"])).map((item) => item.name)).toEqual(["down", "away"]);
  });

  it("refuses names and targets that are not valid", () => {
    const { sites, refused } = parseSites([
      { name: "ok", target: "unix:/run/app.sock", dev: false, up: true },
      { name: "Bad Name", target: "http://localhost:1", up: true },
      { name: "remote", target: "http://10.0.0.5:80", up: true },
    ]);
    expect(sites.map((item) => item.name)).toEqual(["ok"]);
    expect(refused).toHaveLength(2);
  });

  it("writes the offline page text for both causes, escaped", () => {
    expect(offlineReason("Mac", false)).toContain("It comes back when Mac is on.");
    expect(offlineReason("Mac", true)).toContain("server on Mac");
    expect(seenText(0, 12 * 60_000)).toBe("12 minutes ago");
    expect(escapeHtml('<b>"x"</b>')).toBe("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
  });

  it("keeps two long site ids apart and refuses port 0", () => {
    const machine = "a-machine-name-that-is-forty-seven-characters-x";
    expect(liveSiteId(machine, "dashboard-api")).not.toBe(liveSiteId(machine, "dashboard-web"));
    expect(liveSiteId(machine, "dashboard-api").length).toBeLessThanOrEqual(63);
    expect(parseSites([{ name: "x", target: "http://localhost:0", up: true }]).sites).toEqual([]);
  });

  it("counts an address as reachable while accepted ingress, a DNS record or a route has it", () => {
    const applied = JSON.stringify(tunnelConfig([site("old", "m", true)], () => bypass));
    const reachable = reachableAddresses({
      ingress: [applied, ""],
      records: [
        { address: "dns.example.com", record_id: "r1" },
        { address: "never.example.com", record_id: "" },
      ],
      routes: [{ address: "route.example.com", route_id: "x" }],
    });
    expect([...reachable].sort()).toEqual(["dns.example.com", "old.example.com", "route.example.com"]);
  });
});
