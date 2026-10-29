// K-621: who serves a named pipe, and who this process is, as Windows account SIDs. Node has no call for either, so
// they go through `bun:ffi` to kernel32 and advapi32. Windows only; nothing loads the DLLs on another platform.
import { FFIType, dlopen, ptr, read } from "bun:ffi";

const GENERIC_READ = 0x80000000;
const OPEN_EXISTING = 3;
const ERROR_FILE_NOT_FOUND = 2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x0008;
const TOKEN_USER = 1;
const INVALID_HANDLE = -1n;

type Calls = ReturnType<typeof load>;
let calls: Calls | null = null;

function load() {
  const kernel = dlopen("kernel32.dll", {
    CreateFileW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.i64,
    },
    GetLastError: { args: [], returns: FFIType.u32 },
    GetNamedPipeServerProcessId: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.i64 },
    GetCurrentProcess: { args: [], returns: FFIType.i64 },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
    LocalFree: { args: [FFIType.i64], returns: FFIType.i64 },
  }).symbols;
  const advapi = dlopen("advapi32.dll", {
    OpenProcessToken: { args: [FFIType.i64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    GetTokenInformation: {
      args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
    ConvertSidToStringSidW: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  return { ...kernel, ...advapi };
}

const windows = () => (calls ??= load());

/** A UTF-16 string that Windows allocated, up to its terminating zero. */
function readWide(address: bigint): string {
  const base = Number(address);
  let text = "";
  for (let offset = 0; offset < 2048; offset += 2) {
    const unit = read.u16(base as never, offset);
    if (unit === 0) break;
    text += String.fromCharCode(unit);
  }
  return text;
}

/** The account SID of a process handle, such as `S-1-5-21-…-1000`, or null when Windows does not give it. */
function sidOf(process: bigint): string | null {
  const w = windows();
  const token = new BigInt64Array(1);
  if (!w.OpenProcessToken(process, TOKEN_QUERY, ptr(token))) return null;
  try {
    const buffer = new Uint8Array(512);
    const size = new Uint32Array(1);
    if (!w.GetTokenInformation(token[0]!, TOKEN_USER, ptr(buffer), buffer.length, ptr(size))) return null;
    // TOKEN_USER starts with the pointer to the SID, inside the same buffer.
    const sid = new DataView(buffer.buffer).getBigInt64(0, true);
    const text = new BigInt64Array(1);
    if (!w.ConvertSidToStringSidW(sid, ptr(text))) return null;
    try {
      return readWide(text[0]!);
    } finally {
      w.LocalFree(text[0]!);
    }
  } finally {
    w.CloseHandle(token[0]!);
  }
}

/** K-623: the account SID of this process. */
export const ownSid = (): string | null => sidOf(windows().GetCurrentProcess());

/**
 * K-621: the account SID of the process that serves `path`: `missing` when no pipe has that name, or an error when
 * Windows does not say who serves it. A client sends nothing in either case, so a busy or odd pipe never skips the
 * check.
 */
export function pipeServer(
  path: string,
): { readonly sid: string } | { readonly missing: true } | { readonly error: string } {
  const w = windows();
  const name = Buffer.from(`${path}\0`, "utf16le");
  const handle = w.CreateFileW(ptr(name), GENERIC_READ, 0, null, OPEN_EXISTING, 0, null);
  if (handle === INVALID_HANDLE) {
    const code = w.GetLastError();
    return code === ERROR_FILE_NOT_FOUND ? { missing: true } : { error: `Windows error ${code} on ${path}` };
  }
  try {
    const pid = new Uint32Array(1);
    if (!w.GetNamedPipeServerProcessId(handle, ptr(pid)))
      return { error: "Windows does not name the pipe's server" };
    const process = w.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid[0]!);
    if (process === 0n) return { error: `kitshn cannot read the process ${pid[0]} that serves the pipe` };
    try {
      const sid = sidOf(process);
      return sid === null ? { error: `kitshn cannot read the account of the process ${pid[0]}` } : { sid };
    } finally {
      w.CloseHandle(process);
    }
  } finally {
    w.CloseHandle(handle);
  }
}

/** K-621: why a client must not use `path`, or null when its server runs as this account, or `missing`. */
export function pipeServerProblem(path: string): string | "missing" | null {
  const server = pipeServer(path);
  if ("missing" in server) return "missing";
  if ("error" in server) return `${server.error}; kitshn sent nothing (K-621).`;
  const own = ownSid();
  if (own === null) return "kitshn cannot read its own account; it sent nothing (K-621).";
  return server.sid === own
    ? null
    : `${path} is served by the account ${server.sid}, not by yours (${own}); kitshn sent nothing (K-621).`;
}
