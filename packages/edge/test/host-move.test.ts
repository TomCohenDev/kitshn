import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { callerOf } from "../src/worker/auth.ts";
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
