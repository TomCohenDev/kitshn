import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReachedCard } from "@kitshn/local";
import { describe, expect, it } from "vitest";
import { linkTarget, serveLinks } from "./link.ts";

const card = (address: string | null): ReachedCard => ({
  machineId: "b",
  machineName: "B",
  kind: "t3.app",
  id: "app",
  address,
  level: "standard",
});

describe("the link proxy (K-1609)", () => {
  it("reaches only the address of a machine in reach, and a path never changes the host", () => {
    const reach = [card("t3-b.example.com")];
    expect(linkTarget(reach, new URL("http://link/b/api/x?y=1"))).toEqual({
      target: new URL("https://t3-b.example.com/api/x?y=1"),
    });
    expect(linkTarget(reach, new URL("http://link/c/api"))).toMatchObject({ status: 403 });
    expect(linkTarget([card(null)], new URL("http://link/b/api"))).toMatchObject({ status: 403 });
    expect(linkTarget(reach, new URL("http://link/b//evil.example.com/x"))).toMatchObject({
      target: { host: "t3-b.example.com" },
    });
  });

  it("adds the machine token, drops the caller's Access headers, and streams HTTP and WebSocket both ways", async () => {
    const seen: Array<Headers> = [];
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, server) {
        seen.push(request.headers);
        if (server.upgrade(request)) return undefined;
        return new Response(`${request.method} ${new URL(request.url).pathname}`);
      },
      websocket: {
        message: (socket, message) => {
          socket.send(`echo ${String(message)}`);
        },
      },
    });
    const folder = mkdtempSync(join(tmpdir(), "kitshn-link-"));
    const path = join(folder, "link.sock");
    const links = serveLinks(path, {
      reach: () => [card(`127.0.0.1:${upstream.port}`)],
      token: () => ({ clientId: "a.access", clientSecret: "secret" }),
      log: () => {},
      scheme: "http",
    });
    try {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const answer = await fetch("http://link/b/api/thing", {
        unix: path,
        method: "POST",
        headers: { "CF-Access-Client-Id": "forged", "x-keep": "1" },
        body: "x".repeat(200_000),
      } as RequestInit);
      expect(await answer.text()).toBe("POST /api/thing");
      expect(seen[0]?.get("cf-access-client-id")).toBe("a.access");
      expect(seen[0]?.get("cf-access-client-secret")).toBe("secret");
      expect(seen[0]?.get("x-keep")).toBe("1");
      const refused = await fetch("http://link/other/api", { unix: path } as RequestInit);
      expect(refused.status).toBe(403);

      expect(await webSocketEcho(path, "/b/ws", "hi")).toBe("echo hi");
    } finally {
      links.stop();
      void upstream.stop(true);
    }
  });
});

/**
 * One text message through a WebSocket on a Unix socket, with the handshake by hand: Bun's WebSocket client has no
 * Unix socket option. A client frame is masked; the server's answer frame is not.
 */
function webSocketEcho(path: string, target: string, text: string): Promise<string> {
  const answer = Promise.withResolvers<string>();
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  void Bun.connect({
    unix: path,
    socket: {
      open(socket) {
        socket.write(
          [
            `GET ${target} HTTP/1.1`,
            "Host: link",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      },
      data(socket, chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          if (!buffer.subarray(0, end).toString().startsWith("HTTP/1.1 101")) {
            answer.reject(new Error(buffer.subarray(0, end).toString()));
            socket.end();
            return;
          }
          upgraded = true;
          buffer = buffer.subarray(end + 4);
          const payload = Buffer.from(text);
          const mask = Buffer.from([1, 2, 3, 4]);
          const masked = payload.map((byte, index) => byte ^ mask[index % 4]!);
          socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
        }
        if (buffer.length >= 2 && buffer.length >= 2 + (buffer[1]! & 0x7f)) {
          answer.resolve(buffer.subarray(2, 2 + (buffer[1]! & 0x7f)).toString());
          socket.end();
        }
      },
    },
  });
  return answer.promise;
}
