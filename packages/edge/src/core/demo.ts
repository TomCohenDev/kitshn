import type { MachineOs } from "./icons.ts";
import type { Machine } from "./machine.ts";
import type { Circle, Point, Resource } from "./model.ts";

/** K-524: the demo machines, offline, with the system of their last status, so their cards show it. */
export const DEMO_MACHINES: ReadonlyArray<{ readonly machine: Machine; readonly os: MachineOs }> = [
  { machine: { id: "mac", name: "Mac", labels: ["laptop"], order: 0, serviceTokenId: "demo-mac", clientId: "demo-mac.access", tunnelId: "demo-mac" }, os: "macos" },
  { machine: { id: "vps", name: "VPS", labels: ["server", "deploy"], order: 1, serviceTokenId: "demo-vps", clientId: "demo-vps.access", tunnelId: "demo-vps" }, os: "linux" },
];

/** K-1113: the stored icon of the demo static site. */
export const DEMO_SITE_ICON = {
  id: "tick3d",
  type: "image/svg+xml",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#FFE14D"/><path d="M7 17l6 6L25 9" fill="none" stroke="#000" stroke-width="5"/></svg>',
} as const;

/** Local development only (DEV_DEMO): sample cards and circles, so the map has something to show. */
export function demo() {
  const resource = (
    id: string,
    kind: Resource["kind"],
    name: string,
    address: string | null,
    group: string | null = null,
  ): Resource => ({
    id,
    kind,
    name,
    addresses: address ? [address] : [],
    status: "running",
    group,
    machine: null,
  });
  const resources = [
    resource("mac", "machine", "Mac", "t3-mac.example.com"),
    resource("vps", "machine", "VPS", "t3-vps.example.com"),
    resource("riffle", "site.compose", "riffle", "riffle.example.com", "riffle"),
    resource("riffle-pr-41", "site.compose", "riffle pr-41", "riffle-pr-41.example.com", "riffle"),
    resource("riffle-pr-42", "site.compose", "riffle pr-42", "riffle-pr-42.example.com", "riffle"),
    resource("tick3d", "site.static", "tick3d", "tick3d.example.com"),
    resource("ci-times", "page", "CI time table", null),
    resource("slides", "file", "slides.pdf", null),
    resource("kitshn-repo", "repo", "Yarden-zamir/kitshn", null),
  ];
  const places: Array<readonly [string, Point]> = [
    ["mac", { x: -150, y: -120 }],
    ["vps", { x: 120, y: -150 }],
    ["riffle", { x: 250, y: 120 }],
    ["riffle-pr-41", { x: 250, y: 120 }],
    ["riffle-pr-42", { x: 250, y: 120 }],
    ["tick3d", { x: 760, y: 40 }],
    ["kitshn-repo", { x: 760, y: 200 }],
  ];
  const her: Circle = {
    id: "her",
    name: "Her",
    color: "#FF5277",
    level: "use",
    members: [{ _tag: "email", email: "her@example.com" }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 380,
    y: 360,
    r: 240,
  };
  const qlik: Circle = {
    id: "qlik",
    name: "Qlik",
    color: "#00B3FF",
    level: "view",
    members: [
      { _tag: "domain", domain: "qlik.com" },
      { _tag: "ip", range: "10.0.0.0/8" },
    ],
    match: "all",
    needsPasskey: false,
    endsAt: null,
    x: -300,
    y: 520,
    r: 220,
  };
  // K-718: an agent key that manages the sites in its circle, and nothing else.
  const agents: Circle = {
    id: "agents",
    name: "Agents",
    color: "#14B8A6",
    level: "control",
    members: [{ _tag: "device", tokenId: "demo-agent", clientId: "demo-agent.access", name: "Deploy bot" }],
    match: "any",
    needsPasskey: false,
    endsAt: null,
    x: 760,
    y: 600,
    r: 200,
  };
  return { resources, places, circles: [her, qlik, agents] };
}
