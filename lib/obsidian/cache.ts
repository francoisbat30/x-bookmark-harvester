import { promises as fs } from "node:fs";
import path from "node:path";
import type { GrokInsights, PostExtraction } from "../types";
import type { DownloadedImage } from "./media-download";
import { getVaultConfig, resolveTargetDir } from "./vault";

const CACHE_SUBDIR = ".raw";

export interface CacheEnvelope {
  source: "grok" | "xapi" | "apify";
  fetchedAt: string;
  tweetId: string;
  post: PostExtraction;
  grokInsights?: {
    fetchedAt: string;
    data: GrokInsights;
  };
  downloadedImages?: DownloadedImage[];
}

function cacheDir(): string {
  const base = resolveTargetDir(getVaultConfig());
  return path.join(base, CACHE_SUBDIR);
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
    source,
    fetchedAt: new Date().toISOString(),
    tweetId,
    post,
    ...(existing?.grokInsights ? { grokInsights: existing.grokInsights } : {}),
    ...(existing?.downloadedImages
      ? { downloadedImages: existing.downloadedImages }
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

export async function hasCache(tweetId: string): Promise<boolean> {
  try {
    await fs.access(cachePath(tweetId));
    return true;
  } catch {
    return false;
  }
}
