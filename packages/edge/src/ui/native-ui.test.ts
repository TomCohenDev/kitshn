import { describe, expect, it } from "vitest";

/** The tick3d standard (K-517): no browser tooltips or native pickers. controls.tsx owns the styled inputs. */
const sources = import.meta.glob<string>(["./**/*.{ts,tsx}", "!./**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});
const files = Object.entries(sources).map(([path, text]) => ({ name: path.slice(2), text }));

const NATIVE_TYPES = [
  "date",
  "datetime-local",
  "time",
  "month",
  "week",
  "range",
  "color",
  "checkbox",
  "radio",
];
/** Every way JSX can write a type attribute. */
const typeAttributes = (type: string) => [
  `type="${type}"`,
  `type='${type}'`,
  `type={"${type}"}`,
  `type={'${type}'}`,
];
const FORBIDDEN = ["title=", "<select", "<datalist", ...NATIVE_TYPES.flatMap(typeAttributes)];

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("no native browser UI in the map", () => {
  it("reads the UI sources", () => {
    expect(files.map((file) => file.name)).toContain("controls.tsx");
    expect(files.length).toBeGreaterThan(10);
  });

  it("has native checkbox and radio inputs only inside Check, Switch and Radio", () => {
    const found = files.flatMap((file) =>
      FORBIDDEN.flatMap((needle) =>
        Array<string>(occurrences(file.text, needle)).fill(`${file.name}: ${needle}`),
      ),
    );
    expect(found.sort()).toEqual([
      'controls.tsx: type="checkbox"',
      'controls.tsx: type="checkbox"',
      'controls.tsx: type="radio"',
    ]);
  });
});
