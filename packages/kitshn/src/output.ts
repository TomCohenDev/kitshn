/**
 * K-1116, K-1120, K-1123: the one JSON object that `kitshn publish --json` and `kitshn address --json` print on
 * stdout, for tools such as the T3 MCP tools. Everything else goes to stderr in that mode.
 */
export interface CardOutput {
  readonly address: string;
  readonly card: string;
  readonly kind: "page" | "file" | "folder";
  readonly updated: boolean;
  readonly revision?: number | null;
  /** C2 of the UX audit: the circles that open the card; [] in the tray; null when no circle of the agent holds it. */
  readonly circles?: ReadonlyArray<{ readonly id: string; readonly name: string }> | null;
}

const KINDS: ReadonlyArray<string> = ["page", "file", "folder"];

/**
 * The answer as `--json` prints it. A missing or empty `address` or `card`, or another `kind`, throws, so a tool never
 * reads an empty string as an address; the CLI prints that as `{"error"}` and exits with 1.
 */
export function cardOutput(answer: {
  readonly address?: unknown;
  readonly card?: unknown;
  readonly kind?: unknown;
  readonly updated: boolean;
  readonly revision?: number | null;
  readonly circles?: CardOutput["circles"];
}): string {
  const { address, card, kind } = answer;
  if (typeof address !== "string" || address === "") throw new Error("kitshn answered without an address");
  if (typeof card !== "string" || card === "") throw new Error("kitshn answered without a card");
  if (typeof kind !== "string" || !KINDS.includes(kind)) throw new Error("kitshn answered without a kind");
  const output: CardOutput = {
    address,
    card,
    kind: kind as CardOutput["kind"],
    updated: answer.updated,
    ...(answer.revision === undefined ? {} : { revision: answer.revision }),
    ...(answer.circles === undefined ? {} : { circles: answer.circles }),
  };
  return `${JSON.stringify(output)}\n`;
}

/** A refusal or any failure: the reason, as the CLI says it without `--json`. */
export const errorOutput = (error: string) => `${JSON.stringify({ error })}\n`;
