import {
  type Edit,
  type Item,
  RuleError,
  applyChanges,
  isAppCard,
  refuseRaiseWhilePaused,
  resolveEdits,
  ruleViolation,
} from "../core/changes.ts";
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
import { placeInside } from "../core/place.ts";
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
  /** More words that the palette search finds, such as the words of an older label. */
  readonly keywords?: string;
  /** The choice of a group of options, such as a level, that is the current one (a radio item). */
  readonly checked?: boolean;
  /** Why kitshn refuses this action now; the menu shows it disabled with this as its tooltip. */
  readonly refused?: string;
} & ({ readonly run: () => void } | { readonly items: ReadonlyArray<Action> });

/** Groups that the menu splits with a separator. */
export type ActionGroups = ReadonlyArray<ReadonlyArray<Action>>;

export type MenuTarget =
  | { readonly _tag: "card"; readonly id: string }
  | { readonly _tag: "stack"; readonly id: string }
  | { readonly _tag: "circle"; readonly id: string }
  | { readonly _tag: "map"; readonly at: Point }
  /** K-526: the "+" of the toolbar. */
  | { readonly _tag: "add" };

export interface ActionContext {
  readonly state: State;
  /** K-909: the cards that a deploy made. */
  readonly deployed: ReadonlySet<string>;
  readonly machines: ReadonlyMap<string, MachineView>;
  /** K-617: the release of this kitshn, or a local build. */
  readonly version: string;
  /** K-1507: the per-item undo that the open menu or palette asked the server about, or null. */
  readonly undoCheck: UndoCheck | null;
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
  /** Adds a member to a circle that the owner picks next. */
  readonly addMemberSomewhere: () => void;
  readonly fit: () => void;
  readonly undoItem: (item: Item) => void;
}

/** K-1507: the answer of `GET /api/undo-item`. */
export type UndoAnswer = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * K-523, K-1507: the per-item undo that a menu or the palette asked about. `answer` is null while the request
 * runs; `slow` turns on after 150 ms, so a quick answer never shows the checking state.
 */
export interface UndoCheck {
  readonly key: string;
  readonly answer: UndoAnswer | null;
  readonly slow: boolean;
}

export const itemKey = (item: Item) => `${item.kind}:${item.id}`;

export const CHECKING_TIP = "Checking whether this can be undone";

/** K-1507: the check with its answer, or unchanged when the answer is for another item or a closed menu. */
export const settleUndoCheck = (check: UndoCheck | null, key: string, answer: UndoAnswer) =>
  check?.key === key ? { ...check, answer } : check;

/** K-1507: the check in its visible checking state, unless it has its answer or is for another item. */
export const slowUndoCheck = (check: UndoCheck | null, key: string) =>
  check?.key === key && check.answer === null ? { ...check, slow: true } : check;

/**
 * K-523, K-1507: "Undo last change to this card" or "… circle", only for the item that the server was asked
 * about: disabled while it checks, then enabled, or disabled with the reason when kitshn refuses it.
 */
