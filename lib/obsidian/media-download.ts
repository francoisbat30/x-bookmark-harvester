import { promises as fs } from "node:fs";
import path from "node:path";
import { getVaultConfig, resolveTargetDir } from "./vault";
import type { PostMedia } from "../types";

export interface DownloadedImage {
  remoteUrl: string;
  localFilename: string;
}

/** Max bytes we'll ever commit to disk for a single downloaded file. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

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

export interface DownloadOptions {
  /**
   * Télécharger aussi les fichiers vidéo (mp4, ≤20 MB). Défaut false : on
   * archive le poster (image de couverture) + on garde le lien distant —
   * le vault reste léger, l'essentiel visuel est préservé.
   */
  includeVideoFiles?: boolean;
}

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
    const pathMatch = u.pathname.match(/\.(jpg|jpeg|png|webp|gif|mp4)$/i);
    if (pathMatch) {
      const ext = pathMatch[1].toLowerCase();
      return ext === "jpeg" ? "jpg" : ext;
    }
  } catch {
    // fall through
  }
  if (contentType) {
    if (contentType.includes("png")) return "png";
    if (contentType.includes("webp")) return "webp";
    if (contentType.includes("gif")) return "gif";
    if (contentType.includes("mp4")) return "mp4";
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
    if (declared > MAX_FILE_BYTES) {
      return {
        ok: false,
        error: `declared size ${declared}B exceeds ${MAX_FILE_BYTES}B`,
      };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) {
      return {
        ok: false,
        error: `actual size ${buf.length}B exceeds ${MAX_FILE_BYTES}B`,
      };
    }
    await fs.writeFile(targetPath, buf);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const DOWNLOAD_CONCURRENCY = 3;

interface DownloadTask {
  url: string;
  filename: string;
}

/**
 * Construit la liste des fichiers à rapatrier pour un post :
 *   image        → le fichier lui-même            <id>_<n>.<ext>
 *   vidéo / gif  → son poster (preview)           <id>_<n>_poster.<ext>
 *                  + le mp4 si includeVideoFiles  <id>_<n>.mp4
 * L'index n suit la position dans post.media (stable entre re-runs).
 */
function buildTasks(
  tweetId: string,
  media: PostMedia[],
  options: DownloadOptions,
): DownloadTask[] {
  const tasks: DownloadTask[] = [];
  media.forEach((m, i) => {
    const n = i + 1;
    if (m.type === "image") {
      if (m.url) {
        tasks.push({ url: m.url, filename: `${tweetId}_${n}.${extensionFor(m.url)}` });
      }
      return;
    }
    if (m.posterUrl) {
      tasks.push({
        url: m.posterUrl,
        filename: `${tweetId}_${n}_poster.${extensionFor(m.posterUrl)}`,
      });
    }
    if (options.includeVideoFiles && m.url) {
      tasks.push({ url: m.url, filename: `${tweetId}_${n}.mp4` });
    }
  });
  return tasks;
}

export async function downloadImages(
  tweetId: string,
  media: PostMedia[],
  options: DownloadOptions = {},
): Promise<DownloadedImage[]> {
  const wanted = buildTasks(tweetId, media, options);
  if (wanted.length === 0) return [];

  const dir = assetsDir();
  await fs.mkdir(dir, { recursive: true });

  const tasks = wanted.map((w) => async () => {
    const abs = path.join(dir, w.filename);

    try {
      await fs.access(abs);
      return { remoteUrl: w.url, localFilename: w.filename };
    } catch {
      // not yet downloaded
    }

    const outcome = await downloadOne(w.url, abs);
    if (outcome.ok) {
      return { remoteUrl: w.url, localFilename: w.filename };
    }
    console.warn(`[media] failed to download ${w.url}: ${outcome.error}`);
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
