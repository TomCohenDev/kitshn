// Screenshots and clips of the UI for pull requests, from one scenario file:
//
//   pnpm --filter @kitshn/edge capture scripts/captures/pause.ts [--out <dir>]
//
// For each view and colour scheme the scenario names, it starts `vite dev` on fresh local state (never yours,
// see KITSHN_DEV_STATE in vite.config.ts), runs the scenario in Chromium, and stops the server. A scenario
// with `clip` also records a video with the page's Web Audio and writes an MP4 (needs ffmpeg). Files land in
// --out, by default ~/.cache/kitshn-captures/<scenario>, as `<view>-<name>-<scheme>.png` and `<view>-<scheme>.mp4`.
// Chromium comes once with `pnpm --filter @kitshn/edge exec playwright install chromium`.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type BrowserContext, type CDPSession, chromium, devices } from "playwright";
import type { Helpers, Scenario, Scheme, View } from "./capture-views.ts";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
if (!file) throw new Error("Name a scenario file, for example scripts/captures/pause.ts.");
const outFlag = args.indexOf("--out");
const name = basename(file).replace(/\.[^.]+$/, "");
const out = resolve(
  outFlag === -1 ? join(homedir(), ".cache", "kitshn-captures", name) : (args[outFlag + 1] ?? ""),
);
mkdirSync(out, { recursive: true });
const scenario = ((await import(pathToFileURL(resolve(file)).href)) as { default: Scenario }).default;

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

/** `vite dev` in its own process group on a fresh state folder; the returned stop ends the whole group. */
async function devServer() {
  const port = await freePort();
  const state = mkdtempSync(join(tmpdir(), "kitshn-capture-"));
  const child = spawn("npx", ["--no", "vite", "dev", "--port", String(port), "--strictPort"], {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, KITSHN_DEV_STATE: state },
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("vite dev did not start.");
  const stop = () => {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // The group ended already.
    }
    rmSync(state, { recursive: true, force: true });
  };
  for (let tries = 0; tries < 120; tries++) {
    const up = await fetch(`http://localhost:${port}/`).then(
      (answer) => answer.ok,
      () => false,
    );
    if (up) return { url: `http://localhost:${port}/`, stop };
    await new Promise((done) => setTimeout(done, 500));
  }
  stop();
  throw new Error("vite dev did not answer within a minute.");
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
          return (await fetch(path, init)).json();
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
  await page.goto(url);
  await page.waitForLoadState("networkidle");
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
  if (result.status !== 0) throw new Error("ffmpeg failed; is it installed?");
  rmSync(raw, { force: true });
  if (audio) rmSync(join(out, `${view.name}-${scheme}.webm`), { force: true });
}

for (const view of scenario.views) {
  for (const scheme of scenario.schemes ?? ["light", "dark"]) {
    const server = await devServer();
    try {
      await runOnce(view, scheme, server.url);
    } finally {
      server.stop();
    }
    console.log(`${view.name} ${scheme}: done`);
  }
}
console.log(`Captures in ${out}`);
