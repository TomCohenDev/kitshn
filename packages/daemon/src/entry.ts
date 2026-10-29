// The daemon binary starts here. K-629: the update gate of `kitshn run` runs before any other module of the daemon
// loads, so a release that crashes while it loads or starts still rolls back. Keep this file and its imports small.
import { renameSync } from "node:fs";
import { platform } from "node:os";
import { restartSoon } from "./restart.ts";
import { pathsFor } from "./service.ts";
import { gateStep, readMarker, restorePrevious, writeMarker } from "./update.ts";

declare const KITSHN_VERSION: string;
const VERSION = typeof KITSHN_VERSION === "string" ? KITSHN_VERSION : "dev";
const log = (text: string) => console.log(`${new Date().toISOString()} ${text}`);

/** Returns false when the previous daemon comes back, so this start ends here. */
async function updateGate(): Promise<boolean> {
  const os = platform();
  // main.ts refuses another system with its own message.
  if (os !== "linux" && os !== "darwin" && os !== "win32") return true;
  const data = pathsFor(os, process.env).data;
  const marker = readMarker(data, log);
  const step = gateStep(marker, VERSION, Date.now());
  if (step.kind === "none" || marker === null) return true;
  if (step.kind === "count") {
    writeMarker(data, step.marker);
    return true;
  }
  log(`the update to edge-${marker.to} failed: ${step.reason} edge-${marker.from} comes back.`);
  writeMarker(data, { ...marker, state: "rolled-back", reason: step.reason });
  try {
    await restorePrevious(
      { rename: renameSync },
      process.execPath,
      marker.previous,
      os === "win32",
      Date.now(),
    );
  } catch (error) {
    // This daemon keeps running and reports the failure itself (main.ts reads the marker).
    log(`the previous daemon could not come back: ${String(error)}`);
    writeMarker(data, {
      ...marker,
      state: "rolled-back",
      reason: `${step.reason} The previous daemon could not come back: ${String(error)}`,
    });
    return true;
  }
  restartSoon(os);
  return false;
}

if (process.argv[2] !== "run" || (await updateGate())) await import("./main.ts");
