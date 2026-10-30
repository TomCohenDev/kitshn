// The daemon binary starts here. K-629: the update gate of `kitshn run` runs before any other module of the daemon
// loads, so a release that crashes while it loads or starts still rolls back. Keep this file and its imports small.
import { existsSync, renameSync } from "node:fs";
import { platform } from "node:os";
import { restartSoon } from "./restart.ts";
import { pathsFor } from "./service.ts";
import { readMarker, runGate, writeMarker } from "./update.ts";

declare const KITSHN_VERSION: string;
const VERSION = typeof KITSHN_VERSION === "string" ? KITSHN_VERSION : "dev";
const log = (text: string) => console.log(`${new Date().toISOString()} ${text}`);

/** Returns false when the previous daemon comes back, so this start ends here. */
async function updateGate(): Promise<boolean> {
  const os = platform();
  // main.ts refuses another system with its own message.
  if (os !== "linux" && os !== "darwin" && os !== "win32") return true;
  const data = pathsFor(os, process.env).data;
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
  restartSoon(os);
  return false;
}

if (process.argv[2] !== "run" || (await updateGate())) await import("./main.ts");
