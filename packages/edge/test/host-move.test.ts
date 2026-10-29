import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { callerOf } from "../src/worker/auth.ts";
import { adminHosts } from "../src/worker/env.ts";
import worker from "../src/worker/index.ts";
import { accessToken, stubAccessCerts } from "./access.ts";

afterEach(() => vi.restoreAllMocks());

it("takes an Access token of the old host's application only during the host move (K-1209)", async () => {
  stubAccessCerts();
  const token = await accessToken("old-connect-aud", { common_name: "machine.access" });
  const request = new Request("https://kit.example.com/connect", {
    headers: { "cf-access-jwt-assertion": token },
  });
  expect(await callerOf(request, env, "new-connect-aud,old-connect-aud")).toMatchObject({
    visitor: { clientId: "machine.access" },
  });
  expect(await callerOf(request, env, "new-connect-aud")).toBeTypeOf("string");
});

it("counts an old host only when it is a host under the kitshn zone (K-1209)", () => {
  const hosts = (old: string | undefined) =>
    adminHosts({
      KITSHN_HOST: "kitshn.example.com",
      KITSHN_ZONE: "example.com",
      ...(old === undefined ? {} : { KITSHN_OLD_HOST: old }),
    });
  expect(hosts(undefined)).toEqual(["kitshn.example.com"]);
  expect(hosts(" Kit.Example.com. ")).toEqual(["kitshn.example.com", "kit.example.com"]);
  expect(hosts("kit.other.com")).toEqual(["kitshn.example.com"]);
  expect(hosts("example.com")).toEqual(["kitshn.example.com"]);
  expect(hosts("kitshn.example.com")).toEqual(["kitshn.example.com"]);
});

it("answers the old host as the admin, not with the offline route, only during the host move (K-1209)", async () => {
  stubAccessCerts();
  const fetchOld = async (extra: Record<string, string>) => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://old.example.com/api/state") as Request<unknown, IncomingRequestCfProperties>,
      { ...env, ...extra },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  };
  const during = await fetchOld({ KITSHN_OLD_HOST: "old.example.com" });
  expect(during.status).toBe(401);
  const after = await fetchOld({});
  expect(after.status).not.toBe(401);
});
