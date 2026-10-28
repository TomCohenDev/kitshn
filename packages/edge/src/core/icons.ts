import type { Resource } from "./model.ts";

/** K-524: the systems that a machine card shows an icon for. */
export const MACHINE_OS = ["macos", "linux", "windows"] as const;
export type MachineOs = (typeof MACHINE_OS)[number];

/**
 * K-524: the system of a daemon status `os` ("darwin 25.6.0", from Node `os.platform()` and `os.release()`), or
 * null for a system that has no icon.
 */
export function machineOs(os: string): MachineOs | null {
  const platform = os.trim().split(" ")[0]?.toLowerCase();
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return null;
}

/** K-524: the GitHub owner of a repo name `owner/name`, or null when the name has another form. */
export function repoOwner(name: string): string | null {
  const parts = name.split("/");
  if (parts.length !== 2) return null;
  const [owner = "", repo = ""] = parts;
  // GitHub logins: 1 to 39 letters, digits and single inner hyphens.
  const login =
    owner.length >= 1 &&
    owner.length <= 39 &&
    !owner.startsWith("-") &&
    !owner.endsWith("-") &&
    !owner.includes("--") &&
    [...owner].every(
      (char) =>
        char === "-" ||
        (char >= "a" && char <= "z") ||
        (char >= "A" && char <= "Z") ||
        (char >= "0" && char <= "9"),
    );
  return login && repo.length > 0 ? owner : null;
}

/** K-524: the avatar of a GitHub owner. GitHub serves it to anyone, so no App is needed. */
export const avatarUrl = (owner: string) => `https://github.com/${encodeURIComponent(owner)}.png?size=64`;

/** K-524: what the icon tile of a card shows. `kind` is the icon of its kind, the fallback of every card. */
export type CardIcon =
  | { readonly _tag: "site"; readonly src: string }
  | { readonly _tag: "avatar"; readonly owner: string; readonly src: string }
  | { readonly _tag: "os"; readonly os: MachineOs }
  | { readonly _tag: "kind" };

/** K-1113, K-1114, K-1115: the kinds whose card shows a stored icon. */
const STORED_ICON_KINDS: ReadonlySet<Resource["kind"]> = new Set([
  "site.static",
  "site.compose",
  "site.live",
  "page",
  "file",
]);

/**
 * K-524: the own icon of a card, or its kind icon. `icons` are the stored icon hashes of the snapshot (K-1113),
 * and `os` is the system of the machine with the card's id.
 */
export function cardIcon(
  resource: Resource,
  icons: Readonly<Record<string, string>>,
  os: MachineOs | null,
): CardIcon {
  const hash = icons[resource.id];
  if (STORED_ICON_KINDS.has(resource.kind) && hash !== undefined)
    return { _tag: "site", src: `/api/icons/${encodeURIComponent(resource.id)}?v=${hash}` };
  if (resource.kind === "repo") {
    const owner = repoOwner(resource.name);
    if (owner !== null) return { _tag: "avatar", owner, src: avatarUrl(owner) };
  }
  if (resource.kind === "machine" && os !== null) return { _tag: "os", os };
  return { _tag: "kind" };
}
