import { type Edit, isAppCard } from "../core/changes.ts";
import type { Command } from "../core/machine.ts";
import {
  ADMIN_RESOURCE_ID,
  type Circle,
  type Level,
  OWNER_CIRCLE_ID,
  type Point,
  RESOURCE_KINDS,
  type Resource,
  type Stack,
  type State,
  circlesHolding,
  shareKey,
} from "../core/model.ts";
import type { MachineView } from "../core/protocol.ts";
import { KINDS } from "./kinds.ts";
import type { Selection } from "./Map.tsx";

/**
 * K-523: the actions of one card, stack, circle or spot on the map. The context menu and the command palette
 * both show these lists, so neither has an action that the other lacks.
 */
export type Action = {
  /** Stable within one list, for tests and keys. */
  readonly id: string;
  readonly label: string;
  /** One sentence: what happens. */
  readonly tip: string;
  readonly danger?: true;
} & ({ readonly run: () => void } | { readonly items: ReadonlyArray<Action> });

/** Groups that the menu splits with a separator. */
export type ActionGroups = ReadonlyArray<ReadonlyArray<Action>>;

export type MenuTarget =
  | { readonly _tag: "card"; readonly id: string }
  | { readonly _tag: "stack"; readonly id: string }
  | { readonly _tag: "circle"; readonly id: string }
  | { readonly _tag: "map"; readonly at: Point };

export interface ActionContext {
  readonly state: State;
  /** K-909: the cards that a deploy made. */
  readonly deployed: ReadonlySet<string>;
  readonly machines: ReadonlyMap<string, MachineView>;
  /** K-617: the release of this kitshn, or a local build. */
  readonly version: string;
}

export interface ActionHandlers {
  readonly select: (selection: Selection) => void;
  readonly openAddress: (address: string) => void;
  readonly copyAddress: (address: string) => void;
  readonly reshare: (resource: Resource, circle: Circle, share: boolean) => void;
  readonly setLevel: (resource: Resource, circle: Circle, level: Level | null) => void;
  readonly place: (resource: Resource) => void;
  readonly toTray: (resource: Resource) => void;
  readonly stackOnto: (ids: Array<string>, target: string) => void;
  readonly pullOut: (stackId: string, id: string) => void;
  readonly unstack: (stackId: string) => void;
  readonly renameStack: (stackId: string) => void;
  readonly removeApp: (resource: Resource) => void;
  readonly runJob: (view: MachineView, command: Command) => void;
  readonly removeMachine: (view: MachineView) => void;
  readonly editCircle: (circleId: string) => void;
  readonly renameCircle: (circleId: string) => void;
  readonly addMember: (circleId: string) => void;
  readonly deleteCircle: (circle: Circle) => void;
  readonly newCircle: (at: Point | null) => void;
  readonly upload: (at: Point | null) => void;
  readonly addSite: () => void;
  readonly addMachine: () => void;
  readonly fit: () => void;
}

/** K-617: a local build names no release, so there is nothing to update a daemon to. */
export const isRelease = (version: string) => /^[0-9a-f]{12}$/.test(version);

export const MACHINE_TIPS = {
  restart: "Restart the daemon. The tunnel keeps running, so apps and sites keep serving.",
  update: (version: string) => `Update daemon: install the daemon of release ${version}.`,
  remove: "Remove machine: deletes its service token, its tunnel and its queue at once. History records it; Undo cannot bring it back.",
} as const;

export const REMOVE_APP_TIP = "Remove app: take down what the deploy made and keep the volumes. Undo starts it again.";

/** K-205: the edit that gives a card its own level in a circle, or with null follows the circle again. */
export function levelEdit(state: State, resource: Resource, circle: Circle, level: Level | null): Edit {
  const endsAt = state.shareSettings.get(shareKey(resource.id, circle.id))?.endsAt ?? null;
  return {
    _tag: "shareSetting",
    resourceId: resource.id,
    circleId: circle.id,
    after: level === null && endsAt === null ? null : { level, endsAt },
  };
}

const ownStack = (state: State, id: string): Stack | undefined =>
  [...state.stacks.values()].find((stack) => stack.members.includes(id));

