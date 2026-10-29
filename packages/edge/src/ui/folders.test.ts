import { describe, expect, it } from "vitest";
import { droppedFolder, pickedFolder } from "./folders.ts";

/** A folder entry of a drop, as the browser gives it, from a map of paths to texts. */
function entry(
  name: string,
  tree: Record<string, string | Record<string, unknown>>,
): FileSystemDirectoryEntry {
  const children = Object.entries(tree).map(([child, value]): FileSystemEntry =>
    typeof value === "string"
      ? ({
          name: child,
          isDirectory: false,
          file: (done: (file: File) => void) => done(new File([value], child)),
        } as unknown as FileSystemEntry)
      : entry(child, value as Record<string, string>),
  );
  return {
    name,
    isDirectory: true,
    createReader: () => {
      let read = false;
      return {
        readEntries: (done: (entries: Array<FileSystemEntry>) => void) =>
          done(read ? [] : ((read = true), children)),
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

describe("folder files (K-805, K-1129)", () => {
  it("leaves out every hidden file and folder of a dropped folder, as the CLI does", async () => {
    const folder = await droppedFolder(
      entry("site", {
        ".git": { config: "token" },
        ".env": "SECRET=1",
        "index.html": "<h1>",
        css: { ".hidden": "x", "a.css": "" },
      }),
    );
    expect(folder.files.map((file) => file.path).sort()).toEqual(["/css/a.css", "/index.html"]);
    expect(folder.skipped).toBe(3);
  });

  it("leaves out the hidden paths of a picked folder", () => {
    const file = (path: string) => {
      const item = new File(["x"], path.split("/").at(-1) ?? path);
      Object.defineProperty(item, "webkitRelativePath", { value: path });
      return item;
    };
    const picked = pickedFolder([file("site/index.html"), file("site/.git/config"), file("site/.env")]);
    expect(picked).toMatchObject({ folder: "site", skipped: 2 });
    expect(picked.files.map((item) => item.path)).toEqual(["/index.html"]);
  });
});
