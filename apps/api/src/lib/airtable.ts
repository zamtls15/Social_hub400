import { recordAirtableRequest } from "./usage.js";
import { getConfig } from "./config.js";

function required(name: string): string {
  const config = getConfig();
  const value = name === "AIRTABLE_TOKEN" ? config.airtableToken : config.airtableApiKey;
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function baseId() {
  return getConfig().airtableBaseId;
}

function mediaTable() {
  return getConfig().airtableMediaTable;
}

function postsTable() {
  return getConfig().airtablePostsTable;
}

function profilesTable() {
  return getConfig().airtableProfilesTable;
}

function token() {
  return (
    getConfig().airtableToken ||
    getConfig().airtableApiKey ||
    required("AIRTABLE_TOKEN")
  );
}

function errorCause(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  let cur: unknown = err.cause;
  for (let i = 0; i < 3 && cur; i++) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      cur = cur.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" → ");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function airtableFetch(path: string, init?: RequestInit) {
  const method = init?.method ?? "GET";
  const url = `https://api.airtable.com/v0/${baseId()}${path}`;
  const attempts = 3;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
      // Track every attempt that received an HTTP response (including 429/5xx).
      recordAirtableRequest({
        method,
        path,
        status: res.status,
      });
      if (res.status === 429 || res.status >= 500) {
        const body = await res.text();
        lastErr = new Error(`Airtable ${method} ${path}: ${res.status} ${body}`);
        if (attempt < attempts) {
          await sleep(250 * attempt * attempt);
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) {
        throw new Error(
          `Airtable ${method} ${path}: ${res.status} ${await res.text()}`,
        );
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      const msg = errorCause(err);
      const retryable =
        /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|network|429|5\d\d/i.test(
          msg,
        );
      if (!retryable || attempt >= attempts) {
        throw new Error(`Airtable ${method} ${path}: ${msg}`);
      }
      console.warn(
        `[airtable] retry ${attempt}/${attempts} ${method} ${path}: ${msg}`,
      );
      await sleep(250 * attempt * attempt);
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Airtable ${method} ${path}: ${errorCause(lastErr)}`);
}

export type AirtableRecord = { id: string; fields: Record<string, unknown>; createdTime?: string };

function formulaEq(field: string, value: string) {
  const escaped = value.replace(/'/g, "\\'");
  return `{${field}}='${escaped}'`;
}

async function findOne(
  table: string,
  formula: string,
): Promise<AirtableRecord | null> {
  const qs = new URLSearchParams({
    filterByFormula: formula,
    maxRecords: "1",
  });
  const data = (await airtableFetch(`/${table}?${qs}`)) as {
    records: AirtableRecord[];
  };
  return data.records[0] ?? null;
}

export async function listRecords(
  table: string,
  options?: {
    pageSize?: number;
    offset?: string;
    sortField?: string;
    sortDir?: "asc" | "desc";
  },
): Promise<{ records: AirtableRecord[]; offset?: string }> {
  const qs = new URLSearchParams();
  qs.set("pageSize", String(options?.pageSize ?? 50));
  if (options?.offset) qs.set("offset", options.offset);
  if (options?.sortField) {
    qs.set("sort[0][field]", options.sortField);
    qs.set("sort[0][direction]", options.sortDir ?? "desc");
  }
  return (await airtableFetch(`/${table}?${qs}`)) as {
    records: AirtableRecord[];
    offset?: string;
  };
}

export async function listPosts(pageSize = 50) {
  try {
    return await listRecords(postsTable(), {
      pageSize,
      sortField: "Scraped",
      sortDir: "desc",
    });
  } catch {
    return listRecords(postsTable(), { pageSize });
  }
}

export async function listMedia(pageSize = 100) {
  return listRecords(mediaTable(), { pageSize: Math.min(pageSize, 100) });
}

export async function listProfiles(pageSize = 100) {
  return listRecords(profilesTable(), { pageSize: Math.min(pageSize, 100) });
}

async function createRecord(
  table: string,
  fields: Record<string, unknown>,
): Promise<AirtableRecord> {
  return (await airtableFetch(`/${table}`, {
    method: "POST",
    body: JSON.stringify({ fields, typecast: true }),
  })) as AirtableRecord;
}

async function patchRecord(
  table: string,
  recordId: string,
  fields: Record<string, unknown>,
): Promise<AirtableRecord> {
  return (await airtableFetch(`/${table}/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify({ fields, typecast: true }),
  })) as AirtableRecord;
}

