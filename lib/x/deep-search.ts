/**
 * Deep Search — multi-query Grok expansion + X API v2 /search/recent
 * augmentation + mechanical ranking + optional LLM rerank.
 *
 * Flow:
 *   1. expandQuery       — Grok (no tools)  → 6 sub-queries
 *   2. searchForSubQuery — Grok × 6 parallel with x_search → candidates
 *   3. searchRecentTweets — X API v2 × N in parallel (ground-truth 7d complement)
 *   4. rankCandidates     — dedup by tweetId, mechanical score
 *   5. aggregationRerank  — Grok (no tools) → 1-5 llmScore + rationale
 *   6. markAlreadyCached  — set flag for candidates already in .raw/
 *
 * Cache + history are handled separately in lib/obsidian/deep-search-cache.ts.
 */

import { createHash } from "node:crypto";
import type {
  DeepSearchCandidate,
  DeepSearchFormat,
  DeepSearchResult,
  DeepSearchStats,
} from "../types";
import { hasCache } from "../obsidian/cache";
import { searchRecentTweets } from "./api";
import { callResponses, extractText, stripJsonFences } from "./xai-responses";

/* ───────── config ───────── */

const DEFAULT_SUB_QUERIES = 6;
const DEFAULT_LINKS_PER_SUB = 12;
const MAX_FINAL_CANDIDATES = 50;

// Rough grok-4 cost model. Values are approximate; actual is shown in
// stats.estimatedCost based on call counts.
const COST_EXPAND = 0.02;
const COST_SEARCH_WITH_TOOL = 0.12;
const COST_AGGREGATION = 0.08;

export interface DeepSearchOptions {
  subQueryCount?: number;
  linksPerSubQuery?: number;
  enableAggregationRerank?: boolean;
  bearerToken?: string;
}

export interface DeepSearchArgs {
  naturalQuery: string;
  apiKey: string;
  model?: string;
  options?: DeepSearchOptions;
}

/* ───────── query hash ───────── */

export function hashQuery(query: string, count: number): string {
  return createHash("sha1")
    .update(`${query.trim().toLowerCase()}|${count}`)
    .digest("hex")
    .slice(0, 16);
}

/* ───────── stage 1 : expand ───────── */

const EXPAND_INSTRUCTIONS = `You are a research query planner.

Given a natural-language research theme, decompose it into DISTINCT X (Twitter) search queries that together cover all facets of the theme with maximum recall.

Vary on these axes:
- vocabulary (synonyms, jargon, abbreviations, brand names)
- angle (how-to, review, comparison, release-note, deep-dive)
- content format (thread, long article, single post, official announcement)
- audience (technical experts, casual users, practitioners)

Each query should be 2-6 words, written how a human would type it into X search.

Return JSON exactly:
{ "queries": ["q1", "q2", "q3", ...] }

No prose, no commentary, no markdown fences.`;

