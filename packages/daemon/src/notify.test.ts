import { describe, expect, it } from "vitest";
import { withNotify } from "./notify.ts";

const notify = { url: "https://kit.example.com/notify", token: "secret-token" };

describe("withNotify (K-1908)", () => {
  it("gives every service the address and the token from the environment, and writes no token", () => {
    const config = {
      name: "money",
      services: {
        web: { image: "web", environment: { OWN: "x" } },
        worker: { image: "worker" },
        // Explicit lines like money's: Compose interpolated the token into the config.
        cron: {
          image: "cron",
          environment: { KITSHN_NOTIFY_URL: notify.url, KITSHN_NOTIFY_TOKEN: notify.token },
        },
      },
    };
    const result = withNotify(config, notify);
    expect(result).toEqual({
      name: "money",
      services: {
        web: {
          image: "web",
          environment: { OWN: "x", KITSHN_NOTIFY_URL: notify.url, KITSHN_NOTIFY_TOKEN: null },
        },
        worker: {
          image: "worker",
          environment: { KITSHN_NOTIFY_URL: notify.url, KITSHN_NOTIFY_TOKEN: null },
        },
        cron: { image: "cron", environment: { KITSHN_NOTIFY_URL: notify.url, KITSHN_NOTIFY_TOKEN: null } },
      },
    });
    expect(JSON.stringify(result)).not.toContain(notify.token);
  });

  it("keeps a value that the app sets itself", () => {
    const config = {
      services: {
        web: { environment: { KITSHN_NOTIFY_URL: "https://other.example.com", KITSHN_NOTIFY_TOKEN: "own" } },
      },
    };
    expect(withNotify(config, notify)).toEqual(config);
  });

  it("changes nothing without a notify token, and refuses an environment that is not a map", () => {
    const config = { services: { web: { image: "web" } } };
    expect(withNotify(config, undefined)).toBe(config);
    expect(() => withNotify({ services: { web: { environment: ["A=1"] } } }, notify)).toThrow(/not a map/);
  });
});
