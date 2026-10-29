import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type { Machine } from "../src/core/machine.ts";
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

it("sends the maps the queued count after a reconnect hands the jobs to the machine (K-515)", async () => {
  const queuedAtUpdates = await runInDurableObject(
    env.KITSHN.getByName("machine-reconnect"),
    (instance, state) => {
      const kitshn = instance as unknown as {
        load(): void;
        broadcast(): void;
        acceptMachine(socket: WebSocket, attachment: object): void;
      };
      const machine: Machine = {
        id: "vps",
        name: "vps",
        labels: [],
        order: 0,
        serviceTokenId: "token-vps",
        clientId: "vps.access",
        tunnelId: "tunnel-vps",
        key: { kind: "public", publicKey: "key", fingerprint: "print", since: 0 },
      };
      state.storage.sql.exec("INSERT INTO machines (id, body) VALUES (?, ?)", "vps", JSON.stringify(machine));
      // A job that kitshn made itself goes to any connected machine (K-614).
      state.storage.sql.exec(
        `INSERT INTO jobs (machine_id, labels, command, state, created_at, expires_at, actor, visitor, output)
       VALUES ('vps', '[]', '{"kind":"diagnostics"}', 'queued', ?, ?, 'owner@example.com', '{"kitshn":true,"clientId":null}', '')`,
        Date.now(),
        Date.now() + 3_600_000,
      );
      kitshn.load();
      const queued: Array<number> = [];
      const broadcast = kitshn.broadcast.bind(kitshn);
      kitshn.broadcast = () => {
        queued.push(
          state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE state = 'queued'").one()
            .n,
        );
        broadcast();
      };
      const [, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      state.acceptWebSocket(server, ["vps"]);
      kitshn.acceptMachine(server, {
        kind: "machine",
        machineId: "vps",
        since: Date.now(),
        challenge: "c",
        check: "signed",
        answered: true,
        rotateBy: null,
        status: null,
        sample: null,
      });
      const sent = state.storage.sql.exec<{ state: string }>("SELECT state FROM jobs").one().state;
      return { queued, sent };
    },
  );
  expect(queuedAtUpdates.sent).toBe("sent");
  // The machine took its job, so the last map update counts none.
  expect(queuedAtUpdates.queued.at(-1)).toBe(0);
});