/** Share with or unshare from circles, without a drag (K-511). A stacked card takes its stack along. */
function shareActions(state: State, h: ActionHandlers, resource: Resource): Array<Action> {
  if (!state.places.has(resource.id)) return [];
  const holding = new Set(circlesHolding(state, resource.id).map((circle) => circle.id));
  const circles = [...state.circles.values()];
  const others = circles.filter((circle) => !holding.has(circle.id));
  const held = circles.filter((circle) => holding.has(circle.id));
  return [
    ...(others.length > 0
      ? [
          {
            id: "share",
            label: "Share with",
            tip: `Put ${resource.name} where one more circle holds it, without a drag.`,
            items: others.map((circle) => ({
              id: `share:${circle.id}`,
              label: circle.name,
              tip: `Share ${resource.name} with ${circle.name} at ${circle.level}. Its other circles stay.`,
              run: () => h.reshare(resource, circle, true),
            })),
          },
        ]
      : []),
    ...(held.length > 0
      ? [
          {
            id: "unshare",
            label: "Unshare from",
            tip: `Move ${resource.name} out of one circle, without a drag. Its other circles stay.`,
            items: held.map((circle) => ({
              id: `unshare:${circle.id}`,
              label: circle.name,
              tip: `Move ${resource.name} out of ${circle.name}. Its other circles stay.`,
              run: () => h.reshare(resource, circle, false),
            })),
          },
        ]
      : []),
  ];
}

/** K-205: a level override per circle, only for a kind with more than one level. */
function levelActions(state: State, h: ActionHandlers, resource: Resource): Array<Action> {
  const levels: ReadonlyArray<Level> = RESOURCE_KINDS[resource.kind];
  if (levels.length < 2) return [];
  return circlesHolding(state, resource.id).map((circle) => {
    const current = state.shareSettings.get(shareKey(resource.id, circle.id))?.level ?? null;
    return {
      id: `level:${circle.id}`,
      label: `Level in ${circle.name}`,
      tip: `Give ${resource.name} its own level in ${circle.name}, or follow the circle.`,
      items: [null, ...levels].map((level) => ({
        id: `level:${circle.id}:${level ?? "default"}`,
        label: `${level ?? `default (${circle.level})`}${level === current ? " ✓" : ""}`,
        tip:
          level === null
            ? `Default: ${resource.name} follows the level of ${circle.name}, now ${circle.level}.`
            : `${resource.name} gets ${level} in ${circle.name}, whatever the default.`,
        run: () => h.setLevel(resource, circle, level),
      })),
    };
  });
}

