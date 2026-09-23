import type { Platform } from "./types.js";
import {
  readCached,
  scMode,
  stripCacheMeta,
  writeCached,
} from "./sc-cache.js";
import { getConfig } from "./config.js";

function required(name: string): string {
  const value = name === "SCRAPECREATORS_API_KEY" ? getConfig().scrapeCreatorsApiKey : undefined;
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function apiKey() {
  return required("SCRAPECREATORS_API_KEY");
}

export function detectPlatform(url: string): Platform {
  const u = url.toLowerCase();
  if (u.includes("instagram.com") || u.includes("instagr.am")) return "instagram";
  if (u.includes("tiktok.com") || u.includes("vm.tiktok.com")) return "tiktok";
  if (u.includes("twitter.com") || u.includes("x.com") || u.includes("t.co/"))
    return "x";
  throw new Error(
    "Unsupported link. Paste an Instagram, TikTok, or X (Twitter) post URL.",
  );
}

/** Reject profile / home links — we only scrape a single post. */
export function assertSinglePostUrl(url: string, platform: Platform) {
  const u = url.toLowerCase();
  if (platform === "x") {
    if (!/\/status\/\d+/.test(u)) {
      throw new Error(
        "That looks like an X profile (or home) link. Paste a post URL like https://x.com/user/status/123…",
      );
    }
  }
  if (platform === "instagram") {
    if (!/\/(p|reel|reels|tv)\//.test(u)) {
      throw new Error(
        "That looks like an Instagram profile. Paste a post/reel URL like https://www.instagram.com/reel/…",
      );
    }
  }
  if (platform === "tiktok") {
    if (!/\/video\/\d+/.test(u) && !u.includes("vm.tiktok.com")) {
      throw new Error(
        "That looks like a TikTok profile. Paste a video URL like https://www.tiktok.com/@user/video/123…",
      );
    }
  }
}

async function scGet(path: string, params: Record<string, string> = {}) {
  const mode = scMode();
  const hit = mode === "live" ? null : readCached(path, params);
  if (hit) {
    if (getConfig().scCacheLog) {
      console.info(`[sc] ${hit.source} hit ${path} (${hit.key})`);
    }
    return stripCacheMeta(hit.body);
  }
  if (mode === "offline") {
    throw new Error(
      `SC_MODE=offline and no cache/fixture for ${path}. ` +
        `Run once with SC_MODE=cache, or set SC_FIXTURE=name.json`,
    );
  }

  // Vendor-side cache → 0 credits on hit (ScrapeCreators cache_max_age, hours)
  const vendorHours = getConfig().scVendorCacheHours == null ? undefined : String(getConfig().scVendorCacheHours);
  const callParams = { ...params };
  if (vendorHours && !callParams.cache_max_age) {
    callParams.cache_max_age = vendorHours;
  }

  const qs = new URLSearchParams(callParams).toString();
  const url = qs
    ? `https://api.scrapecreators.com${path}?${qs}`
    : `https://api.scrapecreators.com${path}`;
  const res = await fetch(url, { headers: { "x-api-key": apiKey() } });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`ScrapeCreators ${path}: non-JSON ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(
      `ScrapeCreators ${path}: ${res.status} ${JSON.stringify(body).slice(0, 400)}`,
    );
  }
  writeCached(path, params, body);
  return body;
}

export async function scrapeInstagramPost(url: string) {
  return scGet("/v1/instagram/post", {
    url,
    include_play_count: "false",
  });
}

export async function scrapeTikTokVideo(url: string) {
  return scGet("/v1/tiktok/video", { url });
}

export async function scrapeTwitterTweet(url: string) {
  return scGet("/v1/twitter/tweet", { url });
}

export async function fetchTwitterUserTweets(handle: string) {
  return scGet("/v1/twitter/user-tweets", {
    handle: handle.replace(/^@/, ""),
  });
}

export async function fetchInstagramUserPosts(handle: string, nextMaxId?: string) {
  const params: Record<string, string> = {
    handle: handle.replace(/^@/, ""),
  };
  if (nextMaxId) params.next_max_id = nextMaxId;
  return scGet("/v2/instagram/user/posts", params);
}

export async function fetchTikTokProfileVideos(
  handle: string,
  opts?: { maxCursor?: string; sortBy?: "latest" | "popular" },
) {
  const params: Record<string, string> = {
    handle: handle.replace(/^@/, ""),
    sort_by: opts?.sortBy || "latest",
  };
  if (opts?.maxCursor) params.max_cursor = opts.maxCursor;
  return scGet("/v3/tiktok/profile/videos", params);
}

export async function getCreditBalance(): Promise<number> {
  const body = (await scGet("/v1/account/credit-balance")) as {
    creditCount?: number;
  };
  const n = Number(body.creditCount);
  if (Number.isNaN(n)) {
    throw new Error("ScrapeCreators credit balance: missing creditCount");
  }
  return n;
}

export type CreditUsageRow = {
  id: string;
  endpoint: string;
  route: string;
  statusCode: number;
  credits: number;
  success: boolean;
  cacheHit: boolean;
  durationMs: number | null;
  at: string;
};

function routeFromEndpoint(endpoint: string): string {
  try {
    const path = endpoint.split("?")[0] || endpoint;
    return path;
  } catch {
    return endpoint;
  }
}

export async function getCreditUsage(page = 1): Promise<CreditUsageRow[]> {
  const body = await scGet("/v1/account/get-api-usage", {
    page: String(Math.max(1, Math.min(100, page))),
  });
  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : [];
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    const endpoint = String(r.endpoint || "");
    return {
      id: String(r.id || r.log_id || ""),
      endpoint,
      route: routeFromEndpoint(endpoint),
      statusCode: Number(r.status_code ?? r.statusCode ?? 0),
      credits: Number(r.credits ?? 0),
      success: Boolean(r.success),
      cacheHit: Boolean(r.cache_hit ?? r.cacheHit),
      durationMs:
        r.duration_ms != null
          ? Number(r.duration_ms)
          : r.durationMs != null
            ? Number(r.durationMs)
            : null,
      at: String(r.created_at || r.request_time || r.response_time || ""),
    };
  });
}
