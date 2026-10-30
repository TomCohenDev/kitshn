// Screenshots and clips of the UI for pull requests, from one scenario file:
//
//   pnpm --filter @kitshn/edge capture packages/edge/scripts/captures/pause.ts [--out <dir>]
//
// Paths are relative to the folder where you run pnpm. The Worker needs DEV_IDENTITY in packages/edge/.dev.vars.
//
// For each view and colour scheme the scenario names, it starts `vite dev` on fresh local state (never yours,
// see KITSHN_DEV_STATE in vite.config.ts), runs the scenario in Chromium, and stops the server. A scenario
// with `clip` also records a video with the page's Web Audio and writes an MP4 (needs ffmpeg). Files land in
// --out, by default ~/.cache/kitshn-captures/<scenario>, as `<view>-<name>-<scheme>.png` and `<view>-<scheme>.mp4`.
// Chromium comes once with `pnpm --filter @kitshn/edge exec playwright install chromium`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { type BrowserContext, type CDPSession, type Page, chromium, devices, errors } from "playwright";
import type { Helpers, Scenario, Scheme, View } from "./capture-views.ts";

const { values, positionals } = parseArgs({
  options: { out: { type: "string" } },
  allowPositionals: true,
  strict: true,
});
const [file, ...extra] = positionals;
if (!file || extra.length > 0)
  throw new Error("Name one scenario file, for example packages/edge/scripts/captures/pause.ts.");
// pnpm runs the script in packages/edge; INIT_CWD is the folder where you typed the command.
const here = process.env["INIT_CWD"] ?? process.cwd();
const name = basename(file, extname(file));
const out = resolve(here, values.out ?? join(homedir(), ".cache", "kitshn-captures", name));
const edge = resolve(import.meta.dirname, "..");
const devVars = join(edge, ".dev.vars");
const identity =
  existsSync(devVars) &&
  readFileSync(devVars, "utf8")
    .split("\n")
    .some((line) => line.startsWith("DEV_IDENTITY=") && line.slice("DEV_IDENTITY=".length).trim() !== "");
if (!identity)
  throw new Error(`Set DEV_IDENTITY=<your email> in ${devVars}; the local Worker answers no one without it.`);
const scenario = ((await import(pathToFileURL(resolve(here, file)).href)) as { default: Scenario }).default;
if (scenario.clip && spawnSync("ffmpeg", ["-version"]).status !== 0)
  throw new Error("This scenario records a clip, which needs ffmpeg on the path.");
mkdirSync(out, { recursive: true });

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? done(address.port) : fail(new Error("no port")),
      );
    });
  });

/** The dev servers that run now, so Ctrl-C, a kill or a crash still stops them and deletes their state. */
const running = new Set<{ readonly pid: number; readonly state: string }>();
const killGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group ended already.
  }
};
process.on("exit", () => {
  for (const server of running) {
    killGroup(server.pid, "SIGKILL");
    rmSync(server.state, { recursive: true, force: true });
  }
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => process.exit(signal === "SIGINT" ? 130 : 143));

/** `vite dev` in its own process group on a fresh state folder; `stop` ends the whole group, then deletes it. */
async function devServer() {
  const port = await freePort();
  const state = mkdtempSync(join(tmpdir(), "kitshn-capture-"));
  // `--force`: a stopped server can leave Vite's shared dependency cache half written, and the next server's
  // requests for those files then never answer.
  const child = spawn("npx", ["--no", "vite", "dev", "--force", "--port", String(port), "--strictPort"], {
    cwd: edge,
    env: { ...process.env, KITSHN_DEV_STATE: state },
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("vite dev did not start.");
  const server = { pid, state };
  running.add(server);
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-2000);
  });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const stop = async () => {
    killGroup(pid, "SIGTERM");
    // workerd writes its state until it exits, so the folder goes only after the group did.
    const late = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((done) => setTimeout(() => done(true), 5000)),
    ]);
    if (late) killGroup(pid, "SIGKILL");
    rmSync(state, { recursive: true, force: true });
    running.delete(server);
  };
  for (let tries = 0; tries < 120; tries++) {
    if (gone) {
      await stop();
      throw new Error(`vite dev exited before it answered:\n${errors}`);
    }
    const up = await fetch(`http://localhost:${port}/`).then(
      (answer) => answer.ok,
      () => false,
    );
    if (up) return { url: `http://localhost:${port}/`, stop };
    await new Promise((done) => setTimeout(done, 500));
  }
  await stop();
  throw new Error(`vite dev did not answer within a minute:\n${errors}`);
}

/** Copies every sound of the page into a recorder, so a clip has the audio that the speakers would play. */
const AUDIO_TAP = `(() => {
  const connect = AudioNode.prototype.connect;
  const taps = new WeakMap();
  AudioNode.prototype.connect = function (target, ...rest) {
    if (target instanceof AudioDestinationNode && !taps.has(target.context)) {
      const tap = target.context.createMediaStreamDestination();
      taps.set(target.context, tap);
      const recorder = new MediaRecorder(tap.stream, { mimeType: "audio/webm" });
      const parts = [];
      recorder.ondataavailable = (event) => parts.push(event.data);
      recorder.start();
      window.__kitshnAudio = { start: performance.timeOrigin + performance.now(), stop: () => new Promise((done) => {
        recorder.onstop = async () => {
          const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
          let text = "";
          for (const byte of bytes) text += String.fromCharCode(byte);
          done(btoa(text));
        };
        recorder.stop();
      }) };
    }
    if (taps.has(target.context) && target instanceof AudioDestinationNode) connect.call(this, taps.get(target.context), ...rest);
    return connect.call(this, target, ...rest);
  };
})();`;

