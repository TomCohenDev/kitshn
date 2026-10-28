import { describe, expect, it } from "vitest";

/** The tick3d standard: no browser tooltips or native pickers; controls.tsx owns the styled inputs. */
const sources = import.meta.glob<string>("./*.tsx", { query: "?raw", import: "default", eager: true });
const files = Object.entries(sources).map(([path, text]) => ({ name: path.slice(2), text }));

describe("no native browser UI in the map", () => {
  it("has no title tooltip", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((file) => file.text.includes("title=")).map((file) => file.name)).toEqual([]);
  });

  it("has no native select, date or colour picker, and choice inputs only in controls.tsx", () => {
    const native = ["<select", 'type="date"', 'type="color"', 'type="checkbox"', 'type="radio"'];
    const found = files.flatMap((file) =>
      native
        .filter((tag) => file.text.includes(tag))
        .filter((tag) => !(file.name === "controls.tsx" && tag.startsWith("type=")))
        .map((tag) => `${file.name}: ${tag}`),
    );
    expect(found).toEqual([]);
  });
});