export function cardActions(ctx: ActionContext, h: ActionHandlers, resource: Resource): ActionGroups {
  const { state } = ctx;
  const address = resource.addresses[0];
  const placed = state.places.has(resource.id);
  const stack = ownStack(state, resource.id);
  const stacks = [...state.stacks.values()].filter((other) => other !== stack);
  const machine = ctx.machines.get(resource.id);
  const kind = KINDS[resource.kind].label.toLowerCase();
  return [
    [
      {
        id: "details",
        label: "Show details",
        tip: `Select ${resource.name} and show its panel.`,
        run: () => h.select({ cards: new Set([resource.id]), circle: null }),
      },
      ...(address
        ? [
            {
              id: "open",
              label: "Open",
              tip: `Open https://${address} in a new tab.`,
              run: () => h.openAddress(address),
            },
            {
              id: "copy",
              label: "Copy address",
              tip: `Copy https://${address} to the clipboard.`,
              run: () => h.copyAddress(address),
            },
          ]
        : []),
    ],
    [
      ...(placed
        ? []
        : [
            {
              id: "place",
              label: "Place on the map",
              tip: "Place the card in the middle of the view, outside every circle, so it stays private.",
              run: () => h.place(resource),
            },
          ]),
      ...shareActions(state, h, resource),
      ...levelActions(state, h, resource),
      {
        id: "select-kind",
        label: `Select all ${kind}`,
        tip: `Select every card of ${kind} on the map, so they move as one.`,
        run: () =>
          h.select({
            cards: new Set(
              [...state.resources.values()]
                .filter((other) => other.kind === resource.kind && state.places.has(other.id))
                .map((other) => other.id),
            ),
            circle: null,
          }),
      },
    ],
    [
      ...(stack
        ? [
            {
              id: "leave-stack",
              label: `Leave stack ${stack.name}`,
              tip: "The card lands next to the stack, in the same circles, so no share changes.",
              run: () => h.pullOut(stack.id, resource.id),
            },
          ]
        : []),
      ...(stacks.length > 0
        ? [
            {
              id: "add-to-stack",
              label: "Add to stack",
              tip: `Put ${resource.name} into a stack: it moves to the stack and gets its circles.`,
              items: stacks.map((other) => ({
                id: `add-to-stack:${other.id}`,
                label: other.name,
                tip: `Put ${resource.name} into ${other.name}. It gets the circles of ${other.name}.`,
                run: () => h.stackOnto([resource.id], other.members[0] ?? ""),
              })),
            },
          ]
        : []),
      ...(placed && resource.id !== ADMIN_RESOURCE_ID
        ? [
            {
              id: "tray",
              label: "Move to tray",
              tip: "Take the card off the map. It leaves every circle, so it is private. Undo puts it back.",
              run: () => h.toTray(resource),
            },
          ]
        : []),
    ],
    machine
      ? [
          {
            id: "restart",
            label: "Restart daemon",
            tip: MACHINE_TIPS.restart,
            run: () => h.runJob(machine, { kind: "restart" }),
          },
          ...(isRelease(ctx.version)
            ? [
                {
                  id: "update",
                  label: "Update daemon",
                  tip: MACHINE_TIPS.update(ctx.version),
                  run: () => h.runJob(machine, { kind: "update", version: ctx.version }),
                },
              ]
            : []),
        ]
      : [],
    [
      ...(isAppCard(resource) && ctx.deployed.has(resource.id)
        ? [{ id: "remove-app", label: "Remove app", tip: REMOVE_APP_TIP, danger: true as const, run: () => h.removeApp(resource) }]
        : []),
      ...(machine
        ? [
            {
              id: "remove-machine",
              label: "Remove machine: deletes its token and tunnel",
              tip: MACHINE_TIPS.remove,
              danger: true as const,
              run: () => h.removeMachine(machine),
            },
          ]
        : []),
    ],
  ].filter((group) => group.length > 0);
}

/** K-521, K-522: a closed stack of the owner. Shares go through its first card, which takes the stack along. */
export function stackActions(ctx: ActionContext, h: ActionHandlers, stack: Stack): ActionGroups {
  const { state } = ctx;
  const first = state.resources.get(stack.members[0] ?? "");
  const members = stack.members.flatMap((id) => state.resources.get(id) ?? []);
  return [
    [
      {
        id: "details",
        label: "Show details",
        tip: `Select ${stack.name} and show its panel.`,
        run: () => h.select({ cards: new Set(stack.members), circle: null }),
      },
      {
        id: "rename",
        label: "Rename",
        tip: `Rename ${stack.name} in its panel.`,
        run: () => h.renameStack(stack.id),
      },
    ],
    first ? shareActions(state, h, first) : [],
    [
      {
        id: "pull-out",
        label: "Pull out",
        tip: "Take one card out. It lands next to the stack, in the same circles, so no share changes.",
        items: members.map((member) => ({
          id: `pull-out:${member.id}`,
          label: `${KINDS[member.kind].icon} ${member.name}`,
          tip: `Take ${member.name} out of ${stack.name}.`,
          run: () => h.pullOut(stack.id, member.id),
        })),
      },
      {
        id: "unstack",
        label: "Unstack",
        tip: "Spread all cards in the same circles.",
        run: () => h.unstack(stack.id),
      },
    ],
  ].filter((group) => group.length > 0);
}

