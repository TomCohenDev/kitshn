// K-701, K-702: the daemon's local Unix socket, and the client that the `kitshn` commands use.
import { type Answer, type Request, MAX_LINE_LENGTH, line, readAnswer, readRequest } from "@kitshn/local";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { type PeerDecision, peerUid } from "./peer.ts";
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
}

/**
 * K-701: removes a socket file that an earlier daemon left, listens, and sets the folder to 0700 and the socket
 * to 0600. It throws when a daemon still listens there. `stop` removes the socket file, unless another daemon
 * made a new one meanwhile.
 */
export async function listenLocal(path: string, options: LocalOptions): Promise<{ readonly stop: () => void }> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  // Known limit: a daemon that starts between this check and the listen below loses its socket. Two daemons
  // that start in the same moment are a mistake of the service setup.
  const live = await Bun.connect({ unix: path, socket: { data() {} } }).then(
    (socket) => (socket.end(), true),
    () => false,
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
  const answer = async (socket: Bun.Socket<Connection | undefined>, uid: number, text: string) => {
    const read = readRequest(text);
    if (!read.ok) return send(socket, read.answer);
    const { request } = read;
    options.log(`local socket: ${request.type} from user id ${uid}`);
    send(
      socket,
      await Promise.resolve()
        .then(() => options.handle(request, { uid }))
        .catch(
        (error: unknown): Answer => ({ id: request.id, type: "error", error: String(error) }),
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
          options.log(`local socket: refused a connection: ${reason}`);
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
  chmodSync(path, 0o600);
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

/** K-702: sends one request and waits for the answer with its id. */
export function askLocal(path: string, request: Request, timeoutMs: number): Promise<LocalOutcome> {
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
        open: (socket) => void socket.write(line(request)),
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
