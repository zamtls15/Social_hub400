import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";

/**
 * Disk cache for ScrapeCreators responses.
 * On Cloudflare Workers: always live (no disk) — never call fileURLToPath at module load.
 */

export type ScMode = "cache" | "offline" | "live";

function isCloudflare(): boolean {
  return getConfig().runtime === "cloudflare";
}

export function scMode(): ScMode {
  if (isCloudflare()) return "live";
  const raw = String(getConfig().scMode).toLowerCase().trim();
  if (raw === "offline" || raw === "fixture" || raw === "fixtures") return "offline";
  if (raw === "live" || raw === "nocache") return "live";
  return "cache";
}

export function cacheKey(path: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha256").update(`${path}?${sorted}`).digest("hex").slice(0, 24);
}

function diskRoots(): { cache: string; fixtures: string } | null {
  if (isCloudflare()) return null;
  try {
    const url = import.meta.url;
    if (!url) return null;
    const root = join(dirname(fileURLToPath(url)), "..", "..", "..", "..");
    return {
      cache: join(root, ".cache", "scrapecreators"),
      fixtures: join(root, "fixtures", "scrapecreators"),
    };
  } catch {
    return null;
  }
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export type CacheHit = {
  body: unknown;
  source: "cache" | "fixture";
  key: string;
  path: string;
};

export function readCached(
  path: string,
  params: Record<string, string>,
): CacheHit | null {
  const roots = diskRoots();
  if (!roots) return null;
  const key = cacheKey(path, params);
  const disk = join(roots.cache, `${key}.json`);
  if (existsSync(disk)) {
    return {
      body: JSON.parse(readFileSync(disk, "utf8")),
      source: "cache",
      key,
      path: disk,
    };
  }

  const fixtureByKey = join(roots.fixtures, `${key}.json`);
  if (existsSync(fixtureByKey)) {
    return {
      body: JSON.parse(readFileSync(fixtureByKey, "utf8")),
      source: "fixture",
      key,
      path: fixtureByKey,
    };
  }

  const named = getConfig().scFixture?.trim();
  if (named) {
    const p =
      named.includes("/") || named.includes("\\")
        ? named
        : join(roots.fixtures, named);
    if (existsSync(p)) {
      return {
        body: JSON.parse(readFileSync(p, "utf8")),
        source: "fixture",
        key,
        path: p,
      };
    }
  }

  return null;
}

export function writeCached(
  path: string,
  params: Record<string, string>,
  body: unknown,
): string {
  if (!getConfig().scCacheWrite || isCloudflare()) return "";
  const roots = diskRoots();
  if (!roots) return "";
  ensureDir(roots.cache);
  const key = cacheKey(path, params);
  const disk = join(roots.cache, `${key}.json`);
  const at = new Date().toISOString();
  writeFileSync(
    disk,
    JSON.stringify(
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? { ...(body as object), __scCache: { at, path, params } }
        : { __scPayload: body, __scCache: { at, path, params } },
      null,
      2,
    ),
  );
  return disk;
}

export function stripCacheMeta(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const o = { ...(body as Record<string, unknown>) };
  if ("__scPayload" in o) return o.__scPayload;
  delete o.__scCache;
  return o;
}

export function promoteToFixture(
  path: string,
  params: Record<string, string>,
  alias: string,
): string {
  const roots = diskRoots();
  if (!roots) throw new Error("No disk available (Cloudflare runtime)");
  const hit = readCached(path, params);
  if (!hit) throw new Error(`Nothing cached for ${path}`);
  ensureDir(roots.fixtures);
  const name = alias.endsWith(".json") ? alias : `${alias}.json`;
  const dest = join(roots.fixtures, name);
  writeFileSync(dest, JSON.stringify(stripCacheMeta(hit.body), null, 2));
  return dest;
}
