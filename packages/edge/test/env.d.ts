import type { Env as KitshnEnv } from "../src/worker/env.ts";

// `env` of `cloudflare:workers` has the bindings of the Worker.
declare global {
  namespace Cloudflare {
    interface Env extends KitshnEnv {}
  }
}
