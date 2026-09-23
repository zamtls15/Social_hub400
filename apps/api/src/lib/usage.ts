/**
 * Append-only usage events (Airtable table).
 * Writes never throw to callers — soft-fail if table unset or Airtable errors.
 * Does not invent vendor quotas/limits.
 */
import { getConfig } from "./config.js";

export type UsageService = "airtable" | "r2" | "scrapecreators";
export type UsageMetric = "api_request" | "upload_bytes" | "credit_snapshot";
export type UsageUnit = "count" | "bytes" | "credits";

export type UsageEventInput = {
  service: UsageService;
  metric: UsageMetric;
  delta: number;
  unit: UsageUnit;
  path?: string;
  method?: string;
  status?: number;
  detail?: string;
};

export type UsageEvent = UsageEventInput & {
  id: string;
  at: string;
};

function usageTableId(): string | null {
  return getConfig().airtableUsageEventsTable ?? null;
}

function baseId() {
  return getConfig().airtableBaseId;
}

function token(): string | null {
  return (
    getConfig().airtableToken ||
    getConfig().airtableApiKey ||
    null
  );
}

function isUsageTablePath(path: string): boolean {
  const table = usageTableId();
  if (!table) return false;
  return path.includes(`/${table}`);
}

/** True when path targets the usage_events table (skip re-entrant tracking). */
export function shouldSkipAirtableUsageTracking(path: string): boolean {
  return isUsageTablePath(path);
}

async function writeUsageEvent(fields: Record<string, unknown>): Promise<void> {
  const table = usageTableId();
  const auth = token();
  if (!table || !auth) return;

  const url = `https://api.airtable.com/v0/${baseId()}/${table}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields, typecast: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(
      `[usage] write failed ${res.status}: ${body.slice(0, 200)}`,
    );
  }
}

/** Fire-and-forget append. Safe to call from hot paths. */
export function recordUsageEvent(input: UsageEventInput): void {
  if (!usageTableId() || !token()) return;
  if (!Number.isFinite(input.delta)) return;

  const fields: Record<string, unknown> = {
    Label: `${input.service}:${input.metric}`,
    Service: input.service,
    Metric: input.metric,
    Delta: input.delta,
    Unit: input.unit,
    "Occurred At": new Date().toISOString(),
  };
  if (input.path) fields.Path = input.path.slice(0, 500);
  if (input.method) fields.Method = input.method;
  if (input.status != null && Number.isFinite(input.status)) {
    fields["Status Code"] = input.status;
  }
  if (input.detail) fields.Detail = input.detail.slice(0, 1000);

  void writeUsageEvent(fields).catch((err) => {
    console.warn("[usage] write error", err instanceof Error ? err.message : err);
  });
}

export function recordAirtableRequest(opts: {
  method: string;
  path: string;
  status: number;
}): void {
  if (shouldSkipAirtableUsageTracking(opts.path)) return;
  recordUsageEvent({
    service: "airtable",
    metric: "api_request",
    delta: 1,
    unit: "count",
    method: opts.method,
    path: opts.path.split("?")[0],
    status: opts.status,
  });
}

export function recordR2Upload(opts: { bytes: number; key?: string }): void {
  if (!opts.bytes || opts.bytes < 0) return;
  recordUsageEvent({
    service: "r2",
    metric: "upload_bytes",
    delta: opts.bytes,
    unit: "bytes",
    detail: opts.key,
  });
}

/** Optional snapshot — ScrapeCreators remains source of truth for balance. */
let lastCreditSnapshotAt = 0;
let lastCreditSnapshotValue: number | null = null;

export function recordScrapeCreatorsCreditSnapshot(remaining: number): void {
  if (!Number.isFinite(remaining)) return;
  const now = Date.now();
  // Avoid flooding usage_events when credits chip / usage page poll often.
  if (
    lastCreditSnapshotValue === remaining &&
    now - lastCreditSnapshotAt < 15 * 60 * 1000
  ) {
    return;
  }
  lastCreditSnapshotAt = now;
  lastCreditSnapshotValue = remaining;
  recordUsageEvent({
    service: "scrapecreators",
    metric: "credit_snapshot",
    delta: remaining,
    unit: "credits",
  });
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function asNum(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function listUsageEvents(pageSize = 100): Promise<UsageEvent[]> {
  const table = usageTableId();
  const auth = token();
  if (!table || !auth) return [];

  const qs = new URLSearchParams({
    pageSize: String(Math.min(100, Math.max(1, pageSize))),
  });
  const url = `https://api.airtable.com/v0/${baseId()}/${table}?${qs}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${auth}` },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`usage list failed ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    records?: Array<{
      id: string;
      createdTime?: string;
      fields: Record<string, unknown>;
    }>;
  };

  const events: UsageEvent[] = (data.records || []).map((r) => {
    const f = r.fields;
    return {
      id: r.id,
      service: (asStr(f.Service) as UsageService) || "airtable",
      metric: (asStr(f.Metric) as UsageMetric) || "api_request",
      delta: asNum(f.Delta) ?? 0,
      unit: (asStr(f.Unit) as UsageUnit) || "count",
      path: asStr(f.Path),
      method: asStr(f.Method),
      status: asNum(f["Status Code"]),
      detail: asStr(f.Detail),
      at: asStr(f["Occurred At"]) || r.createdTime || "",
    };
  });

  events.sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );
  return events;
}

export type UsageSummary = {
  configured: boolean;
  airtableRequests: number;
  r2UploadBytes: number;
  r2UploadCount: number;
  lastCreditSnapshot: number | null;
  lastCreditSnapshotAt: string | null;
  byDay: Array<{
    day: string;
    airtableRequests: number;
    r2UploadBytes: number;
  }>;
  events: UsageEvent[];
};

export function summarizeUsageEvents(events: UsageEvent[]): Omit<
  UsageSummary,
  "configured"
> {
  let airtableRequests = 0;
  let r2UploadBytes = 0;
  let r2UploadCount = 0;
  let lastCreditSnapshot: number | null = null;
  let lastCreditSnapshotAt: string | null = null;

  const dayMap = new Map<
    string,
    { airtableRequests: number; r2UploadBytes: number }
  >();

  for (const e of events) {
    const day = e.at ? e.at.slice(0, 10) : "unknown";
    if (!dayMap.has(day)) {
      dayMap.set(day, { airtableRequests: 0, r2UploadBytes: 0 });
    }
    const bucket = dayMap.get(day)!;

    if (e.service === "airtable" && e.metric === "api_request") {
      airtableRequests += e.delta;
      bucket.airtableRequests += e.delta;
    }
    if (e.service === "r2" && e.metric === "upload_bytes") {
      r2UploadBytes += e.delta;
      r2UploadCount += 1;
      bucket.r2UploadBytes += e.delta;
    }
    if (
      e.service === "scrapecreators" &&
      e.metric === "credit_snapshot" &&
      lastCreditSnapshotAt == null
    ) {
      // events are newest-first
      lastCreditSnapshot = e.delta;
      lastCreditSnapshotAt = e.at || null;
    }
  }

  const byDay = [...dayMap.entries()]
    .filter(([d]) => d !== "unknown")
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 14)
    .map(([day, v]) => ({ day, ...v }))
    .reverse();

  return {
    airtableRequests,
    r2UploadBytes,
    r2UploadCount,
    lastCreditSnapshot,
    lastCreditSnapshotAt,
    byDay,
    events,
  };
}

export function usageTrackingConfigured(): boolean {
  return Boolean(usageTableId() && token());
}
