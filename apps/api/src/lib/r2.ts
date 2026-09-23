import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { recordR2Upload } from "./usage.js";
import { getConfig } from "./config.js";

function required(name: string): string {
  const config = getConfig();
  const value = name === "R2_ACCOUNT_ID" ? config.r2AccountId : name === "R2_ACCESS_KEY_ID" ? config.r2AccessKeyId : config.r2SecretAccessKey;
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function client() {
  const accountId = required("R2_ACCOUNT_ID");
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: required("R2_ACCESS_KEY_ID"),
      secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    },
  });
}

/** Download original CDN media (image/video). */
export async function downloadCdnUrl(
  url: string,
): Promise<{ buffer: Buffer; contentType: string; bytes: number }> {
  const headers = new Headers({
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  });
  const referer = url.includes("twimg.com")
    ? "https://x.com/"
    : url.includes("cdninstagram.com") || url.includes("instagram.com")
      ? "https://www.instagram.com/"
      : undefined;
  if (referer) headers.set("Referer", referer);
  const res = await fetch(url, {
    headers,
    redirect: "follow",
    // Large X videos can exceed this — callers should prefer async for big files
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`CDN download failed ${res.status}: ${url}`);
  const contentType =
    res.headers.get("content-type") ?? "application/octet-stream";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType, bytes: buffer.length };
}

/** HEAD to learn size before committing to a sync download. */
export async function headCdnUrl(
  url: string,
): Promise<{ contentLength?: number; contentType?: string }> {
  try {
    const headers = new Headers({
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    });
    if (url.includes("twimg.com")) headers.set("Referer", "https://x.com/");
    const res = await fetch(url, {
      method: "HEAD",
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const len = res.headers.get("content-length");
    return {
      contentLength: len ? Number(len) : undefined,
      contentType: res.headers.get("content-type") ?? undefined,
    };
  } catch {
    return {};
  }
}

/** Upload bytes to R2 and return our hosted public URL. */
export async function uploadToR2(options: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<{ key: string; publicUrl: string; bytes: number }> {
  const bucket = getConfig().r2Bucket;
  const publicBase = getConfig().r2PublicBaseUrl;

  await client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: options.key,
      Body: options.body,
      ContentType: options.contentType,
    }),
  );

  recordR2Upload({ bytes: options.body.length, key: options.key });

  return {
    key: options.key,
    bytes: options.body.length,
    publicUrl: `${publicBase.replace(/\/$/, "")}/${options.key}`,
  };
}

export function guessExt(contentType: string, mediaType?: string): string {
  if (contentType.includes("mp4") || mediaType === "video") return "mp4";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("gif") || mediaType === "gif") return "gif";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  return "jpg";
}
