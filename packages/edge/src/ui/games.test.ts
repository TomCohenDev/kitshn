import { describe, expect, it } from "vitest";
import type { ServerReport } from "../core/sites.ts";
import { gamePorts } from "./Games.tsx";

describe("the ports of the Game step (K-534, K-2001)", () => {
  const servers: ReadonlyArray<ServerReport> = [
    { port: 8080, process: "node", status: 200, title: "Grafana" },
    { port: 2222, process: "sshd", status: null, title: null },
    // The game itself may listen already: it answers no HTTP.
    { port: 25565, process: "java", status: null, title: null },
  ];
  const check = (ports: string) => gamePorts({ ports, name: "mc", hours: 12, srv: "" }, servers);

  it("takes game ports, also one where the game listens already", () => {
    expect(check("25565, 19132/UDP")).toEqual({
      ports: [
        { port: 25565, proto: "tcp" },
        { port: 19132, proto: "udp" },
      ],
    });
  });

  it.each([
    ["41641/udp", "Tailscale"],
    ["3773", "T3 Code"],
    ["80", "1024 to 65535"],
    ["8080", '"Grafana", which is no game'],
    ["2222", "sshd, which is no game"],
    ["25565/sctp", "like 25565/tcp"],
    ["25565, 25565", "each port once"],
  ])("refuses %s with a reason that names %s", (ports, reason) => {
    expect(check(ports)).toEqual({ problem: expect.stringContaining(reason) });
  });
});
