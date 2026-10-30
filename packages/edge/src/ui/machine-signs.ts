import type { ProviderRefusal } from "@kitshn/local";
import { type AccessState, type MachineView } from "../core/protocol.ts";
import type { Resource, State } from "../core/model.ts";
import { machineMember } from "./members.ts";
import { refusalText } from "./refusal.ts";

/** "t3" reads as "T3", "riffle" as "Riffle". */
const providerLabel = (provider: string) =>
  provider.length <= 3 ? provider.toUpperCase() : `${provider[0]?.toUpperCase()}${provider.slice(1)}`;

export interface MachineProblem {
  /** Fits a sticker. */
  readonly short: string;
  /** What is wrong and the next step, for the tip and the panel. */
  readonly long: string;
}

/**
 * K-515: what is wrong on a machine that kitshn can reach, worst first. A healthy machine has none, so its card shows
 * nothing new. Known limit: a provider that hangs while its bridge stays alive keeps its connection, so it reports
 * nothing (K-704). Revisit if owners meet a hung T3. An offline machine is the presence sticker's job.
 */
export function machineProblems(
  view: MachineView,
  checks: ReadonlyArray<string>,
): ReadonlyArray<MachineProblem> {
  if (!view.online) return [];
  const name = view.machine.name;
  const offline = (entry: ProviderRefusal) => ({
    short: `${providerLabel(entry.provider)} lost kitshn`,
    long: `${providerLabel(entry.provider)} on ${name} has no connection to its kitshn daemon: ${entry.reason}. Its cards do not update. Start ${providerLabel(entry.provider)}, and it registers again by itself.`,
  });
  const refused = (entry: ProviderRefusal) => ({
    short: `kitshn refused ${providerLabel(entry.provider)}`,
    long: refusalText(providerLabel(entry.provider), name, entry.reason),
  });
  return [
    ...(view.status?.refusedProviders ?? []).map(refused),
    ...(view.status?.offlineProviders ?? []).map(offline),
    ...(view.status?.tunnel === "stopped"
      ? [
          {
            short: "tunnel stopped",
            long: `The tunnel of ${name} stopped, so its addresses do not answer. Restart its daemon.`,
          },
        ]
      : []),
    ...(view.keyFailure
      ? [
          {
            short: "key check failed",
            long: `${name} failed its key check: ${view.keyFailure.reason}. Reset key in its panel gives it a new one.`,
          },
        ]
      : []),
    ...checks.map((check) => ({ short: "check red", long: `Health check (K-631): ${check}` })),
  ];
}

export interface ChecklistRow {
  readonly label: string;
  readonly done: boolean;
  /** The next step while it is not done. */
  readonly next: string;
}

/**
 * K-633: the steps of a new machine, from what kitshn knows already. Each row keeps its tick while the machine is
 * offline, so an old machine never falls back into this list; `machineProblems` says what went wrong later.
 */
export function connectChecklist(
  view: MachineView,
  state: State,
  access: Readonly<Record<string, AccessState>>,
): ReadonlyArray<ChecklistRow> {
  const id = view.machine.id;
  const own = [...state.resources.values()].filter((card) => card.id === id || card.machine === id);
  const hasProvider = (card: Resource) =>
    card.provider?.name === "t3" && card.provider.droppedAt === undefined;
  const addressed = own.filter((card) => card.addresses.length > 0);
  return [
    {
      label: "Daemon connected",
      done: view.lastSeen !== null,
      next: "Run the join command on the machine.",
    },
    {
      label: "T3 registered",
      done:
        own.some(hasProvider) ||
        (view.status?.offlineProviders ?? []).some((entry) => entry.provider === "t3"),
      next: `Start T3 on ${view.machine.name}. It registers by itself.`,
    },
    {
      label: "Address live",
      done: addressed.some((card) => access[card.id]?.state === "applied"),
      next: "It follows T3. Take the address in the T3 card's menu if something else serves it.",
    },
    {
      label: "Member of a circle",
      done: [...state.circles.values()].some((circle) => machineMember(circle, id)),
      next: "Drop its card on a circle's title, or use Member of below.",
    },
  ];
}
