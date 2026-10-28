// The types and views of a capture scenario (scripts/capture.ts). Scenarios import this file, not capture.ts,
// because capture.ts imports the scenario.
import type { Page } from "playwright";

export interface View {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** A phone: touch events, a mobile layout viewport and the device pixel ratio of an iPhone. */
  readonly touch?: boolean;
}

export type Scheme = "light" | "dark";

export interface Helpers {
  readonly page: Page;
  readonly view: View;
  readonly scheme: Scheme;
  /** Saves `<view>-<name>-<scheme>.png`. */
  readonly shot: (name: string) => Promise<void>;
  /** Calls the local admin API as the owner (DEV_IDENTITY) and returns its JSON. */
  readonly api: (path: string, body?: unknown) => Promise<unknown>;
  /** Touch points through the DevTools protocol, for gestures that Playwright has no call for. */
  readonly touch: (
    type: "touchStart" | "touchMove" | "touchEnd",
    points: ReadonlyArray<readonly [number, number]>,
  ) => Promise<void>;
  /** Two fingers that spread from `from` px to `to` px apart around `at`; a negative spread pinches in. */
  readonly pinch: (at: { readonly x: number; readonly y: number }, from: number, to: number) => Promise<void>;
  /** Marks the moment that a clip starts from; the MP4 begins this long before it. */
  readonly mark: () => void;
}

export interface Scenario {
  readonly views: ReadonlyArray<View>;
  readonly schemes?: ReadonlyArray<Scheme>;
  /** Record a clip with sound; the MP4 starts `lead` seconds before `mark()` and lasts `length` seconds. */
  readonly clip?: { readonly lead: number; readonly length: number };
  readonly run: (helpers: Helpers) => Promise<void>;
}

export const DESKTOP: View = { name: "desktop", width: 1512, height: 982 };
export const PHONE: View = { name: "390", width: 390, height: 844, touch: true };
export const SMALL_PHONE: View = { name: "360", width: 360, height: 780, touch: true };
