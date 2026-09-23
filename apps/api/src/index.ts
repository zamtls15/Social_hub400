import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
config({ path: resolve(root, ".env") });

// Load dotenv before the dynamic import so import-time clients, including
// Inngest, receive the same centralized environment defaults as services.
const { createApp } = await import("./app.js");
const { getConfig } = await import("./lib/config.js");
const app = createApp();
const port = getConfig().port;

console.log(`social-hub api listening on http://127.0.0.1:${port}`);
console.log(`UI → http://127.0.0.1:${port}/`);
console.log(`Batch → http://127.0.0.1:${port}/batch`);
console.log(`Scraps → http://127.0.0.1:${port}/scraps`);
console.log(`API docs → http://127.0.0.1:${port}/docs/api`);

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
