import { callerOf } from "./auth.ts";
import type { Env } from "./env.ts";

export { Kitshn } from "./kitshn.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const caller = await callerOf(request, env);
      if (typeof caller === "string") return Response.json({ error: caller }, { status: 401 });
      const headers = new Headers(request.headers);
      headers.set("x-kitshn-caller", JSON.stringify(caller));
      return env.KITSHN.getByName("kitshn").fetch(new Request(request, { headers }));
    }
    if (url.pathname === "/connect" || url.pathname.startsWith("/connect/")) {
      // Daemons connect here in milestone 2 (K-604). Until then it only checks the Access token.
      const caller = await callerOf(request, env);
      if (typeof caller === "string") return Response.json({ error: caller }, { status: 401 });
      return Response.json(
        { error: "Machines join kitshn in milestone 2. No daemon can connect yet.", caller: caller.actor },
        { status: 501 },
      );
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
