import { describe, expect, it } from "vitest";
import { windowsRestartArgs } from "./restart.ts";

describe("the restart of the Windows task (K-622)", () => {
  it("starts the task from a waiter outside the task's run, after that run is over", () => {
    const [, , , launcher = ""] = windowsRestartArgs("\\kitshn\\daemon");
    // WMI makes the waiter, so it does not belong to the run that `IgnoreNew` would keep.
    expect(launcher).toContain("Invoke-CimMethod -ClassName Win32_Process -MethodName Create");
    const encoded = /-EncodedCommand (\S+)'/.exec(launcher)?.[1] ?? "";
    const waiter = Buffer.from(encoded, "base64").toString("utf16le");
    expect(waiter).toContain("while ($state -eq 'Running'");
    expect(waiter).toContain("Start-ScheduledTask -TaskPath '\\kitshn\\' -TaskName 'daemon'");
  });
});
