import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProviderReport, ReachedCard } from "@kitshn/local";
import { describe, expect, it } from "vitest";
import { linkPairs, linkVerdict, nextReport, probeLink, providerChecks } from "./health.ts";

const card = (machineId: string, address: string | null): ReachedCard => ({
  machineId,
  machineName: machineId.toUpperCase(),
  kind: "t3.app",
  id: `app-${machineId}`,
  address,
  level: "standard",
});
const provider = (name: string, online: boolean) => ({ name, online }) as ProviderReport;
const token = { clientId: "id.access", clientSecret: "secret" };

describe("the health check (K-630)", () => {
  it("fails a provider that no connection holds, and checks each provider and machine with an address once", () => {
    expect(providerChecks([provider("t3", true), provider("old", false)])).toEqual([
      { provider: "t3", error: null },
      { provider: "old", error: "no connection holds the provider" },
    ]);
    const reach = [card("b", "t3-b.example.com"), card("b", "t3-b.example.com"), card("c", null)];
    expect(linkPairs(["t3"], () => reach)).toEqual([{ provider: "t3", machineId: "b" }]);
  });

  it("passes any answer of the origin, but not a refused token, an Access login or a server error", () => {
    expect([200, 302, 404].map((status) => linkVerdict(status, "/login"))).toEqual([null, null, null]);
    expect(linkVerdict(302, "https://team.cloudflareaccess.com/cdn-cgi/access/login")).toContain("Access");
    expect([401, 403, 502, 530].map((status) => linkVerdict(status, null) !== null)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it("reaches the card's address with the machine token, as the link proxy does (K-1609)", async () => {
    const seen: Array<string | undefined> = [];
    let status = 200;
    const server = createServer((request, response) => {
      seen.push(request.headers["cf-access-client-id"] as string | undefined);
      response.writeHead(status).end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const reachOf = () => [card("b", address)];
    try {
      const pair = { provider: "t3", machineId: "b" };
      expect(await probeLink(reachOf, token, pair, fetch, "http")).toMatchObject({
        status: 200,
        error: null,
      });
      status = 401;
      expect((await probeLink(reachOf, token, pair, fetch, "http")).error).toContain("401");
      expect(seen).toEqual(["id.access", "id.access"]);
      expect((await probeLink(reachOf, null, pair, fetch, "http")).error).toContain("no machine token");
      expect(
        (await probeLink(reachOf, token, { provider: "t3", machineId: "z" }, fetch, "http")).error,
      ).toContain("reaches no address");
    } finally {
      server.close();
    }
  });

  it("counts failures in a row, keeps when they started, and starts again at 0 when a check passes", () => {
    const link = (error: string | null) => ({ provider: "t3", machineId: "b", status: null, ms: 1, error });
    const first = nextReport(null, [{ provider: "t3", error: null }], [link("no answer")], 100);
    expect(first.links[0]).toMatchObject({ failures: 1, since: 100 });
    expect(first.providers[0]).toMatchObject({ failures: 0, since: null });
    const second = nextReport(first, [{ provider: "t3", error: "down" }], [link("no answer")], 200);
    expect(second.links[0]).toMatchObject({ failures: 2, since: 100 });
    expect(second.providers[0]).toMatchObject({ failures: 1, since: 200 });
    const recovered = nextReport(second, [{ provider: "t3", error: null }], [link(null)], 300);
    expect(recovered.links[0]).toMatchObject({ failures: 0, since: null, error: null });
    // An error longer than the report allows is cut, so the report still decodes (K-630).
    expect(nextReport(null, [], [link("x".repeat(500))], 1).links[0]?.error).toHaveLength(160);
  });
});
