// The daemon binary starts here. K-629: the update gate of `kitshn run` runs before any other module of the daemon
// loads, so a release that crashes while it loads or starts still rolls back. Keep this file and its imports small.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { restartSoon } from "./restart.ts";
import { pathsFor } from "./service.ts";
import { exitText, readMarker, runGate, writeMarker } from "./update.ts";

declare const KITSHN_VERSION: string;
const VERSION = typeof KITSHN_VERSION === "string" ? KITSHN_VERSION : "dev";
const log = (text: string) => console.log(`${new Date().toISOString()} ${text}`);
/** K-622: the daemon log on Windows keeps at most this much, and one older file. */
const LOG_BYTES = 1024 * 1024;

/**
 * K-622: the task runs the daemon in `conhost --headless`, where its output goes nowhere. So on Windows the daemon
 * also writes it to `daemon.log` in its data folder. On every system, each exit logs its code and its reason, and a
 * crash of a new daemon notes the reason in `update.json`, so its rollback names it (K-629).
 */
function exitLog(os: "linux" | "darwin" | "win32", data: string) {
  const file = os === "win32" ? join(data, "daemon.log") : null;
  const append = (text: string) => {
    if (!file) return;
    try {
      mkdirSync(data, { recursive: true });
      if (existsSync(file) && statSync(file).size > LOG_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, `${text}\n`);
    } catch {
      // A log that cannot be written never stops the daemon.
    }
  };
  let lastError = "";
  for (const level of ["log", "warn", "error"] as const) {
    const write = console[level].bind(console);
    console[level] = (...args: Array<unknown>) => {
      write(...args);
      const text = format(...args);
      if (level === "error") lastError = text;
      append(text);
    };
  }
  let crash: string | null = null;
  const crashed = (error: unknown) => {
    crash = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.exit(1);
  };
  process.on("uncaughtException", crashed);
  process.on("unhandledRejection", crashed);
  process.on("exit", (code) => {
    const reason = crash ?? (code === 0 ? "" : lastError);
    append(
      `${new Date().toISOString()} kitshn ${VERSION} exits with code ${code}${reason ? `: ${reason}` : ""}`,
    );
    if (code === 0) return;
    const marker = readMarker(data, log);
    if (marker?.state !== "pending" || marker.to !== VERSION) return;
    try {
      writeMarker(data, { ...marker, lastExit: exitText(code, reason) });
    } catch {
      // The gate then rolls back without the reason.
    }
  });
}

/** Returns false when the previous daemon comes back, so this start ends here. */
async function updateGate(os: "linux" | "darwin" | "win32", data: string): Promise<boolean> {
  const outcome = await runGate(
    {
      read: () => readMarker(data, log),
      write: (marker) => writeMarker(data, marker),
      exists: existsSync,
      rename: renameSync,
    },
    { binary: process.execPath, version: VERSION, windows: os === "win32", now: Date.now(), log },
  );
  if (outcome === "start") return true;
  restartSoon(os, log);
  return false;
}

async function start() {
  const os = platform();
  // main.ts refuses another system with its own message.
  if (process.argv[2] !== "run" || (os !== "linux" && os !== "darwin" && os !== "win32")) return true;
  const data = pathsFor(os, process.env).data;
  exitLog(os, data);
  log(`kitshn ${VERSION} starts (${process.execPath})`);
  return updateGate(os, data);
}

if (await start()) await import("./main.ts");