async function runOnce(view: View, scheme: Scheme, url: string) {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const context: BrowserContext = await browser.newContext({
    ...(view.touch ? devices["iPhone 13"] : {}),
    viewport: { width: view.width, height: view.height },
    colorScheme: scheme,
    ...(scenario.clip ? { recordVideo: { dir: out, size: { width: view.width, height: view.height } } } : {}),
  });
  if (scenario.clip) await context.addInitScript(AUDIO_TAP);
  const page = await context.newPage();
  const cdp: CDPSession = await context.newCDPSession(page);
  const begun = Date.now();
  let marked: number | null = null;
  const touch: Helpers["touch"] = async (type, points) => {
    await cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    });
  };
  const helpers: Helpers = {
    page,
    view,
    scheme,
    shot: async (shotName) => {
      await page.screenshot({ path: join(out, `${view.name}-${shotName}-${scheme}.png`) });
    },
    api: (path, body) =>
      page.evaluate(
        async ([path, body]) => {
          const init =
            body === undefined
              ? {}
              : {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(body),
                };
          const answer = await fetch(path, init);
          if (!answer.ok) throw new Error(`${path} answered ${answer.status}: ${await answer.text()}`);
          return answer.json();
        },
        [path, body] as const,
      ),
    touch,
    pinch: async (at, from, to) => {
      await touch("touchStart", [
        [at.x - from / 2, at.y],
        [at.x + from / 2, at.y],
      ]);
      for (let step = 1; step <= 10; step++) {
        const spread = from + ((to - from) * step) / 10;
        await touch("touchMove", [
          [at.x - spread / 2, at.y],
          [at.x + spread / 2, at.y],
        ]);
      }
      await touch("touchEnd", []);
    },
    mark: () => {
      marked = Date.now();
    },
  };
  page.on("pageerror", (error) => console.warn(`Page error: ${String(error).slice(0, 300)}`));
  await firstLoad(page, url);
  await scenario.run(helpers);
  const audio = scenario.clip
    ? ((await page.evaluate(async () => {
        const tap = (
          globalThis as unknown as { __kitshnAudio?: { start: number; stop: () => Promise<string> } }
        ).__kitshnAudio;
        return tap ? { start: tap.start, data: await tap.stop() } : null;
      })) as { start: number; data: string } | null)
    : null;
  const video = page.video();
  await context.close();
  await browser.close();
  if (!scenario.clip || !video) return;
  const raw = await video.path();
  const mp4 = join(out, `${view.name}-${scheme}.mp4`);
  const from = Math.max(0, ((marked ?? begun) - begun) / 1000 - scenario.clip.lead);
  const input = ["-i", raw];
  const map = ["-map", "0:v"];
  if (audio) {
    const sound = join(out, `${view.name}-${scheme}.webm`);
    writeFileSync(sound, Buffer.from(audio.data, "base64"));
    input.push("-itsoffset", String((audio.start - begun) / 1000), "-i", sound);
    map.push("-map", "1:a", "-c:a", "aac", "-b:a", "128k");
  }
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...input,
      ...map,
      "-ss",
      String(from),
      "-t",
      String(scenario.clip.length),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "24",
      "-preset",
      "veryfast",
      "-movflags",
      "+faststart",
      mp4,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("ffmpeg failed.");
  rmSync(raw, { force: true });
  if (audio) rmSync(join(out, `${view.name}-${scheme}.webm`), { force: true });
}

/**
 * The first load of a fresh `vite dev` compiles every module, and a busy machine takes longer than the 30 s of a
 * Playwright call, so only that load gets longer and more tries; a timeout in a scenario still fails at once.
 */
async function firstLoad(page: Page, url: string) {
  const open = new Set<string>();
  const done = (request: { url(): string }) => open.delete(request.url());
  page.on("request", (request) => open.add(request.url()));
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  for (let tries = 3; ; tries--) {
    try {
      await page.goto(url, { timeout: 120_000 });
      await page.waitForLoadState("networkidle", { timeout: 120_000 });
      return;
    } catch (error) {
      if (tries === 1 || !(error instanceof errors.TimeoutError)) throw error;
      console.warn(
        `The first load timed out on ${[...open].slice(0, 3).join(", ")}; ${tries - 1} more tries.`,
      );
    }
  }
}

for (const view of scenario.views) {
  for (const scheme of scenario.schemes ?? ["light", "dark"]) {
    const server = await devServer();
    try {
      await runOnce(view, scheme, server.url);
    } finally {
      await server.stop();
    }
    console.log(`${view.name} ${scheme}: done`);
  }
}
console.log(`Captures in ${out}`);