export async function expandQuery(
  naturalQuery: string,
  count: number,
  apiKey: string,
  model: string,
): Promise<string[]> {
  const payload = await callResponses({
    apiKey,
    model,
    instructions: EXPAND_INSTRUCTIONS,
    input: `Theme: ${naturalQuery}\n\nGenerate exactly ${count} distinct queries.`,
    tools: [],
    temperature: 0.4,
  });
  const text = extractText(payload);
  if (!text) throw new Error("Grok expansion returned no text");

  const cleaned = stripJsonFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Grok expansion returned invalid JSON: ${cleaned.slice(0, 300)}`);
  }
  const obj = parsed as { queries?: unknown };
  if (!Array.isArray(obj.queries)) {
    throw new Error("Grok expansion missing 'queries' array");
  }
  const queries = obj.queries
    .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    .map((q) => q.trim());
  if (queries.length === 0) {
    throw new Error("Grok expansion returned no usable queries");
  }
  return queries.slice(0, count);
}

/* ───────── stage 2 : parallel Grok search ───────── */

const SEARCH_INSTRUCTIONS = `You are a research assistant maximizing RECALL (not precision).

Use the x_search tool to find X posts, threads, and X Articles relevant to the given topic.

CRITICAL rules:
- Return AT LEAST 10 URLs if available. 20+ is better.
- Do NOT filter for popularity. Include low-engagement posts if substantive.
- Prefer long-form X Articles (URLs containing /i/articles/) and threads of 5+ tweets.
- Do NOT summarize or rank — I rank later.
- For each URL, add a one-line "why" explaining the match.
- "format" must be one of: "post", "thread", "article".

Return JSON exactly:
{
  "links": [
    { "url": "https://x.com/user/status/123", "why": "thread on prompt frameworks", "format": "thread" }
  ]
}

No prose outside JSON.`;

interface GrokSearchLink {
  url: string;
  why: string;
  format: DeepSearchFormat;
}

async function searchForSubQuery(
  subQuery: string,
  linksPerSub: number,
  apiKey: string,
  model: string,
): Promise<GrokSearchLink[]> {
  try {
    const payload = await callResponses({
      apiKey,
      model,
      instructions: SEARCH_INSTRUCTIONS,
      input: `Topic: ${subQuery}\n\nReturn at least ${linksPerSub} links if available.`,
      tools: [{ type: "x_search" }],
      temperature: 0.3,
    });
    const text = extractText(payload);
    if (!text) return [];
    const cleaned = stripJsonFences(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return [];
    }
    const obj = parsed as { links?: unknown };
    if (!Array.isArray(obj.links)) return [];
    return obj.links
      .map((l) => normalizeSearchLink(l))
      .filter((l): l is GrokSearchLink => l !== null);
  } catch (e) {
    console.warn(
      `[deep-search] sub-query "${subQuery}" failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return [];
  }
}

function normalizeSearchLink(raw: unknown): GrokSearchLink | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const url = typeof r.url === "string" ? r.url : "";
  if (!/\/status(?:es)?\/\d+/.test(url) && !/\/i\/articles\/\d+/.test(url)) {
    return null;
  }
  const why = typeof r.why === "string" ? r.why : "";
  const fmtRaw = typeof r.format === "string" ? r.format.toLowerCase() : "";
  const format: DeepSearchFormat =
    fmtRaw === "thread" || fmtRaw === "article" ? fmtRaw : "post";
  return { url, why, format };
}

/* ───────── stage 3 : X API v2 augmentation ───────── */

