import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SettingType = "string" | "number" | "boolean" | "url" | "secret";
export type SettingSource = "environment" | "stored";

export type WorkerConfigEnv = {
  SETTINGS_DB?: D1Like;
  [key: string]: unknown;
};

type D1Result<T = Record<string, unknown>> = {
  results?: T[];
  success?: boolean;
};

type D1Like = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  };
};

type Descriptor = {
  key: string;
  label: string;
  description: string;
  group: string;
  type: SettingType;
  secret?: boolean;
  requiresRestart?: boolean;
  defaultValue: () => unknown;
  validate: (value: unknown) => string | null;
};

export type RuntimeSetting = {
  key: string;
  label: string;
  description: string;
  group: string;
  type: SettingType;
  value: unknown;
  source: SettingSource;
  requiresRestart: boolean;
  secret: boolean;
};

export type RuntimeConfig = Record<string, unknown> & {
  port: number;
  runtime: string;
  inngestEventKey?: string;
  inngestSigningKey?: string;
  inngestDev: boolean;
  scrapeCreatorsApiKey?: string;
  scMode: "cache" | "offline" | "live";
  scVendorCacheHours?: number;
  scFixture?: string;
  scCacheLog: boolean;
  scCacheWrite: boolean;
  airtableToken?: string;
  airtableApiKey?: string;
  airtableBaseId: string;
  airtablePostsTable: string;
  airtableMediaTable: string;
  airtableProfilesTable: string;
  airtableUsageEventsTable?: string;
  r2AccountId?: string;
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  r2Bucket: string;
  r2PublicBaseUrl: string;
};

type StoredSetting = { key: string; value: string; type: string; requires_restart: number };
type CacheEntry = { config: RuntimeConfig; settings: RuntimeSetting[]; expiresAt: number };

const TTL_MS = 45_000;
let cache: CacheEntry | null = null;
let currentEnv: WorkerConfigEnv | undefined;
let localDb: DatabaseSync | null = null;

function envValue(env: WorkerConfigEnv | undefined, key: string): string | undefined {
  const binding = env?.[key];
  if (typeof binding === "string" && binding.length > 0) return binding;
  const value = process.env[key];
  return value === undefined || value === "" ? undefined : value;
}

function requiredText(value: unknown, label: string): string | null {
  if (typeof value !== "string" || !value.trim()) return `${label} is required.`;
  return null;
}

function identifier(value: unknown, label: string): string | null {
  const required = requiredText(value, label);
  if (required) return required;
  if (!/^[A-Za-z0-9_:-]{1,120}$/.test(String(value))) {
    return `${label} must contain only letters, numbers, underscores, colons, or hyphens.`;
  }
  return null;
}

function booleanValue(value: unknown, label: string): string | null {
  return typeof value === "boolean" ? null : `${label} must be Yes or No.`;
}

function numberValue(value: unknown, label: string): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 8760) {
    return `${label} must be a number from 0 to 8760.`;
  }
  return null;
}

function urlValue(value: unknown, label: string): string | null {
  if (typeof value !== "string" || !value.trim()) return `${label} is required.`;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return null;
  } catch {
    return `${label} must be a valid URL starting with http:// or https://.`;
  }
}

function secretValue(value: unknown, label: string): string | null {
  return requiredText(value, label);
}

