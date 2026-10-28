import { useState } from "preact/hooks";
import { type MachineOs, avatarUrl, cardIcon, repoOwner } from "../core/icons.ts";
import type { Resource } from "../core/model.ts";
import { KINDS } from "./kinds.ts";
import { useStore } from "./store.ts";

const OS_ICONS: Record<MachineOs, { readonly glyph: string; readonly name: string }> = {
  macos: { glyph: "🍎", name: "macOS" },
  linux: { glyph: "🐧", name: "Linux" },
  windows: { glyph: "🪟", name: "Windows" },
};

/**
 * K-524: an icon in an ink tile. It shows `image` when it loads, else `glyph`, so a broken image falls back to the
 * kind icon.
 */
export function IconTile(props: { image: string | null; glyph: string; tip: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const image = props.image !== null && props.image !== broken ? props.image : null;
  return (
    <span class={`item-icon${image ? " image" : ""}`} data-tip={props.tip}>
      {image ? (
        <img
          src={image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
          onError={() => setBroken(image)}
        />
      ) : (
        props.glyph
      )}
    </span>
  );
}

const avatarTip = (owner: string) => `The GitHub avatar of ${owner}, the owner of this repo.`;

/** K-524: a repo of the repo gate (K-819) shows the avatar of its owner, as a repo card does. */
export function RepoIcon(props: { name: string }) {
  const owner = repoOwner(props.name);
  return owner === null ? (
    <IconTile image={null} glyph={KINDS.repo.icon} tip={KINDS.repo.help} />
  ) : (
    <IconTile image={avatarUrl(owner)} glyph={KINDS.repo.icon} tip={avatarTip(owner)} />
  );
}

/** K-524: the icon of a card: its own icon when it has one, else the icon of its kind. */
export function ItemIcon(props: { resource: Resource }) {
  const { snapshot } = useStore();
  const { resource } = props;
  const kind = KINDS[resource.kind];
  const os = snapshot?.machines.find((view) => view.machine.id === resource.id)?.os ?? null;
  const icon = cardIcon(resource, snapshot?.icons ?? {}, os);
  switch (icon._tag) {
    case "site":
      return <IconTile image={icon.src} glyph={kind.icon} tip={`The icon of ${resource.name}, from ${resource.kind === "site.static" ? "its files" : "the running app"}.`} />;
    case "avatar":
      return <IconTile image={icon.src} glyph={kind.icon} tip={avatarTip(icon.owner)} />;
    case "os":
      return <IconTile image={null} glyph={OS_ICONS[icon.os].glyph} tip={`${OS_ICONS[icon.os].name}: the system of this machine.`} />;
    case "kind":
      return <IconTile image={null} glyph={kind.icon} tip={kind.help} />;
  }
}
