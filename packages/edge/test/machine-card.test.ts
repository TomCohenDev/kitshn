import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { accessToken, send, stubAccessCerts } from "./access.ts";

afterEach(() => vi.restoreAllMocks());

it("counts the queued jobs of each machine from the job table, not from the newest jobs (K-515)", async () => {
  stubAccessCerts();
  await runInDurableObject(env.KITSHN.getByName("kitshn"), (_, state) => {
    const job = (machineId: string, jobState: string, at: number) =>
      state.storage.sql.exec(
        `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, output)
         VALUES (?, '[]', '{"kind":"diagnostics"}', ?, ?, ?, 'owner@example.com', '{}', '')`,
        machineId,
        jobState,
        at,
        at + 3_600_000,
      );
    // One job waits for vps, and ten newer jobs of another machine push it out of the newest jobs.
    job("vps", "queued", 1);
    for (let index = 0; index < 10; index++) job("mac", "done", 100 + index);
  });
  const answer = await send("/api/state", {
    headers: { "cf-access-jwt-assertion": await accessToken("admin-aud", { email: "owner@example.com" }) },
  });
  const snapshot = (await answer.json()) as {
    jobs: Array<{ machineId: string }>;
    queuedJobs: Record<string, number>;
  };
  expect(snapshot.jobs.some((job) => job.machineId === "vps")).toBe(false);
  expect(snapshot.queuedJobs).toEqual({ vps: 1 });
});
