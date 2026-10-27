import { describe, expect, it } from "vitest";
import {
  type LiveSite,
  escapeHtml,
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

describe("live sites (K-1104 to K-1108)", () => {
  it("routes each site through the tunnel, with Host localhost for a dev server", () => {
    expect(tunnelConfig([site("b", "m", true, true), site("a", "m", true)]).config.ingress).toEqual([
      { hostname: "a.example.com", service: "http://localhost:5173" },
      {
        hostname: "b.example.com",
        service: "http://localhost:5173",
        originRequest: { httpHostHeader: "localhost" },
      },
      { service: "http_status:404" },
    ]);
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
    const applied = JSON.stringify(tunnelConfig([site("old", "m", true)]));
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
