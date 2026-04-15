import { promises as fs } from "node:fs";
import path from "node:path";
import { getVaultConfig, resolveTargetDir } from "./vault";
import type { PostMedia } from "../types";

export interface DownloadedImage {
  remoteUrl: string;
  localFilename: string;
}

/** Max bytes we'll ever commit to disk for a single image. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Hosts we trust for media downloads. The URL usually comes from the X API
 * (pbs.twimg.com / video.twimg.com) but can also be emitted by Grok, which
 * is LLM output influenced by tweet content — so we hard-gate the hostname
 * to prevent SSRF via crafted tweets.
 */
const ALLOWED_MEDIA_HOSTS = new Set([
  "pbs.twimg.com",
  "video.twimg.com",
  "abs.twimg.com",
  "ton.twimg.com",
]);

function assetsDir(): string {
  return path.join(resolveTargetDir(getVaultConfig()), "assets");
}

function isAllowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return ALLOWED_MEDIA_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function extensionFor(url: string, contentType?: string): string {
  try {
    const u = new URL(url);
    const format = u.searchParams.get("format");
    if (format) {
      const f = format.toLowerCase();
      if (["jpg", "jpeg", "png", "webp", "gif"].includes(f)) {
        return f === "jpeg" ? "jpg" : f;
      }
    }
    const pathMatch = u.pathname.match(/\.(jpg|jpeg|png|webp|gif)$/i);
    if (pathMatch) {
      return pathMatch[1].toLowerCase() === "jpeg"
        ? "jpg"
        : pathMatch[1].toLowerCase();
    }
  } catch {
    // fall through
  }
  if (contentType) {
    if (contentType.includes("png")) return "png";
    if (contentType.includes("webp")) return "webp";
    if (contentType.includes("gif")) return "gif";
    if (contentType.includes("jpeg") || contentType.includes("jpg"))
      return "jpg";
  }
  return "jpg";
}

async function downloadOne(
  url: string,
  targetPath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isAllowedUrl(url)) {
    return { ok: false, error: "host not in media allowlist" };
  }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        error: `declared size ${declared}B exceeds ${MAX_IMAGE_BYTES}B`,
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        error: `actual size ${buf.length}B exceeds ${MAX_IMAGE_BYTES}B`,
      };
    }
    await fs.writeFile(targetPath, buf);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const DOWNLOAD_CONCURRENCY = 3;

export async function downloadImages(
  tweetId: string,
  media: PostMedia[],
): Promise<DownloadedImage[]> {
  const images = media.filter((m) => m.type === "image" && m.url);
  if (images.length === 0) return [];

  const dir = assetsDir();
  await fs.mkdir(dir, { recursive: true });

  const tasks = images.map((m, i) => async () => {
    const ext = extensionFor(m.url);
    const filename = `${tweetId}_${i + 1}.${ext}`;
    const abs = path.join(dir, filename);

    try {
      await fs.access(abs);
      return { remoteUrl: m.url, localFilename: filename };
    } catch {
      // not yet downloaded
    }

    const outcome = await downloadOne(m.url, abs);
    if (outcome.ok) {
      return { remoteUrl: m.url, localFilename: filename };
    }
    console.warn(`[media] failed to download ${m.url}: ${outcome.error}`);
    return null;
  });

  const results: DownloadedImage[] = [];
  for (let i = 0; i < tasks.length; i += DOWNLOAD_CONCURRENCY) {
    const batch = tasks.slice(i, i + DOWNLOAD_CONCURRENCY).map((t) => t());
    const settled = await Promise.all(batch);
    for (const r of settled) if (r) results.push(r);
  }
  return results;
}
