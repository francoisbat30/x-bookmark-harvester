/**
 * Deep Search — multi-query Grok expansion + X API bulk validation +
 * mechanical ranking + optional LLM rerank + time-range filter.
 *
 * Pipeline:
 *   1. expandQuery       — Grok no-tools → 6 sub-queries (time hint baked in)
 *   2. searchForSubQuery — Grok × 6 parallel with x_search, max-recall prompt
 *   3. bulkLookupTweets  — X API /2/tweets?ids=... to validate every tweet ID
 *                          returned by Grok. Hallucinated IDs (the ones X
 *                          doesn't know about) are dropped. Real tweets get
 *                          text + date + author + metrics + accurate format.
 *   4. rankCandidates    — mechanical score (engagement + format + foundBy)
 *   5. aggregationRerank — Grok no-tools, 1-5 score + one-line rationale
 *   6. timeRange filter  — drop candidates older than the user's window
 *   7. alreadyCached     — flag against .raw/ and deprioritize
 */

import { createHash } from "node:crypto";
import type {
  DeepSearchCandidate,
  DeepSearchFormat,
  DeepSearchResult,
  DeepSearchStats,
  DeepSearchTimeRange,
} from "../types";
import { hasCache } from "../obsidian/cache";
import { bulkLookupTweets } from "./api";
import { callResponses, extractText, stripJsonFences } from "./xai-responses";

/* ───────── config ───────── */

const DEFAULT_SUB_QUERIES = 6;
const DEFAULT_LINKS_PER_SUB = 12;
const MAX_FINAL_CANDIDATES = 40;

const COST_EXPAND = 0.02;
const COST_SEARCH_WITH_TOOL = 0.12;
const COST_AGGREGATION = 0.08;

export interface DeepSearchOptions {
  subQueryCount?: number;
  linksPerSubQuery?: number;
  enableAggregationRerank?: boolean;
  /** Bearer token for /2/tweets bulk lookup (required for validation). */
  bearerToken?: string;
  /** Time window filter. Defaults to "all". */
  timeRange?: DeepSearchTimeRange;
}

export interface DeepSearchArgs {
  naturalQuery: string;
  apiKey: string;
  model?: string;
  options?: DeepSearchOptions;
}

/* ───────── time range helpers ───────── */

const TIME_RANGE_DAYS: Record<DeepSearchTimeRange, number | null> = {
  all: null,
  year: 365,
  "6months": 180,
  "3months": 90,
  month: 30,
  week: 7,
};

const TIME_RANGE_LABEL: Record<DeepSearchTimeRange, string> = {
  all: "any time",
  year: "the past 12 months",
  "6months": "the past 6 months",
  "3months": "the past 3 months",
  month: "the past 30 days",
  week: "the past 7 days",
};