export async function getMedia(recordId: string): Promise<AirtableRecord> {
  return (await airtableFetch(
    `/${mediaTable()}/${recordId}`,
  )) as AirtableRecord;
}

export async function updateMedia(
  recordId: string,
  fields: Record<string, unknown>,
): Promise<AirtableRecord> {
  return patchRecord(mediaTable(), recordId, fields);
}

export async function updatePost(
  recordId: string,
  fields: Record<string, unknown>,
): Promise<AirtableRecord> {
  return patchRecord(postsTable(), recordId, fields);
}

export async function getPost(recordId: string): Promise<AirtableRecord> {
  return (await airtableFetch(
    `/${postsTable()}/${recordId}`,
  )) as AirtableRecord;
}

export async function listMediaForPost(
  postRecordId: string,
): Promise<AirtableRecord[]> {
  const post = await getPost(postRecordId);
  const linked = Array.isArray(post.fields.Files)
    ? (post.fields.Files as string[])
    : [];
  if (!linked.length) {
    // Fallback: Media.Post link (older rows / partial writes)
    const formula = `FIND('${postRecordId.replace(/'/g, "\\'")}', ARRAYJOIN({Post}))`;
    const qs = new URLSearchParams({
      filterByFormula: formula,
      pageSize: "100",
    });
    const data = (await airtableFetch(`/${mediaTable()}?${qs}`)) as {
      records: AirtableRecord[];
    };
    return [...data.records].sort(
      (a, b) => Number(a.fields.Order ?? 0) - Number(b.fields.Order ?? 0),
    );
  }

  const records = await Promise.all(linked.map((id) => getMedia(id)));
  return records.sort(
    (a, b) => Number(a.fields.Order ?? 0) - Number(b.fields.Order ?? 0),
  );
}

export async function upsertProfile(
  fields: Record<string, unknown>,
): Promise<AirtableRecord> {
  const handle = String(fields.Handle ?? "");
  const platform = String(fields.Platform ?? "");
  if (handle && platform) {
    const existing = await findOne(
      profilesTable(),
      `AND(${formulaEq("Handle", handle)},${formulaEq("Platform", platform)})`,
    );
    if (existing) {
      return patchRecord(profilesTable(), existing.id, fields);
    }
  }
  return createRecord(profilesTable(), fields);
}

export async function upsertPost(
  fields: Record<string, unknown>,
): Promise<AirtableRecord> {
  const postId = String(fields["Post ID"] ?? "");
  if (postId) {
    const existing = await findOne(postsTable(), formulaEq("Post ID", postId));
    if (existing) {
      return patchRecord(postsTable(), existing.id, fields);
    }
  }
  return createRecord(postsTable(), fields);
}

export async function upsertMedia(
  fields: Record<string, unknown>,
): Promise<AirtableRecord> {
  const mediaId = String(fields["Media ID"] ?? "");
  if (mediaId) {
    const existing = await findOne(
      mediaTable(),
      formulaEq("Media ID", mediaId),
    );
    if (existing) {
      // Keep existing Saved copy unless caller overwrites
      const merged = { ...fields };
      if (!merged["Saved copy"] && existing.fields["Saved copy"]) {
        delete merged["Saved copy"];
      }
      return patchRecord(mediaTable(), existing.id, merged);
    }
  }
  return createRecord(mediaTable(), fields);
}
