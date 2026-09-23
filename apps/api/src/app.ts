import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { Hono } from "hono";
import { serve as serveInngest } from "inngest/hono";
import { inngest } from "./inngest/client.js";
import { functions } from "./inngest/functions.js";
import { saveMediaCdnToR2 } from "./lib/save-media.js";
import { scrapePostPipeline } from "./lib/scrape-post.js";
import { listScraps } from "./lib/scraps.js";
import { listRecentPosts } from "./lib/recent-posts.js";
import { getCreditBalance, getCreditUsage } from "./lib/scrapecreators.js";
import {
  listUsageEvents,
  recordScrapeCreatorsCreditSnapshot,
  summarizeUsageEvents,
  usageTrackingConfigured,
} from "./lib/usage.js";
import {
  initializeConfig,
  listConfigSettings,
  removeConfigSetting,
  saveConfigSetting,
  type WorkerConfigEnv,
} from "./lib/config.js";

type Fetcher = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };

export type WorkerBindings = WorkerConfigEnv & {
  ASSETS?: Fetcher;
  [key: string]: unknown;
};

export type AppEnv = { Bindings: WorkerBindings };

function getPublicDir(runtime: string): string | null {
  if (runtime === "cloudflare") return null;
  try {
    return resolve(fileURLToPath(new URL(".", import.meta.url)), "../public");
  } catch {
    return null;
  }
}

export function createApp(env?: WorkerBindings) {
  const app = new Hono<AppEnv>();
  const publicDir = getPublicDir(env?.RUNTIME === "cloudflare" ? "cloudflare" : "node");

  void initializeConfig(env);

app.get("/health", async (c) => {
  const runtime = await initializeConfig(c.env);
  return c.json({
    ok: true,
    service: "social-hub-api",
    inngestDev: runtime.inngestDev,
    hasEventKey: Boolean(runtime.inngestEventKey),
    hasSigningKey: Boolean(runtime.inngestSigningKey),
    hasAirtable: Boolean(runtime.airtableToken || runtime.airtableApiKey),
    hasR2: Boolean(runtime.r2AccountId && runtime.r2AccessKeyId && runtime.r2SecretAccessKey),
    hasScrapeCreators: Boolean(runtime.scrapeCreatorsApiKey),
  });
});

// SECURITY: These routes intentionally have no auth in the test environment.
// Add authentication and authorization before deploying a real settings endpoint.
app.get("/api/settings", async (c) => {
  try {
    return c.json({ ok: true, store: c.env.SETTINGS_DB ? "d1" : "sqlite", settings: await listConfigSettings(c.env) });
  } catch (error) {
    console.error("[api/settings] read failed", error);
    return c.json({ ok: false, error: "Couldn't load settings right now — try again in a moment." }, 503);
  }
});

app.put("/api/settings/:key", async (c) => {
  try {
    const key = c.req.param("key");
    const body = (await c.req.json()) as { value?: unknown };
    const result = await saveConfigSetting(c.env, key, body.value);
    return c.json({ ok: true, message: result.restarted ? "This setting is live now." : "This setting was saved and will apply after the app restarts.", setting: result.setting });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The setting could not be saved.";
    console.error("[api/settings] write failed", error);
    if (/Unknown setting|must be|required|valid URL|Yes or No|from 0 to|contain only/.test(message)) return c.json({ ok: false, error: message }, 400);
    return c.json({ ok: false, error: "Couldn't save this right now — try again in a moment." }, 503);
  }
});

app.delete("/api/settings/:key", async (c) => {
  try {
    const result = await removeConfigSetting(c.env, c.req.param("key"));
    return c.json({ ok: true, message: result.restarted ? "The override was removed and the environment default is live now." : "The override was removed and will take effect after the app restarts.", setting: result.setting });
  } catch (error) {
    console.error("[api/settings] delete failed", error);
    return c.json({ ok: false, error: "Couldn't save this right now — try again in a moment." }, 503);
  }
});

app.on(
  ["GET", "PUT", "POST"],
  "/api/inngest",
  serveInngest({ client: inngest, functions }),
);

app.post("/demo/hello", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({} as { who?: string }));
    const ids = await inngest.send({
      name: "social/hello",
      data: { who: body.who ?? "WSL", at: new Date().toISOString() },
    });
    return c.json({ ok: true, ids });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[demo/hello]", message);
    return c.json({ ok: false, error: message }, 500);
  }
});

