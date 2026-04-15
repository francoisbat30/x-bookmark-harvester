---
name: bookmark-deepsearch
description: Search X for a natural-language research theme, gather 20-35 candidate posts/threads/articles via multi-query Grok expansion + X API v2 recent search, present them for user selection, then optionally pipe into /bookmark-enrich for tagging. Use when the user types /bookmark-deepsearch, asks to research a topic on X, wants to collect a corpus of posts about a theme, needs a broad recall sweep instead of 5-6 hand-picked links, or wants to build a knowledge base around a specific topic like a framework, tool, or technique.
---

# bookmark-deepsearch

Deep research skill for the X Bookmark Harvester. Takes a natural-language topic and returns a scored list of 20-35 relevant X posts, threads, and Articles — much more than a single-prompt Grok call would yield.

## How it works

The CLI orchestrates 8 API calls behind the scenes:

1. **1× Grok call** (no tools) — decomposes the theme into 6 distinct sub-queries covering different vocabulary, angles, and content formats.
2. **6× Grok calls in parallel** (with `x_search` tool) — each hits X search with one sub-query, instructed to return at-least-10 links without filtering for popularity.
3. **7× X API v2 `/search/recent` calls in parallel** — ground-truth complement for the last 7 days (bearer token required, configured via `X_API_BEARER_TOKEN`).
4. **Mechanical dedup + rank** — by tweet ID, with scoring based on multi-query match count, engagement (log-scaled), content format (article > thread > post), and a soft penalty for bookmarks already cached.
5. **1× Grok aggregation call** (no tools) — rerank top-50 candidates by true relevance to the theme, adding a 1-5 score and a one-line rationale.

Results are cached in `<vault>/.deepsearch/<queryHash>.json` for 2 hours, shared between this CLI and the web UI.

## Invocation

- `/bookmark-deepsearch <theme>` → run a deep search end-to-end
- `/bookmark-deepsearch --fresh <theme>` → bypass the 2h cache

## Workflow

### Step 1 — run the CLI

```bash
tsx --env-file=.env.local scripts/skills/deep-search.ts "<natural query>"
```

Also exposed as `npm run skill:deepsearch -- "<query>"`. Output is JSON on stdout matching the `DeepSearchResult` shape:

```json
{
  "ok": true,
  "queryHash": "abc123…",
  "query": "seedance 2.0 capcut prompting",
  "createdAt": "2026-04-16T…",
  "fromCache": false,
  "subQueries": ["seedance 2.0 prompting", "capcut ai video workflow", …],
  "candidates": [
    {
      "tweetId": "123",
      "url": "https://x.com/.../status/123",
      "authorHandle": "someone",
      "text": "…",
      "format": "thread",
      "metrics": { "likes": 1200, "retweets": 40, "replies": 15 },
      "foundBy": ["seedance 2.0 prompting", "capcut ai video"],
      "source": "both",
      "rationale": "thread on prompt frameworks for Seedance",
      "finalScore": 87.5,
      "llmScore": 5,
      "alreadyCached": false
    },
    …
  ],
  "stats": {
    "grokCallCount": 8,
    "xApiCallCount": 7,
    "estimatedCost": 0.82,
    "elapsedMs": 67400
  }
}
```

### Step 2 — present candidates to the user

Relay a compact summary (not the raw JSON):

- `N candidates found in 6 angles, cost $X.XX, elapsed Ys`
- Sub-queries used (list)
- A compact table of candidates sorted by `finalScore`:

  ```
  [score] @handle · date · format · engagement
          rationale
          url
  ```

- Flag `alreadyCached: true` candidates visually so the user doesn't re-extract.

### Step 3 — let the user choose

Ask which candidates to harvest:

- "Extract all candidates" → gather all URLs
- "Extract top N by score"
- "Extract only articles + threads"
- "Pick by IDs" (user gives a list)

### Step 4 — feed into the extraction pipeline

The user can either:

- Open the web UI (`http://127.0.0.1:3000`), paste the selected URLs into the manual field, click Extract — **or**
- From Claude Code, use the Bash tool to call `tsx` directly on each URL via the existing `scripts/render.ts` or `scripts/spike-xapi.ts` workflow

Important: once the .md files exist in the vault, the standard pipeline applies:

- `/bookmark-enrich` adds Summary + canonical tags
- `/bookmark-tags audit` checks the taxonomy
- `/bookmark-query tag:<topic>` later surfaces the corpus

### Step 5 — optional: periodic re-run

If the user wants a "digest" of new content on the same theme, just re-run with `--fresh` — the cache is keyed by query hash so a fresh invocation pulls new Grok results. The diff against the previous cache (not yet automated) can be computed manually by comparing `createdAt` and `candidates[].tweetId`.

## Invariants

- Never extract candidates without explicit user confirmation (unless the user says "extract all" upfront).
- Always show the user the sub-queries the planner generated — transparency matters for trust.
- Respect `alreadyCached: true` — offer to skip those unless the user asks to overwrite.
- Cache TTL is 2h; `--fresh` is the only bypass.
- If the CLI fails (exit 1), the stderr JSON has `{ ok: false, error: "…" }` — surface it verbatim.

## When to use vs other skills

- **Use this** when the user wants to build a corpus from a theme they don't yet have bookmarks for.
- **Use `/bookmark-query`** when the corpus is already in the vault and they want to query it.
- **Use `/bookmark-enrich`** after this skill has extracted new bookmarks.
- **Use `/bookmark-digest`** for periodic rollups of existing bookmarks, not for discovery.
