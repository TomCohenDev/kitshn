// K-701: the user id of the process at the other end of a local socket connection.
import { FFIType, dlopen, ptr } from "bun:ffi";
import { Schema } from "effect";
import type { Request } from "@kitshn/local";
import type { Platform } from "./service.ts";

/** Linux `<sys/socket.h>` on x86-64 and arm64. */
const SOL_SOCKET = 1;
const SO_PEERCRED = 17;

const linux = () =>
  dlopen("libc.so.6", {
    getsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  }).symbols;
const darwin = () =>
  dlopen("/usr/lib/libSystem.B.dylib", {
    getpeereid: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;

type Calls = { linux: ReturnType<typeof linux> } | { darwin: ReturnType<typeof darwin> };
let calls: Calls | null = null;

/**
 * The peer user id of a connected Unix socket, or null when the kernel does not give it. Bun has no call for
 * this, so it goes through `bun:ffi`: `SO_PEERCRED` on Linux, `getpeereid` on macOS.
 */
export function peerUid(platform: Platform, fd: unknown): number | null {
  if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0) return null;
  // A library that does not load refuses the peer instead of ending the daemon (K-006).
  try {
    calls ??= platform === "linux" ? { linux: linux() } : { darwin: darwin() };
    return readPeer(calls, fd);
  } catch (error) {
    console.error(`kitshn: the peer user id cannot be read: ${String(error)}`);
    return null;
  }
}

function readPeer(calls: Calls, fd: number): number | null {
  if ("linux" in calls) {
    // struct ucred { pid_t pid; uid_t uid; gid_t gid; }
    const credentials = new Uint32Array(3);
    const size = new Uint32Array([credentials.byteLength]);
    const result = calls.linux.getsockopt(fd, SOL_SOCKET, SO_PEERCRED, ptr(credentials), ptr(size));
    return result === 0 && size[0] === credentials.byteLength ? (credentials[1] ?? null) : null;
  }
  const ids = new Uint32Array(2);
  const result = calls.darwin.getpeereid(fd, ptr(ids, 0), ptr(ids, 4));
  return result === 0 ? (ids[0] ?? null) : null;
}

/**
 * K-701: who may send each request. A user in `localUsers` reads the status and asks kitshn (K-1710); the
 * machine-admin requests stay with the daemon user and root. A new request kind must take a side here.
 */
const REQUEST_SENDERS: Record<Request["type"], "local-users" | "daemon-user-or-root"> = {
  status: "local-users",
  "rotate-key": "daemon-user-or-root",
  reconnect: "daemon-user-or-root",
  ask: "local-users",
  "forget-token": "local-users",
  forward: "local-users",
  // K-1751: an attester vouches for threads, so only the daemon user and root register one.
  "attester-set": "daemon-user-or-root",
  // K-704: a provider adds cards that circles share and enforces their grants, so it acts for the machine.
  register: "daemon-user-or-root",
  upsert: "daemon-user-or-root",
  remove: "daemon-user-or-root",
  "command-result": "daemon-user-or-root",
  "provider-forget": "daemon-user-or-root",
};

export const requestAllowed = (type: Request["type"], uid: number, own: number) =>
  REQUEST_SENDERS[type] === "local-users" || uid === own || uid === 0;

export type PeerDecision = { readonly accept: true } | { readonly accept: false; readonly reason: string };

/**
 * K-701: the daemon user always passes, and each user id in `localUsers` of `machine.json`. With a `machine.json`
 * that it cannot read, no peer passes (K-006).
 */
export function peerDecision(
  peer: number,
  own: number,
  localUsers: ReadonlyArray<number> | null,
): PeerDecision {
  if (localUsers === null) return { accept: false, reason: "localUsers in machine.json cannot be read" };
  if (peer === own || localUsers.includes(peer)) return { accept: true };
  return { accept: false, reason: `the user id ${peer} is not a local user of kitshn` };
}

const LocalUsers = Schema.Struct({
  localUsers: Schema.optionalKey(Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))),
});
const decodeLocalUsers = Schema.decodeUnknownSync(LocalUsers);

/** K-701: `localUsers` of `machine.json`; none when it is missing, null when it is not a list of user ids. */
export function localUsersOf(machine: unknown): ReadonlyArray<number> | null {
  try {
    return decodeLocalUsers(machine).localUsers ?? [];
  } catch {
    return null;
  }
}