type SaveMediaBody = {
  mediaRecordId?: string;
  postRecordId?: string;
  fileUrl?: string;
  objectKey?: string;
  mediaType?: string;
  force?: boolean;
};

/** Async queue (needs Inngest Dev or Cloud). */
app.post("/api/media/save", async (c) => {
  try {
    const body = (await c.req.json()) as SaveMediaBody;
    if (!body?.mediaRecordId) {
      return c.json({ ok: false, error: "mediaRecordId required" }, 400);
    }
    const ids = await inngest.send({
      name: "media/cdn.ready",
      data: {
        mediaRecordId: body.mediaRecordId,
        postRecordId: body.postRecordId,
        fileUrl: body.fileUrl,
        objectKey: body.objectKey,
        mediaType: body.mediaType,
        force: Boolean(body.force),
      },
    });
    return c.json({
      ok: true,
      mode: "async",
      event: "media/cdn.ready",
      ids,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/media/save]", message);
    return c.json({ ok: false, error: message }, 500);
  }
});

/**
 * Standalone sync — no Inngest required.
 * Runs download → R2 → Airtable in this request.
 */
app.post("/api/media/save-sync", async (c) => {
  try {
    const body = (await c.req.json()) as SaveMediaBody;
    if (!body?.mediaRecordId) {
      return c.json({ ok: false, error: "mediaRecordId required" }, 400);
    }
    const result = await saveMediaCdnToR2({
      mediaRecordId: body.mediaRecordId,
      postRecordId: body.postRecordId,
      fileUrl: body.fileUrl,
      objectKey: body.objectKey,
      mediaType: body.mediaType,
      force: Boolean(body.force),
    });
    return c.json({ ok: true, mode: "sync", result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/media/save-sync]", message);
    return c.json({ ok: false, error: message }, 500);
  }
});

/**
 * Paste a post URL → ScrapeCreators → Airtable → optional R2.
 */
app.post("/api/scrape-post", async (c) => {
  try {
    const body = (await c.req.json()) as {
      url?: string;
      saveToR2?: boolean;
      saveMode?: "sync" | "async";
      force?: boolean;
    };
    if (!body?.url) {
      return c.json({ ok: false, error: "url required" }, 400);
    }
    const result = await scrapePostPipeline({
      url: body.url,
      saveToR2: body.saveToR2,
      saveMode: body.saveMode,
      force: body.force,
    });
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/scrape-post]", message);
    return c.json({ ok: false, error: message }, 500);
  }
});

/** ScrapeCreators credit balance + recent charge history. */
app.get("/api/credits", async (c) => {
  try {
    const remaining = await getCreditBalance();
    recordScrapeCreatorsCreditSnapshot(remaining);
    return c.json({ ok: true, remaining });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/credits]", message);
    // Soft-fail so the admin UI still loads when SC_MODE=offline / no cache.
    return c.json({ ok: true, remaining: null, warning: message });
  }
});

app.get("/api/credits/history", async (c) => {
  try {
    const page = Number(c.req.query("page") || "1") || 1;
    let remaining: number | null = null;
    let warning: string | undefined;
    try {
      remaining = await getCreditBalance();
      if (remaining != null) recordScrapeCreatorsCreditSnapshot(remaining);
    } catch (err) {
      warning = err instanceof Error ? err.message : String(err);
      console.error("[api/credits/history] balance", warning);
    }
    const history = await getCreditUsage(page);
    return c.json({ ok: true, remaining, page, history, warning });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/credits/history]", message);
    return c.json({ ok: false, error: message }, 500);
  }
});

