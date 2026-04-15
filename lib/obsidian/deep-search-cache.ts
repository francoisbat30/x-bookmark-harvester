/**
 * Deep Search result cache + history.
 *
 * Stored as `<vaultDir>/.deepsearch/<queryHash>.json`, one file per
 * unique (query + subQueryCount) pair. A 2-hour TTL avoids paying Grok
 * twice for an identical query while the user iterates on a theme.
 *
 * `listDeepSearchHistory` powers the UI history drawer and the CLI
 * skill. `delete` is wired to the "Delete" button in the UI.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  DeepSearchCandidate,
  DeepSearchHistoryEntry,
  DeepSearchStats,
} from "../types";
import { getVaultConfig, resolveTargetDir } from "./vault";

const CACHE_SUBDIR = ".deepsearch";
const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface DeepSearchCacheEnvelope {
  version: 1;
  queryHash: string;
  query: string;
  subQueryCount: number;
  createdAt: string;
  lastAccessedAt: string;
  subQueries: string[];
  candidates: DeepSearchCandidate[];
  stats: DeepSearchStats;
}

function cacheDir(): string {
  return path.join(resolveTargetDir(getVaultConfig()), CACHE_SUBDIR);
}

function cachePath(queryHash: string): string {
  return path.join(cacheDir(), `${queryHash}.json`);
}

export async function readDeepSearchCache(
  queryHash: string,
): Promise<DeepSearchCacheEnvelope | null> {
  try {
    const raw = await fs.readFile(cachePath(queryHash), "utf8");
    const parsed = JSON.parse(raw) as DeepSearchCacheEnvelope;
    if (!parsed || parsed.version !== 1) return null;
    const age = Date.now() - new Date(parsed.createdAt).getTime();
    if (age > TTL_MS) return null;
    return parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

export async function writeDeepSearchCache(
  envelope: DeepSearchCacheEnvelope,
): Promise<void> {
  await fs.mkdir(cacheDir(), { recursive: true });
  const tmp = cachePath(envelope.queryHash) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(envelope, null, 2), "utf8");
  await fs.rename(tmp, cachePath(envelope.queryHash));
}

export async function touchDeepSearchCache(queryHash: string): Promise<void> {
  try {
    const raw = await fs.readFile(cachePath(queryHash), "utf8");
    const parsed = JSON.parse(raw) as DeepSearchCacheEnvelope;
    parsed.lastAccessedAt = new Date().toISOString();
    await fs.writeFile(
      cachePath(queryHash),
      JSON.stringify(parsed, null, 2),
      "utf8",
    );
  } catch {
    // ignore
  }
}

export async function deleteDeepSearchCache(queryHash: string): Promise<void> {
  try {
    await fs.unlink(cachePath(queryHash));
  } catch {
    // already gone
  }
}

export async function listDeepSearchHistory(): Promise<
  DeepSearchHistoryEntry[]
> {
  let entries: string[];
  try {
    entries = await fs.readdir(cacheDir());
  } catch {
    return [];
  }
  const out: DeepSearchHistoryEntry[] = [];
  for (const entry of entries) {
    if (!/^[a-f0-9]+\.json$/.test(entry)) continue;
    try {
      const raw = await fs.readFile(path.join(cacheDir(), entry), "utf8");
      const parsed = JSON.parse(raw) as DeepSearchCacheEnvelope;
      if (!parsed || parsed.version !== 1) continue;
      out.push({
        queryHash: parsed.queryHash,
        query: parsed.query,
        createdAt: parsed.createdAt,
        lastAccessedAt: parsed.lastAccessedAt,
        candidateCount: parsed.candidates.length,
        estimatedCost: parsed.stats.estimatedCost,
      });
    } catch {
      // skip malformed
    }
  }
  out.sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return out;
}
