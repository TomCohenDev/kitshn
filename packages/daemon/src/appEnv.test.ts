import { describe, expect, it } from "vitest";
import { withAppEnv } from "./appEnv.ts";

const notify = { url: "https://kit.example.com/notify", token: "secret-token" };

describe("withAppEnv (K-1908, K-822)", () => {
  it("gives every service the address and the token from the environment, and leaves the token in no field", () => {
    const config = {
      name: "money",
      services: {
        web: { image: "web", environment: { OWN: "x" } },
        worker: { image: "worker" },
        // Explicit lines like money's, a token under another key and in a command: Compose interpolated them all.
        cron: {
          image: "cron",
          command: ["sh", "-c", `curl -H 'Authorization: Bearer ${notify.token}' ${notify.url}`],
          labels: { token: notify.token },
          environment: {
            KITSHN_NOTIFY_URL: notify.url,
            KITSHN_NOTIFY_TOKEN: notify.token,
            MY_TOKEN: notify.token,
          },
        },
      },
    };
    const result = withAppEnv(config, { notify });
    const again = "${KITSHN_NOTIFY_TOKEN}";
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
        cron: {
          image: "cron",
          command: ["sh", "-c", `curl -H 'Authorization: Bearer ${again}' ${notify.url}`],
          labels: { token: again },
          environment: { KITSHN_NOTIFY_URL: notify.url, KITSHN_NOTIFY_TOKEN: again, MY_TOKEN: again },
        },
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
    expect(withAppEnv(config, { notify })).toEqual(config);
  });

  it("gives every service the Access values in the checked config, and keeps a value that the app sets itself", () => {
    const access = { teamDomain: "team.cloudflareaccess.com", audiences: ["aud-1", "aud-2"] };
    const config = {
      services: {
        web: { image: "web" },
        api: { image: "api", environment: { KITSHN_ACCESS_AUDIENCES: "own" } },
      },
    };
    expect(withAppEnv(config, { access })).toEqual({
      services: {
        web: {
          image: "web",
          environment: {
            KITSHN_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
            KITSHN_ACCESS_AUDIENCES: "aud-1,aud-2",
          },
        },
        api: {
          image: "api",
          environment: {
            KITSHN_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
            KITSHN_ACCESS_AUDIENCES: "own",
          },
        },
      },
    });
  });

  it("changes nothing without a notify token, and refuses an environment that is not a map", () => {
    const config = { services: { web: { image: "web" } } };
    expect(withAppEnv(config, {})).toBe(config);
    expect(() => withAppEnv({ services: { web: { environment: ["A=1"] } } }, { notify })).toThrow(
      /not a map/,
    );
  });
});
