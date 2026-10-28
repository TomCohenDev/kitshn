// K-701, K-702: the daemon's local Unix socket, and the client that the `kitshn` commands use.
import { type Answer, type Request, MAX_LINE_LENGTH, line, readAnswer, readRequest } from "@kitshn/local";
import { type Stats, chmodSync, existsSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { type PeerDecision, peerUid, requestAllowed } from "./peer.ts";
import type { Platform } from "./service.ts";

/** The local user that sent a request. Each request records it (K-701). */
export interface Caller {
  readonly uid: number;
}

interface Connection {
  readonly uid: number;
  readonly decoder: TextDecoder;
  buffer: string;
}

export interface LocalOptions {
  readonly platform: Platform;
  /** Called for each connection with the peer user id. A peer whose user id the kernel does not give never passes. */
  readonly decide: (peer: number) => PeerDecision;
  /** Answers with the id of the request. */
  readonly handle: (request: Request, caller: Caller) => Promise<Answer>;
  readonly log: (text: string) => void;
  /**
   * K-701: "private" is a folder of 0700 and a socket of 0600. "shared" is a folder of 0711 and a socket of 0666, for
   * the users in `localUsers`; the peer check is then the only guard.
   */
  readonly access: "private" | "shared";
}

/**
 * K-701: why a shared socket folder is not safe to use, or null. Another user may make the folder in /tmp first, so
 * it must be a real folder of the daemon user, not a link.
 */
export function sharedFolderProblem(
  folder: Pick<Stats, "isDirectory" | "isSymbolicLink" | "uid">,
  parent: Pick<Stats, "uid" | "mode">,
  own: number,
): string | null {
  // Only the sticky bit stops another user from renaming or removing the daemon's folder in /tmp.
  if (parent.uid !== 0 || (parent.mode & 0o1000) === 0) return "its parent folder is not root's with the sticky bit";
  if (folder.isSymbolicLink()) return "it is a link";
  if (!folder.isDirectory()) return "it is not a folder";
  if (folder.uid !== own) return `it belongs to the user id ${folder.uid}, not to the daemon user ${own}`;
  return null;
}

/**
 * K-701: removes a socket file that an earlier daemon left, listens, and sets the modes of `options.access`. It
 * throws when a daemon still listens there, or when a shared folder is not the daemon user's own. `stop` removes the
 * socket file, unless another daemon made a new one meanwhile.
 */
export async function listenLocal(path: string, options: LocalOptions): Promise<{ readonly stop: () => void }> {
  const folder = dirname(path);
  if (options.access === "private") {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    chmodSync(folder, 0o700);
  } else {
    try {
      mkdirSync(folder, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
    }
    const problem = sharedFolderProblem(lstatSync(folder), statSync(dirname(folder)), process.getuid!());
    if (problem) throw new Error(`the shared socket folder ${folder} is not safe: ${problem}.`);
    chmodSync(folder, 0o711);
  }
  // Known limit: a daemon that starts between this check and the listen below loses its socket. Two daemons
  // that start in the same moment are a mistake of the service setup.
  const live = await Bun.connect({ unix: path, socket: { data() {} } }).then(
    (socket) => (socket.end(), true),
    (error: unknown) => {
      // Only a missing file or one that no daemon listens on may go; anything else is unknown (K-006).
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") return false;
      throw error;
    },
  );
  if (live) throw new Error(`another kitshn daemon listens on ${path}.`);
  rmSync(path, { force: true });
  const send = (socket: Bun.Socket<Connection | undefined>, answer: Answer) => {
    const text = line(answer);
    // Answers are small, so a short write means a broken connection, not back-pressure.
    if (socket.write(text) < Buffer.byteLength(text)) socket.end();
  };
  const tooLong = (socket: Bun.Socket<Connection | undefined>) => {
    send(socket, { id: null, type: "error", error: `A line is longer than ${MAX_LINE_LENGTH} characters.` });
    socket.end();
  };
  const lastRefusal = new Map<number | null, number>();
  const answer = async (socket: Bun.Socket<Connection | undefined>, uid: number, text: string) => {
    const read = readRequest(text);
    if (!read.ok) return send(socket, read.answer);
    const { request } = read;
    if (!requestAllowed(request.type, uid, process.getuid!())) {
      options.log(`local socket: refused ${request.type} from user id ${uid}`);
      return send(socket, {
        id: request.id,
        type: "error",
        error: `${request.type} is not allowed for the user id ${uid}; only the daemon user and root may send it (K-701).`,
      });
    }
    options.log(`local socket: ${request.type} from user id ${uid}`);
    send(
      socket,
      await Promise.resolve()
        .then(() => options.handle(request, { uid }))
        .catch(
        (error: unknown): Answer => ({
          id: request.id,
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  };
  const server = Bun.listen<Connection | undefined>({
    unix: path,
    socket: {
      open(socket) {
        // Bun has no documented call for the descriptor; a Bun without `fd` makes every peer fail here.
        const peer = peerUid(options.platform, (socket as { fd?: unknown }).fd);
        const refuse = (reason: string) => {
          // One line per user id and minute, so a client in a loop cannot fill the log.
          const now = Date.now();
          if (now - (lastRefusal.get(peer) ?? 0) >= 60_000) {
            lastRefusal.set(peer, now);
            options.log(`local socket: refused a connection: ${reason}`);
          }
          socket.end();
        };
        if (peer === null) return refuse("the peer user id cannot be read (K-006)");
        const decision = options.decide(peer);
        if (!decision.accept) return refuse(decision.reason);
        socket.data = { uid: peer, decoder: new TextDecoder(), buffer: "" };
      },
      data(socket, chunk) {
        const connection = socket.data;
        if (!connection) return;
        connection.buffer += connection.decoder.decode(chunk, { stream: true });
        for (let end = connection.buffer.indexOf("\n"); end >= 0; end = connection.buffer.indexOf("\n")) {
          const text = connection.buffer.slice(0, end);
          connection.buffer = connection.buffer.slice(end + 1);
          if (text.length > MAX_LINE_LENGTH) return tooLong(socket);
          void answer(socket, connection.uid, text);
        }
        if (connection.buffer.length > MAX_LINE_LENGTH) tooLong(socket);
      },
    },
  });
  chmodSync(path, options.access === "private" ? 0o600 : 0o666);
  const inode = statSync(path).ino;
  return {
    stop: () => {
      server.stop(true);
      if (existsSync(path) && statSync(path).ino === inode) rmSync(path, { force: true });
    },
  };
}

export type LocalOutcome =
  | { readonly kind: "answer"; readonly answer: Answer }
  /** No socket file, or one that no daemon listens on. */
  | { readonly kind: "not-running" };

/**
 * K-702: sends one request and waits for the answer with its id. K-701: before it sends, it checks that the peer is
 * the daemon user `daemonUid`, so a user who made a shared socket folder first cannot pose as the daemon.
 */
export function askLocal(
  path: string,
  request: Request,
  timeoutMs: number,
  peer: { readonly platform: Platform; readonly daemonUid: number },
): Promise<LocalOutcome> {
  return new Promise((resolve, reject) => {
    let done = false;
    let buffer = "";
    const decoder = new TextDecoder();
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`the daemon did not answer within ${timeoutMs / 1000} seconds.`))),
      timeoutMs,
    );
    Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          const uid = peerUid(peer.platform, (socket as { fd?: unknown }).fd);
          if (uid !== peer.daemonUid) {
            const who = uid === null ? "a user whose id kitshn cannot read" : `the user id ${uid}`;
            finish(() =>
              reject(new Error(`${path} belongs to ${who}, not to the daemon user ${peer.daemonUid}; kitshn sent nothing (K-701).`)),
            );
            socket.end();
            return;
          }
          socket.write(line(request));
        },
        data(socket, chunk) {
          buffer += decoder.decode(chunk, { stream: true });
          const end = buffer.indexOf("\n");
          if (end < 0) return;
          try {
            const answer = readAnswer(buffer.slice(0, end));
            if (answer.id !== request.id && answer.id !== null)
              throw new Error(`the daemon answered the id ${answer.id}, not ${request.id}.`);
            finish(() => resolve({ kind: "answer", answer }));
          } catch (error) {
            finish(() => reject(error));
          }
          socket.end();
        },
        close: () =>
          finish(() =>
            reject(
              new Error(
                "the daemon closed the connection without an answer. Only the daemon user and its local users can use it (K-701); see the daemon log.",
              ),
            ),
          ),
        error: (_socket, error) => finish(() => reject(error)),
      },
    }).catch((error: unknown) => {
      const code = (error as { code?: unknown }).code;
      finish(() =>
        code === "ENOENT" || code === "ECONNREFUSED" ? resolve({ kind: "not-running" }) : reject(error),
      );
    });
  });
}