/**
 * Local usage ledger (Airtable usage_events) + live ScrapeCreators balance.
 * Returns simple given / used / remaining per service — no invented quotas.
 */
app.get("/api/usage", async (c) => {
  try {
    const configured = usageTrackingConfigured();
    let events: Awaited<ReturnType<typeof listUsageEvents>> = [];
    let warning: string | undefined;
    if (configured) {
      try {
        events = await listUsageEvents(100);
      } catch (err) {
        warning = err instanceof Error ? err.message : String(err);
        console.error("[api/usage] list", warning);
      }
    }

    const summary = summarizeUsageEvents(events);

    let creditsRemaining: number | null = null;
    let creditsUsed: number | null = null;
    let creditsWarning: string | undefined;
    try {
      creditsRemaining = await getCreditBalance();
      if (creditsRemaining != null) {
        recordScrapeCreatorsCreditSnapshot(creditsRemaining);
      }
    } catch (err) {
      creditsWarning = err instanceof Error ? err.message : String(err);
    }
    try {
      const history = await getCreditUsage(1);
      creditsUsed = history.reduce(
        (sum, row) => sum + (Number.isFinite(row.credits) ? row.credits : 0),
        0,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      creditsWarning = creditsWarning ? `${creditsWarning}; ${msg}` : msg;
    }

    // given = remaining + used only when both come from ScrapeCreators APIs
    const creditsGiven =
      creditsRemaining != null && creditsUsed != null
        ? creditsRemaining + creditsUsed
        : null;

    const services = [
      {
        service: "ScrapeCreators",
        unit: "credits" as const,
        given: creditsGiven,
        used: creditsUsed,
        remaining: creditsRemaining,
        source: "scrapecreators",
      },
      {
        service: "Airtable",
        unit: "requests" as const,
        // No vendor quota in-app — only our recorded request count.
        given: null,
        used: summary.airtableRequests,
        remaining: null,
        source: "usage_events",
      },
      {
        service: "R2",
        unit: "bytes" as const,
        // No bucket quota in-app — only recorded upload bytes.
        given: null,
        used: summary.r2UploadBytes,
        remaining: null,
        source: "usage_events",
      },
    ];

    return c.json({
      ok: true,
      configured,
      warning,
      creditsWarning,
      services,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/usage]", message);
    return c.json({ ok: false, error: message }, 500);
  }
});

/** List recent posts for a handle — fetch only, no R2 / Airtable. */
app.get("/api/recent-posts", async (c) => {
  try {
    const platform = (c.req.query("platform") || "").toLowerCase();
    const handle = c.req.query("handle") || "";
    const limit = Number(c.req.query("limit") || "24") || 24;
    const cursor = c.req.query("cursor") || undefined;
    const filter = c.req.query("filter") || "media";
    if (!["x", "instagram", "tiktok"].includes(platform)) {
      return c.json(
        { ok: false, error: "platform must be x, instagram, or tiktok" },
        400,
      );
    }
    if (!handle.trim()) {
      return c.json({ ok: false, error: "handle required" }, 400);
    }
    const result = await listRecentPosts({
      platform: platform as "x" | "instagram" | "tiktok",
      handle,
      limit,
      cursor,
      filter,
    });
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/recent-posts]", message);
    return c.json({ ok: false, error: message }, 500);
  }
});

/** Proxy CDN thumbnails so browser privacy blockers don't blank the feed. */
/** TikTok often serves .heic covers — browsers can't paint those in <img>. */
function thumbCandidateUrls(raw: string): string[] {
  const out: string[] = [];
  const push = (u: string) => {
    if (u && !out.includes(u)) out.push(u);
  };
  push(raw);
  const lower = raw.toLowerCase();
  if (lower.includes(".heic")) {
    push(raw.replace(/\.heic\b/gi, ".jpeg"));
    push(raw.replace(/\.heic\b/gi, ".jpg"));
    push(raw.replace(/\.heic\b/gi, ".webp"));
    push(raw.replace(/:q\d+\.heic\b/gi, ":q70.jpeg"));
    push(raw.replace(/~tplv-[^/?#]+/gi, (m) => m.replace(/\.heic\b/gi, ".jpeg")));
  }
  return out;
}

function isAllowedThumbHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "pbs.twimg.com" ||
    h === "video.twimg.com" ||
    h.endsWith(".twimg.com") ||
    h.endsWith(".cdninstagram.com") ||
    h.endsWith(".instagram.com") ||
    h.includes("tiktokcdn") ||
    h.includes("tiktokv.") ||
    h.includes("byteoversea") ||
    h.includes("ibyteimg") ||
    h.includes("muscdn") ||
    h.includes("tiktok.com")
  );
}

app.get("/api/thumb", async (c) => {
  try {
    const rawUrl = c.req.query("url") || "";
    if (!rawUrl) return c.text("url required", 400);
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return c.text("invalid url", 400);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return c.text("invalid protocol", 400);
    }
    if (!isAllowedThumbHost(parsed.hostname)) {
      return c.text("host not allowed", 403);
    }

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: "https://www.tiktok.com/",
    };

    let lastStatus = 0;
    for (const candidate of thumbCandidateUrls(parsed.toString())) {
      let candUrl: URL;
      try {
        candUrl = new URL(candidate);
      } catch {
        continue;
      }
      if (!isAllowedThumbHost(candUrl.hostname)) continue;

      const upstream = await fetch(candUrl.toString(), { headers });
      lastStatus = upstream.status;
      if (!upstream.ok) continue;

      let contentType =
        upstream.headers.get("content-type") || "image/jpeg";
      // Skip HEIC/HEIF — Chrome/Firefox <img> can't decode them
      if (/heic|heif/i.test(contentType) || /\.heic(\?|$)/i.test(candUrl.pathname)) {
        continue;
      }
      if (!contentType.startsWith("image/")) continue;

      const buf = await upstream.arrayBuffer();
      if (!buf.byteLength) continue;
      c.header("Content-Type", contentType);
      c.header("Cache-Control", "public, max-age=86400");
      return c.body(buf);
    }

    return c.text(`no browser-safe thumb (last ${lastStatus || "n/a"})`, 502);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/thumb]", message);
    return c.text("thumb failed", 500);
  }
});

