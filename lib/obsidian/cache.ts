import { promises as fs } from "node:fs";
import path from "node:path";
import type { GrokInsights, PostExtraction } from "../types";
import type { DownloadedImage } from "./media-download";
import { stateDir } from "../state";

const CACHE_SUBDIR = ".raw";

export interface CacheEnvelope {
  /**
   * Version du schéma de cache. Absent = v1 (commentaires sans likes, pas de
   * thread[]). v2 = PostComment.likes/isAuthor/isDirectReply + PostExtraction.thread.
   * La lecture reste tolérante : les champs ajoutés sont optionnels.
   */
  version?: 2;
  source: "grok" | "xapi" | "apify" | "mcp";
  fetchedAt: string;
  tweetId: string;
  post: PostExtraction;
  grokInsights?: {
    fetchedAt: string;
    data: GrokInsights;
  };
  downloadedImages?: DownloadedImage[];
  /** Transcripts/descriptions de vidéos (via Grok view_x_video), par URL. */
  videoTranscripts?: Array<{ url: string; text: string }>;
}

function cacheDir(): string {
  // Cache brut d'extraction : hors du vault (matière brute, cf. lib/state.ts).
  return path.join(stateDir(), CACHE_SUBDIR);
}

function cachePath(tweetId: string): string {
  return path.join(cacheDir(), `${tweetId}.json`);
}

export async function readCache(tweetId: string): Promise<CacheEnvelope | null> {
  try {
    const raw = await fs.readFile(cachePath(tweetId), "utf8");
    return JSON.parse(raw) as CacheEnvelope;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function writeCache(
  tweetId: string,
  post: PostExtraction,
  source: CacheEnvelope["source"],
): Promise<string> {
  await fs.mkdir(cacheDir(), { recursive: true });
  const existing = await readCache(tweetId);
  const envelope: CacheEnvelope = {
    version: 2,
    source,
    fetchedAt: new Date().toISOString(),
    tweetId,
    post,
    ...(existing?.grokInsights ? { grokInsights: existing.grokInsights } : {}),
    ...(existing?.downloadedImages
      ? { downloadedImages: existing.downloadedImages }
      : {}),
    ...(existing?.videoTranscripts
      ? { videoTranscripts: existing.videoTranscripts }
      : {}),
  };
  const p = cachePath(tweetId);
  await fs.writeFile(p, JSON.stringify(envelope, null, 2), "utf8");
  return p;
}

export async function writeDownloadedImages(
  tweetId: string,
  images: DownloadedImage[],
): Promise<void> {
  const existing = await readCache(tweetId);
  if (!existing) return;
  const updated: CacheEnvelope = {
    ...existing,
    downloadedImages: images,
  };
  await fs.writeFile(
    cachePath(tweetId),
    JSON.stringify(updated, null, 2),
    "utf8",
  );
}

export async function writeInsights(
  tweetId: string,
  insights: GrokInsights,
): Promise<void> {
  const existing = await readCache(tweetId);
  if (!existing) {
    throw new Error(`Cannot attach insights: no cache for ${tweetId}`);
  }
  const updated: CacheEnvelope = {
    ...existing,
    grokInsights: {
      fetchedAt: new Date().toISOString(),
      data: insights,
    },
  };
  await fs.writeFile(
    cachePath(tweetId),
    JSON.stringify(updated, null, 2),
    "utf8",
  );
}

export async function writeVideoTranscripts(
  tweetId: string,
  transcripts: Array<{ url: string; text: string }>,
): Promise<void> {
  const existing = await readCache(tweetId);
  if (!existing) return;
  const updated: CacheEnvelope = {
    ...existing,
    videoTranscripts: transcripts,
  };
  await fs.writeFile(
    cachePath(tweetId),
    JSON.stringify(updated, null, 2),
    "utf8",
  );
}

export async function hasCache(tweetId: string): Promise<boolean> {
  try {
    await fs.access(cachePath(tweetId));
    return true;
  } catch {
    return false;
  }
}
