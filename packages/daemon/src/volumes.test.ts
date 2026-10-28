import { describe, expect, it } from "vitest";
import { idleVolumes, volumeRemoveRefusal } from "./volumes.ts";

describe("orphaned volumes (K-909)", () => {
  const list = [
    "app-a-1-prod_data\tapp-a-1-prod",
    "app-b-2-prod_db\tapp-b-2-prod",
    "other_data\tother",
    "loose\t",
  ].join("\n");
  const apps = ["app-a-1-prod", "app-b-2-prod"];

  it("reports the volumes of kitshn apps that run no container", () => {
    expect(idleVolumes(list, "app-b-2-prod\n\n", apps)).toEqual([
      { name: "app-a-1-prod_data", project: "app-a-1-prod" },
    ]);
  });

  it("deletes only an idle volume of the named kitshn app", () => {
    const idle = idleVolumes(list, "", apps);
    expect(volumeRemoveRefusal(idle, { project: "app-a-1-prod", volume: "app-a-1-prod_data" })).toBeNull();
    expect(volumeRemoveRefusal(idle, { project: "app-b-2-prod", volume: "app-a-1-prod_data" })).toMatch(
      /keeps it/,
    );
    expect(volumeRemoveRefusal(idle, { project: "other", volume: "other_data" })).toMatch(/keeps it/);
    expect(
      volumeRemoveRefusal(idleVolumes(list, "app-a-1-prod", apps), {
        project: "app-a-1-prod",
        volume: "app-a-1-prod_data",
      }),
    ).toMatch(/keeps it/);
  });
});