function undoItemAction(ctx: ActionContext, h: ActionHandlers, item: Item): Array<Action> {
  const check = ctx.undoCheck;
  if (check?.key !== itemKey(item)) return [];
  const label = `Undo last change to this ${item.kind}`;
  const base = {
    id: "undo-item",
    tip: `Undo your newest change to this ${item.kind}, and only its part of that change.`,
    run: () => h.undoItem(item),
  };
  if (check.answer === null) return [{ ...base, label: check.slow ? `${label} (checking…)` : label, refused: CHECKING_TIP }];
  return [{ ...base, label, ...(check.answer.allowed ? {} : { refused: check.answer.reason }) }];
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

/** The reason why kitshn refuses these edits (K-105, K-521, K-1504), or null. The server checks the same. */
export function refusal(state: State, edits: ReadonlyArray<Edit>): string | null {
  try {
    const after = applyChanges(state, resolveEdits(state, edits));
    refuseRaiseWhilePaused(state, after);
    return ruleViolation(after);
  } catch (error) {
    if (error instanceof RuleError) return error.message;
    throw error;
  }
}

/** K-511: the edit that shares or unshares a card without a drag, or why no spot on the map fits. */
export function reshareEdits(
  state: State,
  resource: Resource,
  circle: Circle,
  share: boolean,
): { readonly edits: Array<Edit> } | { readonly refused: string } {
  const wanted = new Set(circlesHolding(state, resource.id).map((held) => held.id));
  if (share) wanted.add(circle.id);
  else wanted.delete(circle.id);
  const to = placeInside(state, state.places.get(resource.id) ?? { x: circle.x, y: circle.y }, wanted);
  if (!to)
    return {
      refused: `No spot on the map is inside exactly those circles. Move "${circle.name}" so it overlaps the others, or drag the card.`,
    };
  // A stacked card takes its stack along (K-521); resolveEdits adds its mates.
  const edits: Array<Edit> = [{ _tag: "place", id: resource.id, after: to }];
  const refused = refusal(state, edits);
  return refused ? { refused } : { edits };
}

/**
 * K-522: the edits that put cards onto `target` (into its stack, or a new stack `newId`), with the toast text,
 * or null when no card moves. A card leaves its old stack; a stack left with one card goes.
 */
export function stackOntoEdits(
  state: State,
  ids: ReadonlyArray<string>,
  target: string,
  newId: string,
): { readonly edits: Array<Edit>; readonly done: string } | { readonly refused: string } | null {
  const place = state.places.get(target);
  if (!place) return { refused: "Put one of the cards on the map first." };
  const into = [...state.stacks.values()].find((stack) => stack.members.includes(target));
  const moving = ids.filter((id) => id !== target && !into?.members.includes(id));
  if (moving.length === 0) return null;
  const edits: Array<Edit> = moving.map((id) => ({ _tag: "place", id, after: place }));
  for (const stack of state.stacks.values()) {
    if (stack === into || !stack.members.some((id) => moving.includes(id))) continue;
    const rest = stack.members.filter((id) => !moving.includes(id));
    edits.push({ _tag: "stack", id: stack.id, after: rest.length > 1 ? { ...stack, members: rest } : null });
  }
  const targetName = state.resources.get(target)?.name;
  const id = into?.id ?? newId;
  edits.push({
    _tag: "stack",
    id,
    after: { id, name: into?.name ?? targetName ?? "Stack", members: [...(into?.members ?? [target]), ...moving] },
  });
  const names = moving.flatMap((card) => state.resources.get(card)?.name ?? []).join(", ");
  const refused = refusal(state, edits);
  return refused ? { refused } : { edits, done: `Stacked ${names} with ${into?.name ?? targetName ?? "the card"}.` };
}

/**
 * The refusal of these edits as an action field. Cached per state, so an open palette does not check every
 * card again on each render; a new state (a broadcast) is a new cache.
 */
const refusals = new WeakMap<State, Map<string, string | null>>();
const refusedBy = (state: State, edits: ReadonlyArray<Edit>) => {
  const cache = refusals.get(state) ?? new Map<string, string | null>();
  refusals.set(state, cache);
  const key = JSON.stringify(edits);
  const refused = cache.has(key) ? (cache.get(key) ?? null) : refusal(state, edits);
  cache.set(key, refused);
  return refused ? { refused } : {};
};

/** The first card of a stack; a stack always holds two or more (K-521). */
const firstOf = (stack: Stack): string => {
  const first = stack.members[0];
  if (first === undefined) throw new Error(`The stack ${stack.id} has no card.`);
  return first;
};

const ownStack = (state: State, id: string): Stack | undefined =>
  [...state.stacks.values()].find((stack) => stack.members.includes(id));

const plans = new WeakMap<State, Map<string, ReturnType<typeof reshareEdits>>>();
/** `reshareEdits`, cached per state like `refusedBy`. */
const cachedReshare = (state: State, resource: Resource, circle: Circle, share: boolean) => {
  const cache = plans.get(state) ?? new Map<string, ReturnType<typeof reshareEdits>>();
  plans.set(state, cache);
  const key = `${resource.id}/${circle.id}/${share}`;
  const plan = cache.get(key) ?? reshareEdits(state, resource, circle, share);
  cache.set(key, plan);
  return plan;
};

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
            items: others.map((circle) => {
              const plan = cachedReshare(state, resource, circle, true);
              return {
                id: `share:${circle.id}`,
                label: circle.name,
                tip: `Share ${resource.name} with ${circle.name} at ${circle.level}. Its other circles stay.`,
                ...("refused" in plan ? { refused: plan.refused } : {}),
                run: () => h.reshare(resource, circle, true),
              };
            }),
          },
        ]
      : []),
    ...(held.length > 0
      ? [
          {
            id: "unshare",
            label: "Unshare from",
            tip: `Move ${resource.name} out of one circle, without a drag. Its other circles stay.`,
            items: held.map((circle) => {
              const plan = cachedReshare(state, resource, circle, false);
              return {
                id: `unshare:${circle.id}`,
                label: circle.name,
                tip: `Move ${resource.name} out of ${circle.name}. Its other circles stay.`,
                ...("refused" in plan ? { refused: plan.refused } : {}),
                run: () => h.reshare(resource, circle, false),
              };
            }),
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
        label: level ?? `default (${circle.level})`,
        checked: level === current,
        ...(level === current ? {} : refusedBy(state, [levelEdit(state, resource, circle, level)])),
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
              items: stacks.map((other) => {
                const plan = stackOntoEdits(state, [resource.id], firstOf(other), other.id);
                return {
                  id: `add-to-stack:${other.id}`,
                  label: other.name,
                  tip: `Put ${resource.name} into ${other.name}. It gets the circles of ${other.name}.`,
                  ...(plan && "refused" in plan ? { refused: plan.refused } : {}),
                  run: () => h.stackOnto([resource.id], firstOf(other)),
                };
              }),
            },
          ]
        : []),
      ...(placed && resource.id !== ADMIN_RESOURCE_ID
        ? [
            {
              id: "tray",
              label: "Move to tray",
              tip: "Take the card off the map. It leaves every circle, so it is private. Undo puts it back.",
              ...refusedBy(state, [{ _tag: "place", id: resource.id, after: null }]),
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
    undoItemAction(ctx, h, { kind: "card", id: resource.id }),
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
  const first = state.resources.get(firstOf(stack));
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

export function circleActions(ctx: ActionContext, h: ActionHandlers, circle: Circle): ActionGroups {
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
    undoItemAction(ctx, h, { kind: "circle", id: circle.id }),
    // K-211: the Owner circle cannot be deleted.
    circle.id === OWNER_CIRCLE_ID
      ? []
      : [
          {
            id: "delete",
            label: "Delete circle",
            tip: `Delete ${circle.name} at once. Its cards stay where they are and lose this share; Undo brings it back.`,
            danger: true as const,
            ...refusedBy(ctx.state, [{ _tag: "circle", id: circle.id, after: null }]),
            run: () => h.deleteCircle(circle),
          },
        ],
  ].filter((group) => group.length > 0);
}

/**
 * K-526: everything that the owner can add. The toolbar "+" and the menu of an empty spot both show this one
 * list, so they never differ. `at` is the spot, or null for the middle of the view.
 */
export function addActions(h: ActionHandlers, at: Point | null): ReadonlyArray<Action> {
  const here = at ? " here" : "";
  return [
    {
      id: "new-circle",
      label: `New circle${here}`,
      tip: `Make a new circle${at ? " at this spot" : " in the middle of the view"}. It matches nobody until you add members.`,
      run: () => h.newCircle(at),
    },
    {
      id: "upload",
      label: `Upload a page or a file${here}`,
      keywords: "upload html",
      tip: at
        ? "Upload files to this spot: they land in exactly the circles here, so they get those shares."
        : "Upload files: they wait in the tray, private.",
      run: () => h.upload(at),
    },
    {
      id: "add-site",
      label: "Add a site",
      keywords: "live from a machine or static from a repo",
      tip: "Share a local server of a machine, or set up a static site from a repo. Its card starts in the tray, private.",
      run: h.addSite,
    },
    {
      id: "add-machine",
      label: "Add a machine",
      keywords: "join code",
      tip: "Make a join command for a new machine. Its card starts in the tray, private.",
      run: h.addMachine,
    },
    {
      id: "add-member",
      label: "Add a member",
      keywords: "person domain device network",
      tip: "Add a person, a domain, a device or a network to a circle that you pick next.",
      run: h.addMemberSomewhere,
    },
  ];
}

/** An empty spot of the map, or `at: null` for the palette, which adds in the middle of the view. */
export function mapActions(_ctx: ActionContext, h: ActionHandlers, at: Point | null): ActionGroups {
  return [addActions(h, at), [{ id: "fit", label: "Fit the map", tip: "Fit every circle and card in the view.", run: h.fit }]];
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
    case "add":
      return [addActions(h, null)];
  }
}

export interface PaletteEntry {
  readonly label: string;
  readonly tip: string;
  readonly danger?: true;
  readonly keywords?: string;
  readonly run: () => void;
}

/**
 * One entry per action, with sub-lists spelled out and the item name in front, so a search finds them. A
 * refused action and the current choice of a radio group have no entry: there is nothing to run.
 */
export function flatten(groups: ActionGroups, prefix: string): Array<PaletteEntry> {
  const walk = (action: Action, label: string): Array<PaletteEntry> =>
    action.refused !== undefined || action.checked
      ? []
      : "items" in action
        ? action.items.flatMap((item) => walk(item, `${label}: ${item.label}`))
        : [
            {
              label,
              tip: action.tip,
              run: action.run,
              ...(action.danger ? { danger: action.danger } : {}),
              ...(action.keywords ? { keywords: action.keywords } : {}),
            },
          ];
  return groups.flat().flatMap((action) => walk(action, prefix ? `${prefix} · ${action.label}` : action.label));
}

/**
 * What Enter runs in the palette: the active entry, unless it is dangerous and the owner did not pick it with
 * the arrows or the pointer while other entries match. Then Enter does nothing, so a typo never removes.
 */
export function paletteEnter(
  matches: ReadonlyArray<Pick<PaletteEntry, "danger">>,
  active: number,
  picked: boolean,
): number | null {
  const entry = matches[active];
  if (!entry) return null;
  return entry.danger && matches.length > 1 && !picked ? null : active;
}

/**
 * The palette's active entry, kept by label so a broadcast that reorders the matches never changes what Enter
 * runs. `picked` is true only after the arrows moved to it; a hover or a new query clears it.
 */
export interface PaletteCursor {
  readonly label: string | null;
  readonly picked: boolean;
}

/** The index of the active entry: the one with the cursor's label, else the first match. */
export function paletteActive(labels: ReadonlyArray<string>, cursor: PaletteCursor): { index: number; picked: boolean } {
  const index = cursor.label === null ? -1 : labels.indexOf(cursor.label);
  return index === -1 ? { index: 0, picked: false } : { index, picked: cursor.picked };
}

/** ArrowDown and ArrowUp move the cursor; a key that does not move it changes nothing. */
export function paletteArrow(key: "ArrowDown" | "ArrowUp", labels: ReadonlyArray<string>, cursor: PaletteCursor): PaletteCursor {
  const { index } = paletteActive(labels, cursor);
  const next = key === "ArrowDown" ? Math.min(index + 1, labels.length - 1) : Math.max(index - 1, 0);
  const label = labels[next];
  return next === index || label === undefined ? cursor : { label, picked: true };
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