/** Saved Scraps library — Posts + Media from Airtable. */
const scrapsInflight = new Map<
  string,
  Promise<Awaited<ReturnType<typeof listScraps>>>
>();

app.get("/api/scraps", async (c) => {
  try {
    const type = c.req.query("type") || "all";
    const user = c.req.query("user") || "";
    const q = c.req.query("q") || "";
    const key = `${type}\0${user}\0${q}`;
    let pending = scrapsInflight.get(key);
    if (!pending) {
      pending = listScraps({ type, user, q }).finally(() => {
        scrapsInflight.delete(key);
      });
      scrapsInflight.set(key, pending);
    }
    const result = await pending;
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/scraps]", message);
    return c.json({ ok: false, error: message }, 500);
  }
});

/** @deprecated use /api/media/save */
app.post("/demo/save-media", async (c) => {
  try {
    const body = (await c.req.json()) as SaveMediaBody;
    if (!body?.mediaRecordId) {
      return c.json({ ok: false, error: "mediaRecordId required" }, 400);
    }
    const ids = await inngest.send({
      name: "media/cdn.ready",
      data: {
        mediaRecordId: body.mediaRecordId,
        postRecordId: body.postRecordId,
        fileUrl: body.fileUrl,
        objectKey: body.objectKey,
        mediaType: body.mediaType,
        force: Boolean(body.force),
      },
    });
    return c.json({ ok: true, ids, event: "media/cdn.ready" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[demo/save-media]", message);
    return c.json({ ok: false, error: message }, 500);
  }
});

async function sendPublic(
  c: { env: WorkerBindings; header: (k: string, v: string) => void; req: { url: string } },
  name: string,
  type: string,
): Promise<string | Response | null> {
  if (c.env?.ASSETS) {
    const url = new URL("/" + name.replace(/^\//, ""), c.req.url);
    const res = await c.env.ASSETS.fetch(url);
    if (!res.ok) return null;
    const headers = new Headers(res.headers);
    headers.set("Content-Type", type);
    return new Response(res.body, { status: res.status, headers });
  }
  const path = publicDir ? resolve(publicDir, name) : "";
  if (!publicDir || !existsSync(path)) return null;
  c.header("Content-Type", type);
  return readFileSync(path, "utf8");
}

app.get("/", async (c) => {
  const html = await sendPublic(c, "index.html", "text/html; charset=utf-8");
  if (!html) return c.text("UI missing", 404);
  if (html instanceof Response) return html;
  return c.body(html);
});

app.get("/scraps", async (c) => {
  const html = await sendPublic(c, "scraps.html", "text/html; charset=utf-8");
  if (!html) return c.text("UI missing", 404);
  if (html instanceof Response) return html;
  return c.body(html);
});

app.get("/batch", async (c) => {
  const html = await sendPublic(c, "batch.html", "text/html; charset=utf-8");
  if (!html) return c.text("UI missing", 404);
  if (html instanceof Response) return html;
  return c.body(html);
});

app.get("/docs/api.md", async (c) => {
  // Prefer public/docs/api.md (local + CF Assets). Fall back to repo docs/.
  const fromPublic = await sendPublic(
    c,
    "docs/api.md",
    "text/markdown; charset=utf-8",
  );
  if (fromPublic) {
    if (fromPublic instanceof Response) return fromPublic;
    return c.body(fromPublic);
  }
  try {
    const docsPath = resolve(
      fileURLToPath(new URL(".", import.meta.url)),
      "../../../docs/api.md",
    );
    if (!existsSync(docsPath)) return c.text("API docs missing", 404);
    c.header("Content-Type", "text/markdown; charset=utf-8");
    return c.body(readFileSync(docsPath, "utf8"));
  } catch {
    return c.text("API docs missing", 404);
  }
});

app.get("/docs/api", async (c) => {
  const html = await sendPublic(c, "api-docs.html", "text/html; charset=utf-8");
  if (!html) return c.text("API docs UI missing", 404);
  if (html instanceof Response) return html;
  return c.body(html);
});

app.get("/ui.css", async (c) => {
  const css = await sendPublic(c, "ui.css", "text/css; charset=utf-8");
  if (!css) return c.text("missing", 404);
  if (css instanceof Response) return css;
  return c.body(css);
});

app.get("/ui.js", async (c) => {
  const js = await sendPublic(c, "ui.js", "application/javascript; charset=utf-8");
  if (!js) return c.text("missing", 404);
  if (js instanceof Response) return js;
  return c.body(js);
});

app.get("/scraps.js", async (c) => {
  const js = await sendPublic(c, "scraps.js", "application/javascript; charset=utf-8");
  if (!js) return c.text("missing", 404);
  if (js instanceof Response) return js;
  return c.body(js);
});

app.get("/theme.js", async (c) => {
  const js = await sendPublic(c, "theme.js", "application/javascript; charset=utf-8");
  if (!js) return c.text("missing", 404);
  if (js instanceof Response) return js;
  return c.body(js);
});

app.get("/media-settings.js", async (c) => {
  const js = await sendPublic(
    c,
    "media-settings.js",
    "application/javascript; charset=utf-8",
  );
  if (!js) return c.text("missing", 404);
  if (js instanceof Response) return js;
  return c.body(js);
});

app.get("/credits.js", async (c) => {
  const js = await sendPublic(c, "credits.js", "application/javascript; charset=utf-8");
  if (!js) return c.text("missing", 404);
  if (js instanceof Response) return js;
  return c.body(js);
});

app.get("/batch.js", async (c) => {
  const js = await sendPublic(c, "batch.js", "application/javascript; charset=utf-8");
  if (!js) return c.text("missing", 404);
  if (js instanceof Response) return js;
  return c.body(js);
});

app.get("/batch-store.js", async (c) => {
  const js = await sendPublic(c, "batch-store.js", "application/javascript; charset=utf-8");
  if (!js) return c.text("missing", 404);
  if (js instanceof Response) return js;
  return c.body(js);
});

app.get("/vendor/zustand/:file", async (c) => {
  const file = c.req.param("file");
  if (!file || file.includes("..") || file.includes("/")) {
    return c.text("not found", 404);
  }
  if (c.env?.ASSETS) {
    const res = await c.env.ASSETS.fetch(
      new URL(`/vendor/zustand/${file}`, c.req.url),
    );
    if (!res.ok) return c.text("missing", 404);
    const headers = new Headers(res.headers);
    headers.set("Content-Type", "application/javascript; charset=utf-8");
    headers.set("Cache-Control", "public, max-age=86400");
    return new Response(res.body, { status: res.status, headers });
  }
  const path = publicDir ? resolve(publicDir, "vendor/zustand", file) : "";
  if (!publicDir || !existsSync(path)) return c.text("missing", 404);
  const body = readFileSync(path, "utf8");
  c.header("Content-Type", "application/javascript; charset=utf-8");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(body);
});

/** New shadcn admin SPA (Vite build copied to public/admin). */
app.get("/admin", (c) => c.redirect("/admin/", 302));

app.get("/admin/", async (c) => {
  const html = await sendPublic(c, "admin/index.html", "text/html; charset=utf-8");
  if (!html) {
    return c.text(
      "Admin UI not built. Run: VITE_BASE=/admin/ npm run build --prefix apps/web && rm -rf apps/api/public/admin && cp -r apps/web/dist apps/api/public/admin",
      404,
    );
  }
  if (html instanceof Response) return html;
  return c.body(html);
});

app.get("/admin/*", async (c) => {
  const pathname = new URL(c.req.url).pathname;
  // Serve hashed assets / files with an extension from ASSETS or public/
  if (/\.[a-zA-Z0-9]+$/.test(pathname)) {
    const rel = pathname.replace(/^\//, "");
    if (c.env?.ASSETS) {
      const res = await c.env.ASSETS.fetch(new URL(pathname, c.req.url));
      if (res.ok) return res;
    } else if (publicDir) {
      const filePath = resolve(publicDir, rel);
      if (existsSync(filePath)) {
        const ext = filePath.split(".").pop()?.toLowerCase();
        const type =
          ext === "js" || ext === "mjs"
            ? "application/javascript; charset=utf-8"
            : ext === "css"
              ? "text/css; charset=utf-8"
              : ext === "svg"
                ? "image/svg+xml"
                : ext === "png"
                  ? "image/png"
                  : ext === "woff2"
                    ? "font/woff2"
                    : "application/octet-stream";
        const body = readFileSync(filePath);
        c.header("Content-Type", type);
        c.header("Cache-Control", "public, max-age=31536000, immutable");
        return c.body(body);
      }
    }
    return c.text("missing", 404);
  }

  // SPA client routes → index.html
  const html = await sendPublic(c, "admin/index.html", "text/html; charset=utf-8");
  if (!html) return c.text("Admin UI missing", 404);
  if (html instanceof Response) return html;
  return c.body(html);
});

  // Health should report runtime
  return app;
}