async function augmentWithXApi(
  queries: string[],
  bearerToken: string,
  maxPerQuery: number,
): Promise<DeepSearchCandidate[]> {
  const out: DeepSearchCandidate[] = [];
  const results = await Promise.all(
    queries.map((q) =>
      searchRecentTweets(q, bearerToken, maxPerQuery).catch((e) => {
        console.warn(
          `[deep-search] X API search "${q}" failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return [] as DeepSearchCandidate[];
      }),
    ),
  );
  for (let i = 0; i < results.length; i++) {
    const subQuery = queries[i];
    for (const c of results[i]) {
      c.foundBy = [subQuery];
      out.push(c);
    }
  }
  return out;
}

/* ───────── stage 4 : dedup + mechanical rank ───────── */

function tweetIdFromUrl(url: string): string | null {
  const m = url.match(/status(?:es)?\/(\d+)/);
  if (m) return m[1];
  const art = url.match(/\/i\/articles\/(\d+)/);
  return art ? art[1] : null;
}

function authorFromUrl(url: string): string {
  const m = url.match(/x\.com\/([^/]+)\/status/);
  return m ? m[1] : "";
}

function mechanicalScore(c: DeepSearchCandidate): number {
  const m = c.metrics ?? { likes: 0, retweets: 0, replies: 0 };
  const log1p = (n: number) => Math.log((n ?? 0) + 1);
  const foundByBoost = c.foundBy.length * 10;
  const engagementScore =
    log1p(m.likes) * 2 + log1p(m.retweets) * 4 + log1p(m.replies) * 3;
  const formatBoost =
    c.format === "article" ? 15 : c.format === "thread" ? 8 : 0;
  const cachedPenalty = c.alreadyCached ? 5 : 0;
  return foundByBoost + engagementScore + formatBoost - cachedPenalty;
}

function rankCandidates(
  grokLinksBySubQuery: Array<{ subQuery: string; links: GrokSearchLink[] }>,
  xapiCandidates: DeepSearchCandidate[],
): DeepSearchCandidate[] {
  const byId = new Map<string, DeepSearchCandidate>();

  // Grok results
  for (const { subQuery, links } of grokLinksBySubQuery) {
    for (const link of links) {
      const id = tweetIdFromUrl(link.url);
      if (!id) continue;
      const existing = byId.get(id);
      if (existing) {
        if (!existing.foundBy.includes(subQuery)) {
          existing.foundBy.push(subQuery);
        }
        if (existing.source === "xapi") existing.source = "both";
        if (!existing.rationale && link.why) existing.rationale = link.why;
        continue;
      }
      byId.set(id, {
        tweetId: id,
        url: link.url,
        authorHandle: authorFromUrl(link.url),
        authorName: "",
        text: "",
        date: "",
        format: link.format,
        metrics: null,
        foundBy: [subQuery],
        source: "grok",
        rationale: link.why,
        mechanicalScore: 0,
        finalScore: 0,
        alreadyCached: false,
      });
    }
  }

  // X API results (merge or add)
  for (const c of xapiCandidates) {
    const existing = byId.get(c.tweetId);
    if (existing) {
      existing.metrics = existing.metrics ?? c.metrics;
      existing.text = existing.text || c.text;
      existing.date = existing.date || c.date;
      existing.authorHandle = existing.authorHandle || c.authorHandle;
      existing.authorName = existing.authorName || c.authorName;
      for (const q of c.foundBy) {
        if (!existing.foundBy.includes(q)) existing.foundBy.push(q);
      }
      existing.source = "both";
    } else {
      byId.set(c.tweetId, { ...c, source: "xapi" });
    }
  }

  const all = [...byId.values()];
  for (const c of all) {
    c.mechanicalScore = mechanicalScore(c);
    c.finalScore = c.mechanicalScore;
  }
  all.sort((a, b) => b.finalScore - a.finalScore);
  return all.slice(0, MAX_FINAL_CANDIDATES);
}

/* ───────── stage 5 : aggregation rerank ───────── */

const AGGREGATION_INSTRUCTIONS = `You are a research curator.

Given a theme and a list of candidate X posts, re-rank them by TRUE relevance to the theme. Consider information density, depth, format, and whether the content directly addresses the theme (vs tangential mentions).

For each candidate, assign:
- "score": integer 1-5 (5 = essential, 1 = barely relevant)
- "rationale": one line (<= 120 chars) explaining why

Return JSON exactly:
{ "ranked": [{ "tweetId": "123", "score": 5, "rationale": "why" }, ...] }

Do NOT add candidates. Do NOT drop candidates. Keep the same tweetId values. No prose.`;

interface AggregatedEntry {
  tweetId: string;
  score: number;
  rationale: string;
}

async function aggregationRerank(
  theme: string,
  candidates: DeepSearchCandidate[],
  apiKey: string,
  model: string,
): Promise<void> {
  if (candidates.length === 0) return;
  const slim = candidates.map((c) => ({
    tweetId: c.tweetId,
    author: c.authorHandle,
    text: c.text.slice(0, 200),
    format: c.format,
    foundBy: c.foundBy,
    metrics: c.metrics,
  }));
  try {
    const payload = await callResponses({
      apiKey,
      model,
      instructions: AGGREGATION_INSTRUCTIONS,
      input: `Theme: ${theme}\n\nCandidates:\n${JSON.stringify(slim)}\n\nRe-rank all ${slim.length} candidates.`,
      tools: [],
      temperature: 0.2,
    });
    const text = extractText(payload);
    if (!text) return;
    const cleaned = stripJsonFences(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return;
    }
    const obj = parsed as { ranked?: unknown };
    if (!Array.isArray(obj.ranked)) return;
    const llmMap = new Map<string, AggregatedEntry>();
    for (const raw of obj.ranked) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const tweetId = typeof r.tweetId === "string" ? r.tweetId : "";
      if (!tweetId) continue;
      const score =
        typeof r.score === "number" && Number.isFinite(r.score) ? r.score : 0;
      const rationale =
        typeof r.rationale === "string" ? r.rationale : "";
      llmMap.set(tweetId, { tweetId, score, rationale });
    }
    for (const c of candidates) {
      const m = llmMap.get(c.tweetId);
      if (!m) continue;
      c.llmScore = Math.max(1, Math.min(5, Math.round(m.score)));
      if (m.rationale) c.rationale = m.rationale;
      c.finalScore = c.mechanicalScore + c.llmScore * 5;
    }
    candidates.sort((a, b) => b.finalScore - a.finalScore);
  } catch (e) {
    console.warn(
      `[deep-search] aggregation rerank failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/* ───────── stage 6 : already-cached flag ───────── */

async function markAlreadyCached(
  candidates: DeepSearchCandidate[],
): Promise<void> {
  await Promise.all(
    candidates.map(async (c) => {
      c.alreadyCached = await hasCache(c.tweetId);
    }),
  );
}

/* ───────── entry point ───────── */

export async function runDeepSearch(
  args: DeepSearchArgs,
): Promise<DeepSearchResult> {
  const startedAt = Date.now();
  const model = args.model ?? "grok-4";
  const count = args.options?.subQueryCount ?? DEFAULT_SUB_QUERIES;
  const linksPerSub = args.options?.linksPerSubQuery ?? DEFAULT_LINKS_PER_SUB;
  const enableRerank = args.options?.enableAggregationRerank ?? true;

  let grokCallCount = 0;
  let xApiCallCount = 0;
  let estimatedCost = 0;

  // 1. Expand
  const subQueries = await expandQuery(
    args.naturalQuery,
    count,
    args.apiKey,
    model,
  );
  grokCallCount += 1;
  estimatedCost += COST_EXPAND;

  // 2. Parallel Grok search
  const grokResults = await Promise.all(
    subQueries.map(async (subQuery) => ({
      subQuery,
      links: await searchForSubQuery(subQuery, linksPerSub, args.apiKey, model),
    })),
  );
  grokCallCount += subQueries.length;
  estimatedCost += COST_SEARCH_WITH_TOOL * subQueries.length;

  // 3. X API v2 augmentation (optional — only when bearer provided)
  let xapiCandidates: DeepSearchCandidate[] = [];
  if (args.options?.bearerToken) {
    xapiCandidates = await augmentWithXApi(
      [args.naturalQuery, ...subQueries],
      args.options.bearerToken,
      20,
    );
    xApiCallCount += subQueries.length + 1;
  }

  // 4. Dedup + mechanical rank
  const ranked = rankCandidates(grokResults, xapiCandidates);

  // 5. Aggregation rerank
  if (enableRerank && ranked.length > 0) {
    await aggregationRerank(args.naturalQuery, ranked, args.apiKey, model);
    grokCallCount += 1;
    estimatedCost += COST_AGGREGATION;
  }

  // 6. alreadyCached flags
  await markAlreadyCached(ranked);

  const stats: DeepSearchStats = {
    grokCallCount,
    xApiCallCount,
    estimatedCost: Math.round(estimatedCost * 100) / 100,
    elapsedMs: Date.now() - startedAt,
  };

  return {
    ok: true,
    queryHash: hashQuery(args.naturalQuery, count),
    query: args.naturalQuery,
    createdAt: new Date().toISOString(),
    fromCache: false,
    subQueries,
    candidates: ranked,
    stats,
  };
}
