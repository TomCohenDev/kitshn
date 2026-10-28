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
}

export const cardOutput = (output: CardOutput) => `${JSON.stringify(output)}\n`;

/** A refusal or any failure: the reason, as the CLI says it without `--json`. */
export const errorOutput = (error: string) => `${JSON.stringify({ error })}\n`;
