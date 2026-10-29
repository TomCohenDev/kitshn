import { describe, expect, it } from "vitest";
import { lsofListenerUid, portOf, procListenerUid } from "./listener.ts";

describe("the user on an attester port (K-1751)", () => {
  it("reads the listener's uid from /proc/net/tcp and from lsof", () => {
    const table = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0EBD 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0
   1: 0100007F:0EBE 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1001        0 2 1 0`;
    expect(procListenerUid(table, 3773)).toBe(0);
    // A connection on a port is no listener.
    expect(procListenerUid(table, 3774)).toBeNull();
    expect(lsofListenerUid("p123\nu501\n")).toBe(501);
    expect(lsofListenerUid("p1\nu501\np2\nu502\n")).toBeNull();
    expect(lsofListenerUid("")).toBeNull();
    expect(portOf("http://127.0.0.1:3773/api/thread-identity")).toBe(3773);
    expect(portOf("https://localhost/x")).toBe(443);
  });
});
