// The error of a kitshn CLI step that cannot go on, shared by the app CLI and the agent commands.

/** A step that cannot go on. The deploy of one app ends with it; the apps that do not need it go on (K-820). */
export class CliError extends Error {}

export const fail = (text: string): never => {
  throw new CliError(text);
};
