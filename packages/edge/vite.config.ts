import { cloudflare } from "@cloudflare/vite-plugin";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// KITSHN_DEV_STATE moves the local Worker state, so `pnpm capture` runs on fresh state and never touches yours.
const state = process.env["KITSHN_DEV_STATE"];

export default defineConfig({
  plugins: [preact(), cloudflare({ persistState: state ? { path: state } : true })],
});