function timeRangeThresholdIso(range: DeepSearchTimeRange): string | null {
  const days = TIME_RANGE_DAYS[range];
  if (!days) return null;
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/* ───────── query hash (cache key) ───────── */

export function hashQuery(
  query: string,
  count: number,
  timeRange: DeepSearchTimeRange = "all",
): string {
  return createHash("sha1")
    .update(`${query.trim().toLowerCase()}|${count}|${timeRange}`)
    .digest("hex")
    .slice(0, 16);
}

/* ───────── stage 1 : expand ───────── */

function buildExpandInstructions(timeRange: DeepSearchTimeRange): string {
  const freshness =
    timeRange === "all"
      ? ""
      : `\n- Prioritize recent content from ${TIME_RANGE_LABEL[timeRange]}. Include date-sensitive terms (year, version numbers, "new", "2026") where relevant.`;
  return `You are a research query planner.

Given a natural-language research theme, decompose it into DISTINCT X (Twitter) search queries that together cover all facets of the theme with maximum recall.

Vary on these axes:
- vocabulary (synonyms, jargon, abbreviations, brand names)
- angle (how-to, review, comparison, release-note, deep-dive)
- content format (thread, long article, single post, official announcement)
- audience (technical experts, casual users, practitioners)${freshness}

Each query should be 2-6 words, written how a human would type it into X search.

Return JSON exactly:
{ "queries": ["q1", "q2", "q3", ...] }

No prose, no commentary, no markdown fences.`;
}

export async function expandQuery(
  naturalQuery: string,
  count: number,
  apiKey: string,
  model: string,
  timeRange: DeepSearchTimeRange = "all",
): Promise<string[]> {
  const payload = await callResponses({
    apiKey,
    model,
    instructions: buildExpandInstructions(timeRange),
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
    throw new Error(
      `Grok expansion returned invalid JSON: ${cleaned.slice(0, 300)}`,
    );
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

function buildSearchInstructions(timeRange: DeepSearchTimeRange): string {
  const freshness =
    timeRange === "all"
      ? ""
      : `\n- Strongly prefer content published in ${TIME_RANGE_LABEL[timeRange]}. Older content is acceptable only if it's canonical reference material.`;
  return `You are a research assistant maximizing RECALL (not precision).

Use the x_search tool to find X posts, threads, and X Articles relevant to the given topic.

CRITICAL rules:
- Return AT LEAST 10 URLs if available. 15+ is better.
- Only return tweets you have actually observed via x_search. NEVER fabricate tweet IDs, authors, or URLs.
- Do NOT filter for popularity. Include low-engagement posts if substantive.
- Strongly prefer long-form X Articles (URLs containing /i/articles/) and threads of 5+ tweets.
- Do NOT summarize or rank — I rank later.
- For each URL, add a one-line "why" explaining the match.
- "format" must be one of: "post", "thread", "article".${freshness}

Return JSON exactly:
{
  "links": [
    { "url": "https://x.com/user/status/123", "why": "thread on prompt frameworks", "format": "thread" }
  ]
}

No prose outside JSON.`;
}

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
  timeRange: DeepSearchTimeRange,
): Promise<GrokSearchLink[]> {
  try {
    const payload = await callResponses({
      apiKey,
      model,
      instructions: buildSearchInstructions(timeRange),
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

function tweetIdFromUrl(url: string): string | null {
  const m = url.match(/status(?:es)?\/(\d+)/);
  if (m) return m[1];
  const art = url.match(/\/i\/articles\/(\d+)/);
  return art ? art[1] : null;
}

/* ───────── stage 3 : bulk validation + enrichment ───────── */

async function validateAndEnrich(
  grokLinksBySubQuery: Array<{ subQuery: string; links: GrokSearchLink[] }>,
  bearerToken: string,
): Promise<{
  candidates: DeepSearchCandidate[];
  hallucinatedCount: number;
  xApiCallCount: number;
}> {
  // Collect (id → grok metadata) and (id → foundBy[])
  const grokMeta = new Map<
    string,
    { link: GrokSearchLink; foundBy: string[] }
  >();
  for (const { subQuery, links } of grokLinksBySubQuery) {
    for (const link of links) {
      const id = tweetIdFromUrl(link.url);
      if (!id) continue;
      const existing = grokMeta.get(id);
      if (existing) {
        if (!existing.foundBy.includes(subQuery)) {
          existing.foundBy.push(subQuery);
        }
        // Keep the longer rationale
        if (link.why.length > existing.link.why.length) {
          existing.link = link;
        }
      } else {
        grokMeta.set(id, { link, foundBy: [subQuery] });
      }
    }
  }

  const allIds = Array.from(grokMeta.keys());
  if (allIds.length === 0) {
    return { candidates: [], hallucinatedCount: 0, xApiCallCount: 0 };
  }

  const { enriched, missingIds } = await bulkLookupTweets(allIds, bearerToken);
  // 1 batch per 100 IDs
  const xApiCallCount = Math.max(1, Math.ceil(allIds.length / 100));

  // Merge: only keep IDs that X confirmed. Populate Grok metadata on top.
  const candidates: DeepSearchCandidate[] = [];
  for (const [id, cand] of enriched) {
    const meta = grokMeta.get(id);
    if (!meta) continue;
    cand.foundBy = meta.foundBy;
    // Prefer the accurate format from bulk lookup, but if X said "post"
    // and Grok said "thread", trust Grok (it may have seen the actual
    // reply chain we can't reconstruct from a single tweet).
    if (cand.format === "post" && meta.link.format === "thread") {
      cand.format = "thread";
    }
    cand.rationale = meta.link.why;
    cand.source = "grok"; // Grok found it, xapi validated it
    candidates.push(cand);
  }

  return {
    candidates,
    hallucinatedCount: missingIds.size,
    xApiCallCount,
  };
}

/* ───────── stage 4 : mechanical rank ───────── */

function mechanicalScore(c: DeepSearchCandidate): number {
  const m = c.metrics ?? { likes: 0, retweets: 0, replies: 0 };
  const log1p = (n: number) => Math.log((n ?? 0) + 1);
  const foundByBoost = c.foundBy.length * 10;
  const engagementScore =
    log1p(m.likes) * 2 + log1p(m.retweets) * 4 + log1p(m.replies) * 3;
  const formatBoost =
    c.format === "article" ? 25 : c.format === "thread" ? 10 : 0;
  const cachedPenalty = c.alreadyCached ? 5 : 0;
  return foundByBoost + engagementScore + formatBoost - cachedPenalty;
}

function rankCandidates(
  candidates: DeepSearchCandidate[],
): DeepSearchCandidate[] {
  for (const c of candidates) {
    c.mechanicalScore = mechanicalScore(c);
    c.finalScore = c.mechanicalScore;
  }
  candidates.sort((a, b) => b.finalScore - a.finalScore);
  return candidates.slice(0, MAX_FINAL_CANDIDATES);
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
    const llmMap = new Map<
      string,
      { score: number; rationale: string }
    >();
    for (const raw of obj.ranked) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const tweetId = typeof r.tweetId === "string" ? r.tweetId : "";
      if (!tweetId) continue;
      const score =
        typeof r.score === "number" && Number.isFinite(r.score) ? r.score : 0;
      const rationale = typeof r.rationale === "string" ? r.rationale : "";
      llmMap.set(tweetId, { score, rationale });
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

/* ───────── stage 6 : time range filter ───────── */

function applyTimeRange(
  candidates: DeepSearchCandidate[],
  timeRange: DeepSearchTimeRange,
): { kept: DeepSearchCandidate[]; dropped: number } {
  const threshold = timeRangeThresholdIso(timeRange);
  if (!threshold) return { kept: candidates, dropped: 0 };
  const kept: DeepSearchCandidate[] = [];
  let dropped = 0;
  for (const c of candidates) {
    // Keep candidates without a date (shouldn't happen after bulk lookup)
    if (!c.date) {
      kept.push(c);
      continue;
    }
    if (c.date >= threshold) {
      kept.push(c);
    } else {
      dropped++;
    }
  }
  return { kept, dropped };
}

/* ───────── stage 7 : already-cached flag ───────── */

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
  const timeRange: DeepSearchTimeRange = args.options?.timeRange ?? "all";
  const bearerToken = args.options?.bearerToken;

  if (!bearerToken) {
    throw new Error(
      "Deep Search requires X_API_BEARER_TOKEN for validation. Set it in .env.local.",
    );
  }

  let grokCallCount = 0;
  let xApiCallCount = 0;
  let estimatedCost = 0;

  // 1. Expand
  const subQueries = await expandQuery(
    args.naturalQuery,
    count,
    args.apiKey,
    model,
    timeRange,
  );
  grokCallCount += 1;
  estimatedCost += COST_EXPAND;

  // 2. Parallel Grok search
  const grokResults = await Promise.all(
    subQueries.map(async (subQuery) => ({
      subQuery,
      links: await searchForSubQuery(
        subQuery,
        linksPerSub,
        args.apiKey,
        model,
        timeRange,
      ),
    })),
  );
  grokCallCount += subQueries.length;
  estimatedCost += COST_SEARCH_WITH_TOOL * subQueries.length;

  // 3. Bulk validate + enrich (mandatory, filters hallucinations)
  const { candidates: validated, hallucinatedCount, xApiCallCount: lookupCalls } =
    await validateAndEnrich(grokResults, bearerToken);
  xApiCallCount += lookupCalls;

  // 4. Mechanical rank
  const ranked = rankCandidates(validated);

  // 5. Aggregation rerank
  if (enableRerank && ranked.length > 0) {
    await aggregationRerank(args.naturalQuery, ranked, args.apiKey, model);
    grokCallCount += 1;
    estimatedCost += COST_AGGREGATION;
  }

  // 6. Time range filter (hard cut on dates we now have for sure)
  const { kept: filtered, dropped: timeFilteredCount } = applyTimeRange(
    ranked,
    timeRange,
  );

  // 7. alreadyCached flags
  await markAlreadyCached(filtered);

  const stats: DeepSearchStats = {
    grokCallCount,
    xApiCallCount,
    estimatedCost: Math.round(estimatedCost * 100) / 100,
    elapsedMs: Date.now() - startedAt,
    hallucinatedCount,
    timeFilteredCount,
    unverifiedCount: 0,
  };

  return {
    ok: true,
    queryHash: hashQuery(args.naturalQuery, count, timeRange),
    query: args.naturalQuery,
    timeRange,
    createdAt: new Date().toISOString(),
    fromCache: false,
    subQueries,
    candidates: filtered,
    stats,
  };
}
