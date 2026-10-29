// K-1131, K-619: what the owner or an agent pasted as a site, and the running servers that a daemon reports.
// Pure, so the map, the daemon and the CLI read the same forms.

/** K-1131: what kitshn understood from a pasted site. */
export type SiteInput =
  | { readonly kind: "port"; readonly port: number; readonly notes: ReadonlyArray<string> }
  | { readonly kind: "socket"; readonly path: string }
  | { readonly kind: "remote"; readonly host: string }
  | { readonly kind: "invalid"; readonly reason: string };

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

const isPort = (port: number) => Number.isInteger(port) && port > 0 && port < 65536;

const isDigits = (text: string) => text.length > 0 && [...text].every((c) => c >= "0" && c <= "9");

/**
 * K-1131: reads `5565`, `:5565`, `localhost:5565`, `http://127.0.0.1:5565/x`, `https://foo.bar/` or a socket path.
 * A local address becomes its port; the path, the query and an https scheme go, and `notes` say so.
 */
export function parseSiteInput(raw: string): SiteInput {
  const text = raw.trim();
  if (text === "")
    return { kind: "invalid", reason: "Type a port, such as 5173, or an address, such as localhost:5173." };
  if (text.startsWith("/"))
    return text.includes("'") || text.includes(" ")
      ? { kind: "invalid", reason: "A socket path cannot have a quote or a space." }
      : { kind: "socket", path: text };
  const bare = text.startsWith(":") ? text.slice(1) : text;
  if (isDigits(bare)) {
    const port = Number(bare);
    return isPort(port)
      ? { kind: "port", port, notes: [] }
      : { kind: "invalid", reason: `${bare} is not a port: a port is 1 to 65535.` };
  }
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `http://${text}`);
  } catch {
    return { kind: "invalid", reason: `kitshn cannot read "${text}" as an address.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { kind: "invalid", reason: `kitshn shares web servers, over http or https, not ${url.protocol}` };
  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !host.endsWith(".localhost")) return { kind: "remote", host };
  const notes: Array<string> = [];
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "")
    notes.push(`Left out ${url.pathname}${url.search}${url.hash}: the site starts at /.`);
  if (url.protocol === "https:") notes.push("kitshn reaches the server over http on its machine.");
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (url.port === "") notes.push(`No port given, so kitshn takes ${port}.`);
  return { kind: "port", port, notes };
}

/** K-619: a TCP port that listens on a machine, with its process and one HTTP check. */
export interface ServerReport {
  readonly port: number;
  /** The process name, or null when the system does not say. */
  readonly process: string | null;
  /** The status of `GET /` on the port, or null when it gave no HTTP answer. */
  readonly status: number | null;
  /** The `<title>` of that answer, at most 80 characters, or null. */
  readonly title: string | null;
}

/**
 * K-619: a daemon sends at most this many servers. kitshn keeps them on the socket attachment, which holds 16 KB
 * with the status and the volumes; 32 entries take at most about 4.5 KB. Revisit if machines run more servers.
 */
export const MAX_SERVERS = 32;

/** K-619: the servers of a daemon message that kitshn keeps: valid entries only, by port, at most MAX_SERVERS. */
export function serversOf(value: unknown): Array<ServerReport> {
  if (!Array.isArray(value)) return [];
  const text = (item: unknown, limit: number) => (typeof item === "string" ? item.slice(0, limit) : null);
  return value
    .flatMap((item): Array<ServerReport> => {
      if (typeof item !== "object" || item === null) return [];
      const entry = item as Record<string, unknown>;
      const port = entry["port"];
      const status = entry["status"];
      if (typeof port !== "number" || !isPort(port)) return [];
      return [
        {
          port,
          process: text(entry["process"], 40),
          status: typeof status === "number" && Number.isInteger(status) ? status : null,
          title: text(entry["title"], 80),
        },
      ];
    })
    .sort((a, b) => a.port - b.port)
    .slice(0, MAX_SERVERS);
}
