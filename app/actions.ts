"use server";

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { extractPostWithXApi } from "@/lib/x/api";
import { extractPostWithGrok } from "@/lib/x/grok-extract";
import { fetchGrokInsights } from "@/lib/x/grok-enrich";
import { parseTweetRef } from "@/lib/x/tweet-id";
import { downloadImages } from "@/lib/obsidian/media-download";
import { renderNote } from "@/lib/obsidian/markdown";
import {
  writeNote,
  resolveTargetDir,
  getVaultConfig,
} from "@/lib/obsidian/vault";
import {
  readCache,
  writeCache,
  writeDownloadedImages,
  writeInsights,
} from "@/lib/obsidian/cache";
import type {
  ExtractError,
  ExtractResult,
  GrokEnrichResult,
  PostComment,
  PostExtraction,
  RetryCommentsResult,
} from "@/lib/types";

function detectStaleComments(post: PostExtraction): boolean {
  return post.comments.length === 0 && post.metrics.replies > 0;
}

function commentKey(c: PostComment): string {
  const normalized = `${c.handle.toLowerCase()}|${c.text.replace(/\s+/g, " ").trim()}`;
  return createHash("sha1").update(normalized).digest("hex");
}

function mergeComments(
  existing: PostComment[],
  incoming: PostComment[],
): PostComment[] {
  const seen = new Set<string>(existing.map(commentKey));
  const merged = [...existing];
  for (const c of incoming) {
    const k = commentKey(c);
    if (!seen.has(k)) {
      seen.add(k);
      merged.push(c);
    }
  }
  return merged;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function extractBookmark(
  _prev: ExtractResult | ExtractError | null,
  formData: FormData,
): Promise<ExtractResult | ExtractError> {
  const rawUrl = String(formData.get("url") ?? "").trim();
  const refetch = formData.get("refetch") === "on";

  if (!rawUrl) {
    return { ok: false, error: "URL is required" };
  }
  const ref = parseTweetRef(rawUrl);
  if (!ref) {
    return { ok: false, error: "Not a valid X / Twitter post URL" };
  }

  try {
    if (!refetch) {
      const cached = await readCache(ref.id);
      if (cached) {
        const note = renderNote(cached.post, {
          insights: cached.grokInsights?.data,
          downloadedImages: cached.downloadedImages,
        });
        const dir = resolveTargetDir(getVaultConfig());
        const mdPath = path.join(dir, note.filename);
        const mdExists = await fileExists(mdPath);

        if (mdExists) {
          return {
            ok: true,
            isDuplicate: true,
            filename: note.filename,
            absolutePath: mdPath,
            source: "cache",
            cachedAt: cached.fetchedAt,
            staleCommentsDetected: detectStaleComments(cached.post),
          };
        }

        const written = await writeNote(note.filename, note.content, undefined, {
          overwrite: true,
          uniqueKey: ref.id,
        });
        return {
          ok: true,
          isDuplicate: false,
          filename: written.filename,
          absolutePath: written.absolutePath,
          source: "cache",
          cachedAt: cached.fetchedAt,
          staleCommentsDetected: detectStaleComments(cached.post),
        };
      }
    }

    const bearer = process.env.X_API_BEARER_TOKEN;
    if (!bearer) {
      return {
        ok: false,
        error: "X_API_BEARER_TOKEN is not set in .env.local",
      };
    }
    const post: PostExtraction = await extractPostWithXApi(ref.id, {
      bearerToken: bearer,
    });
    await writeCache(ref.id, post, "xapi");

    const downloaded = await downloadImages(ref.id, post.media);
    if (downloaded.length > 0) {
      await writeDownloadedImages(ref.id, downloaded);
    }

    const freshCache = await readCache(ref.id);
    const note = renderNote(post, {
      insights: freshCache?.grokInsights?.data,
      downloadedImages: freshCache?.downloadedImages,
    });
    const written = await writeNote(note.filename, note.content, undefined, {
      overwrite: true,
      uniqueKey: ref.id,
    });

    return {
      ok: true,
      isDuplicate: false,
      filename: written.filename,
      absolutePath: written.absolutePath,
      source: "xapi",
      staleCommentsDetected: detectStaleComments(post),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export async function retryCommentsWithGrok(
  tweetId: string,
): Promise<RetryCommentsResult | ExtractError> {
  if (!tweetId || !/^\d+$/.test(tweetId)) {
    return { ok: false, error: "Invalid tweet ID" };
  }

  const cached = await readCache(tweetId);
  if (!cached) {
    return {
      ok: false,
      error: "No cache for this tweet — run the main extraction first",
    };
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "XAI_API_KEY is not set in .env.local" };
  }

  const commentsBefore = cached.post.comments.length;

  try {
    const grokPost = await extractPostWithGrok(cached.post.url, {
      apiKey,
      model: process.env.XAI_MODEL,
    });

    if (grokPost.text.startsWith("ERROR:")) {
      return {
        ok: false,
        error: `Grok could not read post — ${grokPost.text}`,
      };
    }

    const mergedComments = mergeComments(
      cached.post.comments,
      grokPost.comments,
    );

    const updatedPost: PostExtraction = {
      ...cached.post,
      comments: mergedComments,
    };

    await writeCache(tweetId, updatedPost, cached.source);

    const freshCache = await readCache(tweetId);
    const note = renderNote(updatedPost, {
      insights: freshCache?.grokInsights?.data,
      downloadedImages: freshCache?.downloadedImages,
    });
    const written = await writeNote(note.filename, note.content, undefined, {
      overwrite: true,
      uniqueKey: tweetId,
    });

    return {
      ok: true,
      tweetId,
      filename: written.filename,
      absolutePath: written.absolutePath,
      commentsBefore,
      commentsAfter: mergedComments.length,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export async function enrichWithGrok(
  tweetId: string,
): Promise<GrokEnrichResult | ExtractError> {
  if (!tweetId || !/^\d+$/.test(tweetId)) {
    return { ok: false, error: "Invalid tweet ID" };
  }

  const cached = await readCache(tweetId);
  if (!cached) {
    return {
      ok: false,
      error: "No cache for this tweet — run the main extraction first",
    };
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: "XAI_API_KEY is not set in .env.local" };
  }

  try {
    const url = cached.post.url || `https://x.com/i/status/${tweetId}`;
    const insights = await fetchGrokInsights(url, {
      apiKey,
      model: process.env.XAI_MODEL,
    });

    if (insights.author_additions?.startsWith("ERROR:")) {
      return {
        ok: false,
        error: `Grok could not analyze the post — ${insights.author_additions}`,
      };
    }

    await writeInsights(tweetId, insights);

    const note = renderNote(cached.post, {
      insights,
      downloadedImages: cached.downloadedImages,
    });
    const written = await writeNote(note.filename, note.content, undefined, {
      overwrite: true,
      uniqueKey: tweetId,
    });

    return {
      ok: true,
      tweetId,
      filename: written.filename,
      absolutePath: written.absolutePath,
      insights,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
