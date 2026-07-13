/**
 * Source chain for extracting a single X post.
 *
 * PRIORITY (documented contract):
 *   1. PRIMARY sources, tried in order:
 *        - "mcp"  — official X MCP server, only when explicitly enabled
 *                   (ctx.mcp?.enabled). Sondé le 2026-07-12 : wrapper des
 *                   mêmes endpoints v2 (sans media.fields) → on n'investit
 *                   pas, le seam reste par prudence. Off by default.
 *        - "xapi" — direct X API v2 (the proven default).
 *   2. FALLBACK: "grok" — used when NO primary produced a *complete* post,
 *      i.e. the primary threw, or returned an incomplete post (missing text /
 *      author / comments). Grok either replaces a wholly-failed primary, or
 *      fills the gaps of a usable-but-incomplete primary (comments especially).
 *
 * "Complete" = has text AND author handle AND (no missing comments). Missing
 * comments is detected as detectStaleComments(): the post advertises replies
 * (metrics.replies > 0) but none were extracted. Depuis le passage à
 * /search/all (pay-per-use), ce cas devient rare — le fallback reste un filet
 * de sécurité (post supprimé/protégé, panne API).
 *
 * COST: sync only runs this for tweets not already cached (hasCache), so the
 * Grok fallback is paid at most once per tweet, never on every sync.
 */
import { createHash } from "node:crypto";
import type { PostComment, PostExtraction } from "../types";
import { extractPostWithXApi } from "./api";
import { extractPostWithGrok } from "./grok-extract";
import type { McpSourceConfig } from "./mcp-source";
import { mcpSource } from "./mcp-source";

export type SourceName = "xapi" | "mcp" | "grok";

export interface ExtractContext {
  /** Canonical post URL, used by the Grok fallback (which reads by URL). */
  url: string;
  bearerToken?: string;
  grokApiKey?: string;
  grokModel?: string;
  mcp?: McpSourceConfig;
  /**
   * Profondeur de recherche (mode léger du triage : 0/0 = lookup seul,
   * pas de recherche thread ni commentaires — ~$0.005 le post).
   */
  searchDepth?: { commentPages: number; threadPages: number };
}

export interface ExtractResult {
  post: PostExtraction;
  /** Provider of the post's text (the "base"). */
  source: SourceName;
  /** Sources consulted, in order — for diagnostics/logging. */
  trace: SourceName[];
  /**
   * Non-fatal source failures (a primary threw, the Grok fallback failed…).
   * Surfaced by callers in their summary instead of dying in console.warn —
   * indispensable pour un sync headless (routine du lundi, relais Telegram).
   */
  warnings: string[];
}

export interface PostSource {
  name: SourceName;
  extract(id: string, ctx: ExtractContext): Promise<PostExtraction>;
}

/* ───────── completeness heuristics ───────── */

function hasText(post: PostExtraction): boolean {
  const t = post.text?.trim() ?? "";
  return t.length > 0 && !t.startsWith("ERROR:");
}

function hasAuthor(post: PostExtraction): boolean {
  return (post.author?.handle ?? "").trim().length > 0;
}

/**
 * True when the post claims replies (metrics.replies > 0) but none were
 * extracted — the signature of a post outside the X recent-search window.
 * Shared with app/actions.ts.
 */
export function detectStaleComments(post: PostExtraction): boolean {
  return post.comments.length === 0 && post.metrics.replies > 0;
}

function isComplete(post: PostExtraction): boolean {
  return hasText(post) && hasAuthor(post) && !detectStaleComments(post);
}

/* ───────── comment merge (shared with app/actions.ts) ───────── */

export function commentKey(c: PostComment): string {
  const normalized = `${c.handle.toLowerCase()}|${c.text.replace(/\s+/g, " ").trim()}`;
  return createHash("sha1").update(normalized).digest("hex");
}

export function mergeComments(
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

/* ───────── sources ───────── */

const xapiSource: PostSource = {
  name: "xapi",
  extract: (id, ctx) => {
    if (!ctx.bearerToken) {
      throw new Error("xapi source requires a bearerToken");
    }
    return extractPostWithXApi(id, {
      bearerToken: ctx.bearerToken,
      ...(ctx.searchDepth
        ? {
            maxCommentPages: ctx.searchDepth.commentPages,
            maxThreadPages: ctx.searchDepth.threadPages,
          }
        : {}),
    });
  },
};

/** Primary sources in priority order for this context. */
function buildPrimarySources(ctx: ExtractContext): PostSource[] {
  const sources: PostSource[] = [];
  if (ctx.mcp?.enabled) sources.push(mcpSource);
  if (ctx.bearerToken) sources.push(xapiSource);
  return sources;
}

/* ───────── orchestrator ───────── */

export async function extractPost(
  id: string,
  ctx: ExtractContext,
): Promise<ExtractResult> {
  const trace: SourceName[] = [];
  const warnings: string[] = [];
  let base: { post: PostExtraction; source: SourceName } | null = null;

  for (const src of buildPrimarySources(ctx)) {
    trace.push(src.name);
    try {
      const post = await src.extract(id, ctx);
      if (hasText(post) && hasAuthor(post)) {
        base = { post, source: src.name };
        // Complete → done. Incomplete (missing comments) → keep as base and
        // let Grok fill the gaps below.
        if (isComplete(post)) return { post, source: src.name, trace, warnings };
        break;
      }
      // No usable text/author → treat as a miss, try the next primary.
      warnings.push(`source "${src.name}" returned no usable text/author`);
    } catch (e) {
      const msg = `source "${src.name}" failed: ${e instanceof Error ? e.message : String(e)}`;
      warnings.push(msg);
      console.warn(`[extract] ${msg} (${id})`);
    }
  }

  // Fallback / gap-fill with Grok.
  if (ctx.grokApiKey) {
    trace.push("grok");
    try {
      const grokPost = await extractPostWithGrok(ctx.url, {
        apiKey: ctx.grokApiKey,
        model: ctx.grokModel,
      });
      if (hasText(grokPost)) {
        if (!base) {
          return { post: grokPost, source: "grok", trace, warnings };
        }
        // Keep the primary as the base (more reliable metrics/media) and fill
        // the gap that triggered the fallback: comments, plus media if absent.
        const merged: PostExtraction = {
          ...base.post,
          comments: mergeComments(base.post.comments, grokPost.comments),
          media: base.post.media.length ? base.post.media : grokPost.media,
        };
        return { post: merged, source: base.source, trace, warnings };
      }
      warnings.push(
        `grok fallback returned no usable text${grokPost.text?.startsWith("ERROR:") ? ` (${grokPost.text.slice(0, 120)})` : ""}`,
      );
    } catch (e) {
      const msg = `grok fallback failed: ${e instanceof Error ? e.message : String(e)}`;
      warnings.push(msg);
      console.warn(`[extract] ${msg} (${id})`);
    }
  }

  if (base) return { post: base.post, source: base.source, trace, warnings };
  throw new Error(
    `All sources failed for tweet ${id} (tried: ${trace.join(", ") || "none"})`,
  );
}
