import { describe, expect, it } from "vitest";
import type { PolicyBody } from "../core/access.ts";
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

const policyRow = (key: string, cfId: string, decision: PolicyBody["decision"]): [string, AccessRow] => [
  key,
  { key, cfId, aud: "", body: JSON.stringify({ decision }), tried: "", error: null },
];

/** An application row; `body` is what Cloudflare accepted, `tried` an update that did not land yet. */
const appRow = (key: string, policyIds: Array<string>, aud: string, body?: string): [string, AccessRow] => {
  const accepted = JSON.stringify({ policies: policyIds.map((id) => ({ id })) });
  return [key, { key, cfId: `cf-${key}`, aud, body: body ?? accepted, tried: accepted, error: null }];
};

describe("live sites (K-1104 to K-1108)", () => {
  it("routes each site through the tunnel, with Host localhost for a dev server", () => {
    expect(tunnelConfig([site("b", "m", true, true), site("a", "m", true)], () => bypass)?.config.ingress).toEqual([
      { hostname: "a.example.com", service: "http://localhost:5173" },
      {
        hostname: "b.example.com",
        service: "http://localhost:5173",
        originRequest: { httpHostHeader: "localhost" },
      },
      { service: "http_status:404" },
    ]);
  });

  it("makes cloudflared check the Access JWT of the application (K-603)", () => {
    const access = new Map<string, IngressAccess>([
      ["a", { kind: "check", teamName: "team", aud: "aud-a" }],
      ["b", { kind: "check", teamName: "team", aud: "aud-b" }],
    ]);
    const sites = [site("a", "m", true), site("b", "m", true, true)];
    expect(tunnelConfig(sites, (item) => access.get(item.name)!)?.config.ingress).toEqual([
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

  it("takes the Bypass decision from what Cloudflare accepted (K-403)", () => {
    const team = "team.cloudflareaccess.com";
    const rows = new Map([
      policyRow("policy:everyone:people", "p-bypass", "bypass"),
      policyRow("policy:owner:people", "p-allow", "allow"),
      appRow("app:live-m-pub:pub.example.com", ["p-bypass", "p-allow"], "aud-pub"),
      appRow("app:live-m-priv:priv.example.com", ["p-allow"], "aud-priv"),
      // A Bypass application needs no tag, so it never holds up its machine.
      appRow("app:live-m-new:new.example.com", ["p-bypass"], ""),
      appRow("app:live-m-wait:wait.example.com", ["p-allow"], ""),
    ]);
    const of = (name: string, domain = team) => ingressAccess(site(name, "m", true), rows, domain);
    expect(of("pub")).toEqual({ kind: "bypass" });
    expect(of("new")).toEqual({ kind: "bypass" });
    expect(of("priv")).toEqual({ kind: "check", teamName: "team", aud: "aud-priv" });
    expect(of("wait")).toBeNull();
    expect(() => of("priv", "")).toThrow(/ACCESS_TEAM_DOMAIN/);

    // Everyone to a circle: the check comes on only after Cloudflare accepted the application without
    // Bypass, so a failed update never locks out the members.
    const key = "app:live-m-pub:pub.example.com";
    expect(of("pub")).toEqual({ kind: "bypass" });
    rows.set(...appRow(key, ["p-allow"], "aud-pub"));
    expect(of("pub")).toEqual({ kind: "check", teamName: "team", aud: "aud-pub" });
    // The other way, the check stays while Cloudflare has not accepted the Bypass policy (fails closed).
    rows.set(...appRow(key, ["p-bypass"], "aud-pub", ""));
    expect(of("pub")).toEqual({ kind: "check", teamName: "team", aud: "aud-pub" });
  });

  it("writes no ingress for a machine while one of its applications has no audience tag (K-603)", () => {
    // At deploy, rows from before the audience tag column have an id but no tag. The tunnel keeps
    // the ingress that Cloudflare has instead of dropping the sites.
    const rows = new Map([
      policyRow("policy:owner:people", "p-allow", "allow"),
      appRow("app:live-m-a:a.example.com", ["p-allow"], "aud-a"),
      appRow("app:live-m-b:b.example.com", ["p-allow"], ""),
    ]);
    const accessOf = (item: LiveSite) => ingressAccess(item, rows, "team.cloudflareaccess.com");
    expect(tunnelConfig([site("a", "m", true), site("b", "m", true)], accessOf)).toBeNull();
    expect(tunnelConfig([site("a", "m", true)], accessOf)?.config.ingress).toHaveLength(2);
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
