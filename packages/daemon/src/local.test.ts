import type { Request } from "@kitshn/local";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Caller, type LocalOptions, askLocal, listenLocal } from "./local.ts";

const platform = process.platform === "darwin" ? "darwin" : "linux";
const own = process.getuid!();

/** A daemon on a socket in a new temporary folder, never the path of a live daemon. */
function daemon(decide: LocalOptions["decide"]) {
  const path = join(mkdtempSync(join(tmpdir(), "kitshn-local-")), "kitshn", "kitshn.sock");
  const peers: Array<number | null> = [];
  const callers: Array<Caller> = [];
  const server = listenLocal(path, {
    platform,
    decide: (peer) => {
      peers.push(peer);
      return decide(peer);
    },
    handle: (request, caller) => {
      callers.push(caller);
      if (request.type !== "status") throw new Error(`no ${request.type} here`);
      return Promise.resolve({
        id: request.id,
        type: "status",
        status: { version: "dev", machineId: "m1", fingerprint: null, connection: "disconnected", tunnel: "stopped" },
      });
    },
    log: () => {},
  });
  return { path, peers, callers, [Symbol.dispose]: server.stop };
}

/** Sends raw lines, as a provider with a bug would, and collects the answer lines. */
function raw(path: string, text: string, answers: number): Promise<Array<unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    void Bun.connect({
      unix: path,
      socket: {
        open: (socket) => void socket.write(text),
        data(socket, chunk) {
          buffer += chunk.toString();
          const lines = buffer.split("\n").filter(Boolean);
          if (lines.length < answers) return;
          socket.end();
          resolve(lines.map((value) => JSON.parse(value) as unknown));
        },
        error: (_socket, error) => reject(error),
      },
    });
  });
}

const status: Request = { id: "1", type: "status" };

describe("local socket (K-701, K-702)", () => {
  it("reads the real peer user id of a client of the same user, and answers with the request id", async () => {
    using local = daemon(() => ({ accept: true }));
    expect(statSync(local.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(local.path, "..")).mode & 0o777).toBe(0o700);
    const outcome = await askLocal(local.path, status, 5000);
    expect(outcome).toMatchObject({ kind: "answer", answer: { id: "1", type: "status" } });
    expect(local.peers).toEqual([own]);
    expect(local.callers).toEqual([{ uid: own }]);
  });

  it("closes a refused connection before it reads a request", async () => {
    using local = daemon(() => ({ accept: false, reason: "test" }));
    await expect(askLocal(local.path, status, 5000)).rejects.toThrow("without an answer");
    expect(local.callers).toEqual([]);
  });

  it("answers a clear error for a bad line, with its id when it has one", async () => {
    using local = daemon(() => ({ accept: true }));
    const answers = await raw(local.path, 'not json\n{"id":"7","type":"nope"}\n{"id":"8","type":"rotate-key"}\n', 3);
    expect(answers).toEqual(
      expect.arrayContaining([
        { id: null, type: "error", error: "The line is not JSON." },
        expect.objectContaining({ id: "7", type: "error" }),
        { id: "8", type: "error", error: "Error: no rotate-key here" },
      ]),
    );
  });

  it("tells the client plainly that no daemon runs, and removes its socket on stop", async () => {
    const local = daemon(() => ({ accept: true }));
    local[Symbol.dispose]();
    expect(existsSync(local.path)).toBe(false);
    expect(await askLocal(local.path, status, 5000)).toEqual({ kind: "not-running" });
  });
});
