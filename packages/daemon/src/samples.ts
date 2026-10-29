// K-605, K-606: the samples that the daemon keeps on its disk, one JSON line each.

interface Sample {
  readonly at: number;
  readonly cpu: number;
  readonly memory: number;
  readonly disk: number;
}

/** The newest `count` samples of the file, oldest first; a line that is not a sample is left out. */
export function lastSamples(text: string, count: number): Array<Sample> {
  return text
    .split("\n")
    .slice(-count - 1)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as Partial<Sample>;
        return typeof value.at === "number" &&
          typeof value.cpu === "number" &&
          typeof value.memory === "number" &&
          typeof value.disk === "number"
          ? [{ at: value.at, cpu: value.cpu, memory: value.memory, disk: value.disk }]
          : [];
      } catch {
        return [];
      }
    })
    .slice(-count);
}

/** K-605: the samples of the last hour; after the daemon was down, older ones are left out. */
export const lastHour = <T extends { readonly at: number }>(
  samples: ReadonlyArray<T>,
  now: number,
): Array<T> => samples.filter((item) => item.at >= now - 60 * 60_000);
