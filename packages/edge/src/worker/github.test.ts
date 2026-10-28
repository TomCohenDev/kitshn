import { generateKeyPairSync } from "node:crypto";
import { importPKCS8 } from "jose";
import { describe, expect, it, vi } from "vitest";
import { dispatchDeploy, pkcs8Pem, reposOnGitHub } from "./github.ts";

describe("GitHub App key (K-718)", () => {
  it("takes the PKCS #1 key that GitHub gives, and leaves a PKCS #8 key as it is", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(pkcs8Pem(pkcs1).replace(/\s+/g, "")).toBe(pkcs8.replace(/\s+/g, ""));
    await expect(importPKCS8(pkcs8Pem(pkcs1), "RS256")).resolves.toBeDefined();
    expect(pkcs8Pem(pkcs8)).toBe(pkcs8);
  });
  it("reaches the repo by its id only: a token for that id, its current name, then the branch ref", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const calls: Array<{ url: string; body: unknown }> = [];
    // A suspended installation is skipped, two others refuse, and the repo has a new name since its last deploy.
    const answers: Array<Response> = [
      Response.json([{ id: 5, suspended_at: "2026-10-01T00:00:00Z" }, { id: 6 }, { id: 7 }, { id: 42 }]),
      Response.json({ message: "Forbidden" }, { status: 403 }),
      Response.json({ message: "not accessible" }, { status: 422 }),
      Response.json({ token: "t" }),
      Response.json({ total_count: 1, repositories: [{ id: 1001, full_name: "o/renamed" }] }),
      new Response(null, { status: 204 }),
    ];
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      const answer = answers[calls.length - 1];
      if (!answer) throw new Error(`No answer for ${String(url)}`);
      return answer;
    });
    await expect(dispatchDeploy({ id: "1", key }, "1001", "main", "kitshn.yml")).resolves.toBe("o/renamed");
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/app/installations?per_page=100",
      "https://api.github.com/app/installations/6/access_tokens",
      "https://api.github.com/app/installations/7/access_tokens",
      "https://api.github.com/app/installations/42/access_tokens",
      "https://api.github.com/installation/repositories",
      "https://api.github.com/repos/o/renamed/actions/workflows/kitshn.yml/dispatches",
    ]);
    expect(calls[3]?.body).toEqual({ repository_ids: [1001], permissions: { actions: "write" } });
    expect(calls[5]?.body).toEqual({ ref: "refs/heads/main" });
  });
});

describe("deleted repos on GitHub (K-819)", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const app = { id: "1", key: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
  const repos = [
    { repoId: "1001", name: "Owner/kept" },
    { repoId: "1002", name: "owner/deleted" },
  ];
  /** Answers the installations, their tokens, then each `GET /repositories/<id>` by a table. */
  const github = (installations: Array<object>, repo: (url: string, token: string) => Response | Error) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = String(url).slice("https://api.github.com".length);
      if (path === "/app/installations?per_page=100") return Response.json(installations);
      const token = path.startsWith("/app/installations/") && path.endsWith("/access_tokens");
      if (token) return Response.json({ token: `t${path.split("/")[3]}` });
      const answer = repo(path, new Headers(init?.headers).get("authorization") ?? "");
      if (answer instanceof Error) throw answer;
      return answer;
    });
  const all = { id: 6, account: { login: "owner" }, repository_selection: "all" };

  it("reads a 404 as gone only when an installation holds all repos of the owner", async () => {
    {
      using _fetch = github([all], (path) =>
        path === "/repositories/1001" ? Response.json({ id: 1001 }) : Response.json({}, { status: 404 }),
      );
      expect(await reposOnGitHub(app, repos, 40)).toEqual(
        new Map([
          ["1001", "exists"],
          ["1002", "gone"],
        ]),
      );
    }
    // With selected repos only, a 404 can mean that the repo is not selected.
    using _fetch = github([{ ...all, repository_selection: "selected" }], () =>
      Response.json({}, { status: 404 }),
    );
    expect((await reposOnGitHub(app, repos, 40)).get("1002")).toBe("unknown");
  });
  it("reads a stored id that is not a GitHub id as unknown and checks the rest", async () => {
    using _fetch = github([all], () => Response.json({}, { status: 404 }));
    const found = await reposOnGitHub(app, [{ repoId: "demo-1", name: "owner/odd" }, ...repos], 40);
    expect(found.get("demo-1")).toBe("unknown");
    expect(found.get("1002")).toBe("gone");
  });
  it("finds a repo that another installation still sees", async () => {
    const other = { id: 7, account: { login: "someone" }, repository_selection: "selected" };
    using _fetch = github([all, other], (_path, token) =>
      token === "Bearer t7" ? Response.json({ id: 1002 }) : Response.json({}, { status: 404 }),
    );
    expect((await reposOnGitHub(app, repos, 40)).get("1002")).toBe("exists");
  });
  it("never reads a failed check as gone", async () => {
    for (const failure of [
      () => Response.json({}, { status: 502 }),
      () => Response.json({}, { status: 403 }),
      () => new TypeError("fetch failed"),
    ]) {
      using _fetch = github([all], failure);
      expect((await reposOnGitHub(app, repos, 40)).get("1002")).toBe("unknown");
    }
    {
      using _fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
      expect((await reposOnGitHub(app, repos, 40)).size).toBe(0);
    }
    // An installation without a token cannot tell, so the other's 404 is not enough.
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = String(url).slice("https://api.github.com".length);
      if (path === "/app/installations?per_page=100") return Response.json([all, { ...all, id: 7 }]);
      if (path === "/app/installations/7/access_tokens") return Response.json({}, { status: 500 });
      if (path.endsWith("/access_tokens")) return Response.json({ token: "t" });
      return Response.json({}, { status: 404 });
    });
    expect((await reposOnGitHub(app, repos, 40)).get("1002")).toBe("unknown");
  });
  it("stops at its call budget and leaves the rest for the next check", async () => {
    using _fetch = github([all], () => Response.json({}, { status: 404 }));
    // The installation list and one token take 2 calls, so 3 calls reach one repo.
    expect([...(await reposOnGitHub(app, repos, 3)).keys()]).toEqual(["1001"]);
  });
});
