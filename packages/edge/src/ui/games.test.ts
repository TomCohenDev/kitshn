import { describe, expect, it } from "vitest";
import { parsePorts } from "./Games.tsx";

describe("game ports (K-534)", () => {
  it("reads 1 to 4 ports, TCP unless /udp, and names a bad one", () => {
    expect(parsePorts("25565, 19132/UDP")).toEqual(["25565/tcp", "19132/udp"]);
    expect(parsePorts("")).toMatch(/1 to 4/);
    expect(parsePorts("1,2,3,4,5")).toMatch(/1 to 4/);
    expect(parsePorts("70000")).toMatch(/70000 is no port/);
    expect(parsePorts("25565/sctp")).toMatch(/tcp or udp/);
  });
});
