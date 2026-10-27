// K-1008: the one-time import of the HTML pages of T3 Code threads into the kitshn library. Each page
// lands private, in the tray. It runs in two steps, so the T3 database is only read where it lives:
//
//   node scripts/import-pages.ts read <statev2.sqlite copy> <attachments dir> > pages.json
//   CF_ACCESS_CLIENT_ID=... CF_ACCESS_CLIENT_SECRET=... \
//     node scripts/import-pages.ts upload <kitshn host> <machine name> pages.json <attachments dir>
//
// `read` opens the database read only. `upload` sends each page with a source key, so a second run adds
// nothing twice. The service token must be a device in a circle with control on the kitshn admin.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

interface PageEntry {
  readonly file: string;
  readonly title: string;
  readonly thread: string | null;
  readonly createdAt: number;
}

const PAGE_ENDING = "-html.html";

interface Render {
  readonly title: string;
  readonly threadId: string;
}

/**
 * Each `html_render` tool result names its attachment and its title. The file name encodes the thread id
 * in a lossy way, so the thread comes from the row of the tool result, not from the file name.
 */
function renders(database: DatabaseSync): Map<string, Render> {
  const found = new Map<string, Render>();
  const rows = database
    .prepare(
      "SELECT thread_id, payload_json FROM orchestration_v2_projection_turn_items WHERE payload_json LIKE '%htmlRender%'",
    )
    .all() as Array<{ thread_id: string; payload_json: string }>;
  for (const row of rows) {
    try {
      // Claude puts the tool result in `output.content`, Codex in `output` itself.
      const output = (JSON.parse(row.payload_json) as { output?: unknown }).output;
      const content =
        typeof output === "string" ? output : (output as { content?: unknown } | undefined)?.content;
      if (typeof content !== "string") continue;
      const render = (JSON.parse(content) as { htmlRender?: { attachmentId?: unknown; title?: unknown } })
        .htmlRender;
      if (typeof render?.attachmentId === "string" && typeof render.title === "string")
        found.set(render.attachmentId, { title: render.title, threadId: row.thread_id });
    } catch {
      // A tool result that is not JSON is not a render result.
    }
  }
  return found;
}

function read(databasePath: string, directory: string): Array<PageEntry> {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const threadTitle = database.prepare(
    "SELECT title FROM orchestration_v2_projection_threads WHERE thread_id = ?",
  );
  const known = renders(database);
  const entries = readdirSync(directory)
    .filter((file) => file.endsWith(PAGE_ENDING))
    .sort()
    .map((file): PageEntry => {
      const render = known.get(file.slice(0, -".html".length));
      const thread = render
        ? ((threadTitle.get(render.threadId) as { title?: string } | undefined)?.title ?? null)
        : null;
      return {
        file,
        title: render?.title ?? thread ?? file,
        thread,
        createdAt: Math.round(statSync(join(directory, file)).mtimeMs),
      };
    });
  database.close();
  return entries;
}

async function upload(host: string, machine: string, manifestPath: string, directory: string) {
  const id = process.env["CF_ACCESS_CLIENT_ID"];
  const secret = process.env["CF_ACCESS_CLIENT_SECRET"];
  if (!id || !secret) throw new Error("Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.");
  const entries = JSON.parse(readFileSync(manifestPath, "utf8")) as Array<PageEntry>;
  for (const entry of entries) {
    const response = await fetch(`https://${host}/api/pages`, {
      method: "POST",
      headers: {
        "cf-access-client-id": id,
        "cf-access-client-secret": secret,
        "content-type": "text/html",
        "x-kitshn-name": encodeURIComponent(entry.title),
        "x-kitshn-machine": encodeURIComponent(machine),
        "x-kitshn-created-at": String(entry.createdAt),
        "x-kitshn-source": encodeURIComponent(`${machine}:${entry.file}`),
        ...(entry.thread ? { "x-kitshn-thread": encodeURIComponent(entry.thread) } : {}),
      },
      body: readFileSync(join(directory, entry.file)),
    });
    const result = (await response.json().catch(() => null)) as {
      id?: string;
      existing?: boolean;
      error?: string;
    } | null;
    if (!response.ok || !result?.id) {
      throw new Error(`${entry.file}: kitshn answered ${response.status}: ${result?.error ?? "no JSON"}`);
    }
    console.log(`${result.existing ? "kept" : "added"} ${result.id} ${entry.title}`);
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "read" && args.length === 2) {
  console.log(JSON.stringify(read(args[0]!, args[1]!), null, 2));
} else if (command === "upload" && args.length === 4) {
  await upload(args[0]!, args[1]!, args[2]!, args[3]!);
} else {
  console.error("Usage: import-pages.ts read <db> <dir> | upload <host> <machine> <pages.json> <dir>");
  process.exit(2);
}
