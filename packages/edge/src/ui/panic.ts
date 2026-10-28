/**
 * K-1504: the sounds and one-shot effects of the big red button, from the panic button of the machine map
 * (MM-708). Web Audio makes the sounds, so kitshn ships no audio files. Each effect removes itself.
 */

let audio: AudioContext | undefined;

/**
 * Browsers allow sound only after a gesture, so only a press on this device calls this, before it awaits
 * the server. A pause that another device made never starts the context, so it plays nothing here.
 */
export function unlockAudio(): void {
  if (typeof AudioContext === "undefined") return;
  audio ??= new AudioContext();
  if (audio.state === "suspended") void audio.resume();
}

interface Sweep {
  readonly wave: OscillatorType;
  readonly from: number;
  readonly to: number;
  /** Seconds after now. */
  readonly at: number;
  readonly length: number;
  readonly volume: number;
}

function play(sweeps: ReadonlyArray<Sweep>): void {
  if (!audio) return;
  const now = audio.currentTime;
  for (const sweep of sweeps) {
    const start = now + sweep.at;
    const end = start + sweep.length;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = sweep.wave;
    oscillator.frequency.setValueAtTime(sweep.from, start);
    oscillator.frequency.exponentialRampToValueAtTime(sweep.to, end);
    gain.gain.setValueAtTime(sweep.volume, start);
    gain.gain.exponentialRampToValueAtTime(0.001, end);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(end);
  }
}

/** A heavy thunk, three klaxon whoops, then a slide down as everything powers off. */
const playPanicSound = () =>
  play([
    { wave: "sine", from: 170, to: 45, at: 0, length: 0.3, volume: 0.5 },
    ...[0, 1, 2].map((index) => ({
      wave: "sawtooth" as const,
      from: 380,
      to: 640,
      at: 0.15 + index * 0.38,
      length: 0.34,
      volume: 0.11,
    })),
    { wave: "triangle", from: 640, to: 90, at: 1.3, length: 0.8, volume: 0.2 },
  ]);

/** A short rising chime for Resume. */
export const playResumeSound = () =>
  play(
    [523, 659, 784, 1047].map((note, index) => ({
      wave: "sine" as const,
      from: note,
      to: note,
      at: index * 0.09,
      length: 0.25,
      volume: 0.18,
    })),
  );

/** Adds an element over the page for one animation, and removes it when the animation ends. */
function once(element: HTMLElement, keyframes: Array<Keyframe>, options: KeyframeAnimationOptions): void {
  document.body.append(element);
  element.animate(keyframes, options).finished.then(
    () => element.remove(),
    () => element.remove(),
  );
}

/**
 * A press that the server took: the sound, a red flash over the page, a stamp that slams down, and one shake
 * of the map. With reduced motion, only the sound and the flash.
 */
export function showPanic(stamp: string): void {
  playPanicSound();
  const flash = document.createElement("div");
  flash.className = "panic-flash";
  once(flash, [{ opacity: 0.55 }, { opacity: 0 }], { duration: 700, easing: "ease-out" });
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const layer = document.createElement("div");
  layer.className = "panic-stamp";
  const label = document.createElement("span");
  label.className = "stamp";
  label.textContent = stamp;
  layer.append(label);
  once(
    layer,
    [
      { opacity: 0, transform: "scale(3) rotate(-12deg)" },
      { opacity: 1, transform: "scale(1) rotate(-8deg)", offset: 0.15 },
      { opacity: 1, transform: "scale(1) rotate(-8deg)", offset: 0.75 },
      { opacity: 0, transform: "scale(1.05) rotate(-8deg)" },
    ],
    { duration: 1600, easing: "ease-out" },
  );
  document
    .querySelector(".viewport")
    ?.animate(
      [
        { transform: "translate(0, 0)" },
        { transform: "translate(-10px, 4px)" },
        { transform: "translate(9px, -5px)" },
        { transform: "translate(-6px, 3px)" },
        { transform: "translate(4px, -2px)" },
        { transform: "translate(0, 0)" },
      ],
      { duration: 450, easing: "ease-out" },
    );
}
