import type { Circle, Point, Resource } from "./model.ts";

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
  ];
  const places: Array<readonly [string, Point]> = [
    ["mac", { x: -150, y: -120 }],
    ["vps", { x: 120, y: -150 }],
    ["riffle", { x: 250, y: 120 }],
    ["riffle-pr-41", { x: 250, y: 120 }],
    ["riffle-pr-42", { x: 250, y: 120 }],
    ["tick3d", { x: 760, y: 40 }],
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
