// K-601: a restart of the daemon by its service manager.
import { spawn, spawnSync } from "node:child_process";
import { type Platform, WINDOWS_TASKS } from "./service.ts";

/**
 * K-622: the PowerShell that starts the daemon task again. A process that the daemon spawns belongs to the run of the
 * task, and the task ignores a start while that run lasts (`IgnoreNew`). So the waiter runs outside it: WMI creates it
 * as a child of its own service. It waits until the task no longer runs, at most 2 minutes, then starts it.
 * `Get-ScheduledTask` names the state in English on every Windows language, unlike `schtasks /Query`.
 */
export function windowsRestartArgs(task: string = WINDOWS_TASKS.daemon): Array<string> {
  const cut = task.lastIndexOf("\\") + 1;
  const path = task.slice(0, cut).replaceAll("'", "''");
  const name = task.slice(cut).replaceAll("'", "''");
  const waiter = [
    "$end = (Get-Date).AddSeconds(120)",
    `do { Start-Sleep 2; $state = (Get-ScheduledTask -TaskPath '${path}' -TaskName '${name}').State } while ($state -eq 'Running' -and (Get-Date) -lt $end)`,
    `Start-ScheduledTask -TaskPath '${path}' -TaskName '${name}'`,
  ].join("; ");
  const encoded = Buffer.from(waiter, "utf16le").toString("base64");
  const launcher = [
    "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
    `$made = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}'; ProcessStartupInformation = $startup }`,
    "exit $made.ReturnValue",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", launcher];
}

/**
 * K-601: exits so that the service manager starts the daemon again. K-622: Task Scheduler does not start an action
 * that ended, so on Windows a waiter outside the task starts it again once this run is over.
 */
export function restartSoon(platform: Platform, log: (text: string) => void) {
  if (platform === "win32") {
    const made = spawnSync("powershell.exe", windowsRestartArgs(), {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    if (made.status !== 0) {
      // The time trigger of the task still starts the daemon within 5 minutes.
      log(
        `the task restart through WMI failed (${made.error ? String(made.error) : `exit ${made.status}, ${(made.stdout + made.stderr).trim().slice(-300)}`}); trying schtasks directly`,
      );
      spawn("schtasks", ["/Run", "/TN", WINDOWS_TASKS.daemon], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else log("the daemon task starts again once this run is over");
  }
  setTimeout(() => process.exit(0), 500);
}
