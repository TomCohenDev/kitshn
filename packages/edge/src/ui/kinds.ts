import type { Level, Member, ResourceKind } from "../core/model.ts";

export const KINDS: Record<ResourceKind, { readonly label: string; readonly icon: string; readonly color: string; readonly tilt: string }> = {
  "kitshn.admin": { label: "Admin", icon: "🔐", color: "var(--accent)", tilt: "-2deg" },
  machine: { label: "Machines", icon: "🖥", color: "var(--info)", tilt: "-3deg" },
  "site.static": { label: "Static sites", icon: "🌐", color: "var(--green)", tilt: "2deg" },
  "site.worker": { label: "Worker apps", icon: "⚙️", color: "var(--green)", tilt: "1deg" },
  "site.compose": { label: "Compose apps", icon: "📦", color: "var(--green)", tilt: "-1deg" },
  "site.live": { label: "Live sites", icon: "📡", color: "var(--warning)", tilt: "3deg" },
  page: { label: "Pages", icon: "📄", color: "var(--yellow)", tilt: "-1.5deg" },
  file: { label: "Files", icon: "🗂", color: "var(--warning)", tilt: "-2deg" },
  repo: { label: "Repos", icon: "📚", color: "var(--pink)", tilt: "2.5deg" },
};

export const MEMBER_ICONS: Record<Member["_tag"], string> = {
  email: "👤",
  domain: "@",
  ip: "🛜",
  device: "📱",
  machine: "🖥",
  everyone: "🌍",
};

export const LEVEL_TILTS: Record<Level, string> = { view: "2deg", use: "-2deg", control: "3deg" };

export const CIRCLE_COLORS = ["#6C5CE7", "#FF5277", "#00B3FF", "#FFB347", "#7CFF8A", "#8250DF"];