function descriptors(env: WorkerConfigEnv | undefined): Descriptor[] {
  const text = (key: string, label: string, description: string, group: string, secret = false, requiresRestart = false): Descriptor => ({
    key, label, description, group, type: secret ? "secret" : "string", secret, requiresRestart,
    defaultValue: () => envValue(env, key) ?? "",
    validate: (value) => secret ? secretValue(value, label) : requiredText(value, label),
  });
  return [
    text("SCRAPECREATORS_API_KEY", "ScrapeCreators API key", "Used to fetch posts and credit information. If it is wrong, scraping and credit checks will fail.", "ScrapeCreators", true),
    { key: "SC_MODE", label: "Scrape mode", description: "Controls whether the app uses cache, offline fixtures, or live ScrapeCreators calls.", group: "ScrapeCreators", type: "string", defaultValue: () => (envValue(env, "SC_MODE") ?? "cache"), validate: (v) => ["cache", "offline", "live"].includes(String(v)) ? null : "Scrape mode must be cache, offline, or live." },
    { key: "SC_VENDOR_CACHE_HOURS", label: "Vendor cache hours", description: "Asks ScrapeCreators to reuse results for this many hours and reduce credit usage.", group: "ScrapeCreators", type: "number", defaultValue: () => Number(envValue(env, "SC_VENDOR_CACHE_HOURS") ?? 168), validate: (v) => numberValue(v, "Vendor cache hours") },
    { key: "SC_FIXTURE", label: "Offline fixture", description: "Optional fixture filename for offline testing. Leave blank when not using fixtures.", group: "ScrapeCreators", type: "string", defaultValue: () => envValue(env, "SC_FIXTURE") ?? "", validate: () => null },
    { key: "SC_CACHE_LOG", label: "Cache logging", description: "Writes cache hit details to the server log to help diagnose scrape behavior.", group: "ScrapeCreators", type: "boolean", defaultValue: () => envValue(env, "SC_CACHE_LOG") !== "0", validate: (v) => booleanValue(v, "Cache logging") },
    text("AIRTABLE_TOKEN", "Airtable token", "Used to read and update posts, media, profiles, and usage records. If it is wrong, Airtable features fail.", "Airtable", true),
    text("AIRTABLE_API_KEY", "Airtable API key", "Legacy fallback credential for Airtable. It is used when an Airtable token is not set.", "Airtable", true),
    { key: "AIRTABLE_BASE_ID", label: "Airtable base ID", description: "Selects the Airtable base that stores Social Hub data. A wrong value points the app at the wrong data.", group: "Airtable", type: "string", defaultValue: () => envValue(env, "AIRTABLE_BASE_ID") ?? "appkPrLfwDGwIIbTL", validate: (v) => identifier(v, "Airtable base ID") },
    { key: "AIRTABLE_POSTS_TABLE", label: "Posts table ID", description: "Identifies the Airtable table containing scraped posts. A wrong value breaks post reads and writes.", group: "Airtable", type: "string", defaultValue: () => envValue(env, "AIRTABLE_POSTS_TABLE") ?? "tblxevZB9wCX1N3WF", validate: (v) => identifier(v, "Posts table ID") },
    { key: "AIRTABLE_MEDIA_TABLE", label: "Media table ID", description: "Identifies the Airtable table containing media. A wrong value breaks media reads and saves.", group: "Airtable", type: "string", defaultValue: () => envValue(env, "AIRTABLE_MEDIA_TABLE") ?? "tbly36b1qJiRbfEL2", validate: (v) => identifier(v, "Media table ID") },
    { key: "AIRTABLE_PROFILES_TABLE", label: "Profiles table ID", description: "Identifies the Airtable table containing profiles. A wrong value breaks profile reads and writes.", group: "Airtable", type: "string", defaultValue: () => envValue(env, "AIRTABLE_PROFILES_TABLE") ?? "tblD49NYtqd3vdOTI", validate: (v) => identifier(v, "Profiles table ID") },
    { key: "AIRTABLE_USAGE_EVENTS_TABLE", label: "Usage events table ID", description: "Optional table for usage history. Leave blank to turn usage event recording off.", group: "Airtable", type: "string", defaultValue: () => envValue(env, "AIRTABLE_USAGE_EVENTS_TABLE") ?? "", validate: (v) => v === "" ? null : identifier(v, "Usage events table ID") },
    text("R2_ACCOUNT_ID", "R2 account ID", "Selects the Cloudflare account used for media storage. If it is wrong, media uploads fail.", "R2", true, true),
    text("R2_ACCESS_KEY_ID", "R2 access key", "Used to authenticate media uploads to R2. If it is wrong, uploads fail.", "R2", true, true),
    text("R2_SECRET_ACCESS_KEY", "R2 secret key", "Used with the R2 access key to authenticate uploads. If it is wrong, uploads fail.", "R2", true, true),
    { key: "R2_BUCKET", label: "R2 bucket", description: "Names the bucket where saved media is stored. If it is wrong, uploads go nowhere or fail.", group: "R2", type: "string", requiresRestart: true, defaultValue: () => envValue(env, "R2_BUCKET") ?? "scrape-kit-media", validate: (v) => identifier(v, "R2 bucket") },
    { key: "R2_PUBLIC_BASE_URL", label: "R2 public URL", description: "Base URL used to link to saved media. If it is wrong, saved media links will not open.", group: "R2", type: "url", defaultValue: () => envValue(env, "R2_PUBLIC_BASE_URL") ?? "https://pub-dd096d99ffc0494a9164b431ea60c9c6.r2.dev", validate: (v) => urlValue(v, "R2 public URL") },
    text("INNGEST_EVENT_KEY", "Inngest event key", "Authenticates events sent to Inngest. If it is wrong, background jobs will not start.", "Inngest", true, true),
    text("INNGEST_SIGNING_KEY", "Inngest signing key", "Authenticates Inngest requests to this app. If it is wrong, Inngest callbacks fail.", "Inngest", true, true),
    { key: "INNGEST_DEV", label: "Inngest development mode", description: "Uses the local Inngest development server instead of Inngest Cloud.", group: "Inngest", type: "boolean", requiresRestart: true, defaultValue: () => envValue(env, "INNGEST_DEV") === "1", validate: (v) => booleanValue(v, "Inngest development mode") },
  ];
}