export function circleActions(_ctx: ActionContext, h: ActionHandlers, circle: Circle): ActionGroups {
  return [
    [
      {
        id: "edit",
        label: "Edit",
        tip: `Edit ${circle.name}: its members, level, match and end.`,
        run: () => h.editCircle(circle.id),
      },
      { id: "rename", label: "Rename", tip: `Rename ${circle.name} in its panel.`, run: () => h.renameCircle(circle.id) },
      {
        id: "add-member",
        label: "Add a member",
        tip: "Add a person, a domain, a device or a network to the circle.",
        run: () => h.addMember(circle.id),
      },
    ],
    // K-211: the Owner circle cannot be deleted.
    circle.id === OWNER_CIRCLE_ID
      ? []
      : [
          {
            id: "delete",
            label: "Delete circle",
            tip: `Delete ${circle.name} at once. Its cards stay where they are and lose this share; Undo brings it back.`,
            danger: true as const,
            run: () => h.deleteCircle(circle),
          },
        ],
  ].filter((group) => group.length > 0);
}

/** An empty spot of the map, or `at: null` for the palette, which adds in the middle of the view. */
export function mapActions(_ctx: ActionContext, h: ActionHandlers, at: Point | null): ActionGroups {
  const here = at ? " here" : "";
  return [
    [
      {
        id: "new-circle",
        label: `New circle${here}`,
        tip: `Make a new circle${at ? " at this spot" : " in the middle of the view"}. It matches nobody until you add members.`,
        run: () => h.newCircle(at),
      },
      {
        id: "upload",
        label: `Upload a page or a file${here}`,
        tip: at
          ? "Upload files to this spot: they land in exactly the circles here, so they get those shares."
          : "Upload files: they wait in the tray, private.",
        run: () => h.upload(at),
      },
      {
        id: "add-site",
        label: "Add a site",
        tip: "Share a local server of a machine, or set up a static site from a repo. Its card starts in the tray, private.",
        run: h.addSite,
      },
      {
        id: "add-machine",
        label: "Add a machine",
        tip: "Make a join command for a new machine. Its card starts in the tray, private.",
        run: h.addMachine,
      },
    ],
    [{ id: "fit", label: "Fit the map", tip: "Fit every circle and card in the view.", run: h.fit }],
  ];
}

/** The groups for a menu target, or null when its item is gone. */
export function actionsFor(ctx: ActionContext, h: ActionHandlers, target: MenuTarget): ActionGroups | null {
  switch (target._tag) {
    case "card": {
      const resource = ctx.state.resources.get(target.id);
      return resource ? cardActions(ctx, h, resource) : null;
    }
    case "stack": {
      const stack = ctx.state.stacks.get(target.id);
      return stack ? stackActions(ctx, h, stack) : null;
    }
    case "circle": {
      const circle = ctx.state.circles.get(target.id);
      return circle ? circleActions(ctx, h, circle) : null;
    }
    case "map":
      return mapActions(ctx, h, target.at);
  }
}

export interface PaletteEntry {
  readonly label: string;
  readonly tip: string;
  readonly danger?: true;
  readonly run: () => void;
}

/** One entry per action, with sub-lists spelled out and the item name in front, so a search finds them. */
export function flatten(groups: ActionGroups, prefix: string): Array<PaletteEntry> {
  const walk = (action: Action, label: string): Array<PaletteEntry> =>
    "items" in action
      ? action.items.flatMap((item) => walk(item, `${label}: ${item.label}`))
      : [{ label, tip: action.tip, run: action.run, ...(action.danger ? { danger: action.danger } : {}) }];
  return groups.flat().flatMap((action) => walk(action, prefix ? `${prefix} · ${action.label}` : action.label));
}

/** K-511: every card, stack and circle action, after the actions of the whole map. */
export function paletteEntries(ctx: ActionContext, h: ActionHandlers): Array<PaletteEntry> {
  const { state } = ctx;
  return [
    ...flatten(mapActions(ctx, h, null), ""),
    ...[...state.resources.values()].flatMap((resource) =>
      flatten(cardActions(ctx, h, resource), `${KINDS[resource.kind].icon} ${resource.name}`),
    ),
    ...[...state.stacks.values()].flatMap((stack) => flatten(stackActions(ctx, h, stack), `🗃 ${stack.name}`)),
    ...[...state.circles.values()].flatMap((circle) => flatten(circleActions(ctx, h, circle), `⭕ ${circle.name}`)),
  ];
}
