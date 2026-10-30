// K-601: a restart of the daemon by its service manager.
import { spawn } from "node:child_process";
import { type Platform, WINDOWS_TASKS } from "./service.ts";

/**
 * K-601: exits so that the service manager starts the daemon again. K-622: Task Scheduler does not start an action
 * that ended, so on Windows a hidden PowerShell runs the task again once this daemon is gone.
 */
export function restartSoon(platform: Platform) {
  if (platform === "win32")
    spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Sleep 3; schtasks /Run /TN '${WINDOWS_TASKS.daemon}'`,
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    ).unref();
  setTimeout(() => process.exit(0), 500);
}