function parseStored(row: StoredSetting, descriptor: Descriptor): unknown {
  try {
    if (descriptor.type === "number") return Number(row.value);
    if (descriptor.type === "boolean") return row.value === "true";
    return row.value;
  } catch {
    return undefined;
  }
}

function localDatabase(): DatabaseSync {
  if (!localDb) {
    const path = resolve(process.cwd(), ".data/settings.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    localDb = new DatabaseSync(path);
    localDb.exec("CREATE TABLE IF NOT EXISTS runtime_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, type TEXT NOT NULL, updated_at TEXT NOT NULL, requires_restart INTEGER NOT NULL DEFAULT 0)");
  }
  return localDb;
}

function isD1(env: WorkerConfigEnv | undefined): env is WorkerConfigEnv & { SETTINGS_DB: D1Like } {
  return Boolean(env?.SETTINGS_DB);
}

async function readStored(env: WorkerConfigEnv | undefined): Promise<StoredSetting[]> {
  try {
    if (isD1(env)) {
      const result = await env.SETTINGS_DB.prepare("SELECT key, value, type, requires_restart FROM runtime_settings").all<StoredSetting>();
      return result.results ?? [];
    }
    const rows = localDatabase().prepare("SELECT key, value, type, requires_restart FROM runtime_settings").all() as StoredSetting[];
    return rows;
  } catch (error) {
    console.error("[config] unable to read settings store", error);
    return [];
  }
}

async function writeStored(env: WorkerConfigEnv | undefined, key: string, value: string, type: string, requiresRestart: boolean): Promise<void> {
  const now = new Date().toISOString();
  try {
    if (isD1(env)) {
      await env.SETTINGS_DB.prepare("INSERT INTO runtime_settings (key, value, type, updated_at, requires_restart) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, type=excluded.type, updated_at=excluded.updated_at, requires_restart=excluded.requires_restart").bind(key, value, type, now, requiresRestart ? 1 : 0).run();
      return;
    }
    localDatabase().prepare("INSERT INTO runtime_settings (key, value, type, updated_at, requires_restart) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, type=excluded.type, updated_at=excluded.updated_at, requires_restart=excluded.requires_restart").run(key, value, type, now, requiresRestart ? 1 : 0);
  } catch (error) {
    console.error("[config] unable to write settings store", error);
    throw new Error("settings store write failed");
  }
}

async function deleteStored(env: WorkerConfigEnv | undefined, key: string): Promise<void> {
  try {
    if (isD1(env)) {
      await env.SETTINGS_DB.prepare("DELETE FROM runtime_settings WHERE key = ?").bind(key).run();
      return;
    }
    localDatabase().prepare("DELETE FROM runtime_settings WHERE key = ?").run(key);
  } catch (error) {
    console.error("[config] unable to delete settings store value", error);
    throw new Error("settings store delete failed");
  }
}

function makeConfig(list: Descriptor[], stored: StoredSetting[]): { config: RuntimeConfig; settings: RuntimeSetting[] } {
  const byKey = new Map(stored.map((row) => [row.key, row]));
  const config: Record<string, unknown> = {};
  const settings = list.map((descriptor) => {
    const row = byKey.get(descriptor.key);
    const fallback = descriptor.defaultValue();
    let value = fallback;
    let source: SettingSource = "environment";
    if (row) {
      const candidate = parseStored(row, descriptor);
      const problem = descriptor.validate(candidate);
      if (candidate !== undefined && !problem) {
        value = candidate;
        source = "stored";
      } else {
        console.warn(`[config] stored value for ${descriptor.key} was invalid; using its environment default${problem ? ` (${problem})` : ""}`);
      }
    }
    config[descriptor.key] = value;
    return { key: descriptor.key, label: descriptor.label, description: descriptor.description, group: descriptor.group, type: descriptor.type, value, source, requiresRestart: descriptor.requiresRestart ?? Boolean(row?.requires_restart), secret: Boolean(descriptor.secret) };
  });
  const c = config as RuntimeConfig;
  c.port = Number(envValue(currentEnv, "PORT") ?? 8787) || 8787;
  c.runtime = envValue(currentEnv, "RUNTIME") ?? "node";
  c.inngestEventKey = String(config.INNGEST_EVENT_KEY || "") || undefined;
  c.inngestSigningKey = String(config.INNGEST_SIGNING_KEY || "") || undefined;
  c.inngestDev = Boolean(config.INNGEST_DEV);
  c.scrapeCreatorsApiKey = String(config.SCRAPECREATORS_API_KEY || "") || undefined;
  c.scMode = config.SC_MODE as RuntimeConfig["scMode"];
  c.scVendorCacheHours = Number.isFinite(config.SC_VENDOR_CACHE_HOURS as number) ? config.SC_VENDOR_CACHE_HOURS as number : undefined;
  c.scFixture = String(config.SC_FIXTURE || "") || undefined;
  c.scCacheLog = Boolean(config.SC_CACHE_LOG);
  c.scCacheWrite = config.SC_CACHE_WRITE !== false && envValue(currentEnv, "SC_CACHE_WRITE") !== "0";
  c.airtableToken = String(config.AIRTABLE_TOKEN || "") || undefined;
  c.airtableApiKey = String(config.AIRTABLE_API_KEY || "") || undefined;
  c.airtableBaseId = String(config.AIRTABLE_BASE_ID);
  c.airtablePostsTable = String(config.AIRTABLE_POSTS_TABLE);
  c.airtableMediaTable = String(config.AIRTABLE_MEDIA_TABLE);
  c.airtableProfilesTable = String(config.AIRTABLE_PROFILES_TABLE);
  c.airtableUsageEventsTable = String(config.AIRTABLE_USAGE_EVENTS_TABLE || "") || undefined;
  c.r2AccountId = String(config.R2_ACCOUNT_ID || "") || undefined;
  c.r2AccessKeyId = String(config.R2_ACCESS_KEY_ID || "") || undefined;
  c.r2SecretAccessKey = String(config.R2_SECRET_ACCESS_KEY || "") || undefined;
  c.r2Bucket = String(config.R2_BUCKET);
  c.r2PublicBaseUrl = String(config.R2_PUBLIC_BASE_URL);
  return { config: c, settings };
}

export async function initializeConfig(env?: WorkerConfigEnv): Promise<RuntimeConfig> {
  currentEnv = env;
  if (cache && cache.expiresAt > Date.now()) return cache.config;
  const result = makeConfig(descriptors(env), await readStored(env));
  cache = { ...result, expiresAt: Date.now() + TTL_MS };
  return result.config;
}

export function getConfig(): RuntimeConfig {
  if (cache) return cache.config;
  return makeConfig(descriptors(currentEnv), []).config;
}

export async function listConfigSettings(env?: WorkerConfigEnv): Promise<RuntimeSetting[]> {
  await initializeConfig(env);
  return cache?.settings ?? [];
}

export async function saveConfigSetting(env: WorkerConfigEnv | undefined, key: string, rawValue: unknown): Promise<{ setting: RuntimeSetting; restarted: boolean }> {
  await initializeConfig(env);
  const descriptor = descriptors(env).find((item) => item.key === key);
  if (!descriptor) throw new Error("Unknown setting.");
  let value: unknown = rawValue;
  if (descriptor.type === "number") value = typeof rawValue === "number" ? rawValue : Number(rawValue);
  if (descriptor.type === "boolean") value = rawValue === true || rawValue === "true";
  if (descriptor.type !== "number" && descriptor.type !== "boolean") value = String(rawValue ?? "").trim();
  const problem = descriptor.validate(value);
  if (problem) throw new Error(problem);
  await writeStored(env, key, descriptor.type === "boolean" ? String(value) : String(value), descriptor.type, Boolean(descriptor.requiresRestart));
  cache = null;
  await initializeConfig(env);
  const setting = (await listConfigSettings(env)).find((item) => item.key === key);
  if (!setting) throw new Error("The setting was saved but could not be reloaded.");
  return { setting, restarted: !setting.requiresRestart };
}

export async function removeConfigSetting(env: WorkerConfigEnv | undefined, key: string): Promise<{ setting: RuntimeSetting; restarted: boolean }> {
  await initializeConfig(env);
  const descriptor = descriptors(env).find((item) => item.key === key);
  if (!descriptor) throw new Error("Unknown setting.");
  await deleteStored(env, key);
  cache = null;
  await initializeConfig(env);
  const setting = (await listConfigSettings(env)).find((item) => item.key === key);
  if (!setting) throw new Error("The setting was deleted but could not be reloaded.");
  return { setting, restarted: !setting.requiresRestart };
}

export function invalidateConfig(): void {
  cache = null;
}

export function resetConfigForTests(): void {
  cache = null;
  currentEnv = undefined;
  localDb = null;
}

export function configStoreStatus(env?: WorkerConfigEnv): "d1" | "sqlite" {
  return isD1(env) ? "d1" : "sqlite";
}

export function configDefaultForTests(key: string, env?: WorkerConfigEnv): unknown {
  return descriptors(env).find((item) => item.key === key)?.defaultValue();
}

export function configStorePath(): string {
  return resolve(process.cwd(), ".data/settings.sqlite");
}

export function configStoreExists(): boolean {
  return existsSync(configStorePath());
}
