import { createApp, type WorkerBindings } from "./app.js";

export default {
  async fetch(
    request: Request,
    env: WorkerBindings,
    _ctx: unknown,
  ): Promise<Response> {
    // The config layer is the only module that reads these values; this copy
    // makes import-time SDKs such as Inngest see Worker secrets at startup.
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") process.env[key] = value;
    }
    env.RUNTIME = "cloudflare";
    env.SC_MODE = env.SC_MODE || "live";
    env.SC_CACHE_WRITE = "0";
    env.INNGEST_DEV = env.INNGEST_DEV || "0";
    const app = createApp(env);
    return app.fetch(request, env);
  },
};
