# X (Twitter) integration

Everything about talking to X.com and xAI lives under [`lib/x/`](../lib/x/). Three distinct things happen there.

## 1. X API v2 — reading bookmarks and posts

### Bookmark list (`lib/x/bookmarks.ts`)
- Endpoint: `GET /users/:id/bookmarks`
- Requires an OAuth 2.0 user context token with `bookmark.read`.
- Paginates via `next_token`, caps at 20 pages by default.
- Returns lightweight `BookmarkSummary[]` — the actual post extraction is deferred.

### Post extraction (`lib/x/api.ts`)
- Endpoint: `GET /tweets/:id` with `tweet.fields` + expansions for author, media, referenced tweets, note tweets, long articles.
- For the conversation tail: `GET /tweets/search/recent?query=conversation_id:<id>`. This is an app-only endpoint and only returns tweets from the last 7 days.
- Results are merged into a `PostExtraction` that bundles the author-thread (concatenated if the author posted a reply-chain) plus top comments (sorted by likes, capped).
- Retries: 429 and 5xx responses are retried up to 3 times with exponential backoff. `Retry-After` is honored when present.

### Usage tracking (`lib/x/usage.ts`)
- Module-level snapshot updated on every `fetch` return. Reads `x-rate-limit-*` and `x-app-limit-24hour-*` headers.
- Surfaced to the UI via `GET /api/xapi/usage`. This is ephemeral state — fine for a single-process dev server, deliberately not persisted.

## 2. OAuth 2.0 user context (`lib/x/auth.ts`)

Flow:

```
┌─ user clicks "Connect X account" ──────────────────────────────┐
│  GET /api/auth/x/start                                         │
│    • generates PKCE verifier + challenge                       │
│    • sets x_oauth_state & x_oauth_verifier cookies (httpOnly)  │
│    • 302 to https://x.com/i/oauth2/authorize                   │
└────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─ user approves on x.com ───────────────────────────────────────┐
│  GET /callback?code=…&state=…                                  │
│    • constant-time state comparison                            │
│    • POST /2/oauth2/token with code + verifier + Basic auth    │
│    • saveTokens() → %APPDATA%/x-bookmark-harvester/auth.json   │
└────────────────────────────────────────────────────────────────┘
```

### Token storage
- **Path**: `%APPDATA%/x-bookmark-harvester/auth.json` on Windows, `~/Library/Application Support/x-bookmark-harvester/` on macOS, `$XDG_CONFIG_HOME/x-bookmark-harvester/` on Linux. Resolved by `lib/platform.ts::appDataDir()`.
- **Why not in the vault?** An earlier version stored this in `vault/x-bookmarks/.auth.json`. On a OneDrive-synced vault that's a silent token leak across every device and every OneDrive backup. A one-shot migration in `loadTokens()` detects the legacy path and moves it.
- **Permissions**: `chmod 0600` is attempted on save. Windows maps this to ACLs; not a strong guarantee, but better than nothing.

### Refresh
- `getValidAccessToken()` returns the current token if it has more than 60s of life left. Otherwise it runs a refresh grant and saves the new pair. Refresh failures clear the tokens entirely — the user sees the Connect button again.

## 3. xAI (Grok) Responses API

Two narrow use cases, both talking to `https://api.x.ai/v1/responses` with the `x_search` tool enabled.

### `lib/x/grok-extract.ts`
Fallback content extraction for posts older than 7 days (outside the X search window). Used by the "Retry replies with Grok" button when the v2 API returned zero comments on a post that reported N replies. Shape returned is the same `PostExtraction` as the v2 API path.

### `lib/x/grok-enrich.ts`
On-demand enrichment of a single bookmark. Reads the post + its entire comment thread (including old replies) and returns a `GrokInsights` object:

- `author_additions` — synthesized follow-up thoughts from the author's reply chain
- `notable_links` — GitHub repos / papers / blog posts shared in the comments
- `sentiment` — 2–3 sentences on community reception
- `key_replies` — top 5 insight-dense individual replies

### Shared plumbing (`lib/x/xai-responses.ts`)
- `callResponses({ apiKey, model, instructions, input, tools? })` — one POST helper. Hard timeout of 120 s (Grok with `x_search` routinely takes 30–90 s and the server action must not hang indefinitely on a stalled upstream).
- `extractText(payload)` — pulls `output_text` or assembles it from `output[].content[]`.
- `stripJsonFences(text)` — normalizes LLM JSON output (handles ```json fences and falls back to outermost `{…}`).

## 4. Deep Search — multi-query research pipeline (`lib/x/deep-search.ts`)

Deep Search is an orchestrator that takes a natural-language research theme and returns 20-35 scored X candidates. It runs in 6 stages:

```
naturalQuery
  ↓ [1] callResponses(expansion)                  — Grok, no tools
6 sub-queries (JSON)
  ↓ [2] Promise.all(callResponses × 6)            — Grok with x_search
~60 raw candidates
  ↓ [3] Promise.all(searchRecentTweets × 7)       — X API v2 /search/recent
+N ground-truth candidates (last 7 days only)
  ↓ [4] rankCandidates                            — dedup + mechanical score
~25-35 unique scored candidates
  ↓ [5] callResponses(aggregationRerank)          — Grok, no tools, 1-5 + rationale
final ordered list
  ↓ [6] markAlreadyCached                         — flag against .raw/
DeepSearchResult
```

### Stage 1 — sub-query expansion
Single Grok call with `tools: []` and temperature 0.4. Instructions force variation on vocabulary, angle, content format, and audience, returning a strict JSON shape.

### Stage 2 — parallel Grok search
6 concurrent Grok calls, each with `x_search` tool enabled. Instructions prioritize recall: "return at least 10 URLs, do NOT filter for popularity, prefer long-form articles and 5+ tweet threads". Temperature 0.3 to diversify the parallel calls without going wild.

### Stage 3 — X API v2 augmentation
`lib/x/api.ts::searchRecentTweets(query, bearer, max)` calls `GET /2/tweets/search/recent` with `-is:retweet` filter, 20 results per sub-query, 7 concurrent requests. This is the ground-truth complement: anything returned by the public index directly, no LLM hallucination possible.

### Stage 4 — mechanical ranking
Dedup by `tweetId` into a `Map`. Merge `foundBy` arrays across sources. Score formula:

```
mechanicalScore =
    foundByCount * 10               // multi-match boost
  + log(likes + 1) * 2
  + log(retweets + 1) * 4
  + log(replies + 1) * 3
  + (format === "article" ? 15 : 0)
  + (format === "thread" ? 8 : 0)
  - (alreadyCached ? 5 : 0)
```

### Stage 5 — aggregation rerank
Top-50 candidates are serialized (tweetId + author + snippet + format + metrics) and passed back to Grok (no tools) with instructions to re-rank by true relevance, assigning a 1-5 score and a one-line rationale. `finalScore = mechanicalScore + llmScore * 5`.

### Stage 6 — already-cached flag
`hasCache(tweetId)` is called in parallel for each candidate. The UI deprioritizes already-cached candidates and flags them so the user can skip re-extraction.

### Cache (`lib/obsidian/deep-search-cache.ts`)
Results are persisted to `<vault>/.deepsearch/<queryHash>.json` with a 2-hour TTL. The hash is `sha1(query.toLowerCase().trim() + "|" + subQueryCount)`, so case and whitespace don't create cache misses. `listDeepSearchHistory()` powers the history drawer in the UI and the CLI.

### CLI skill
`scripts/skills/deep-search.ts` wraps the same `runDeepSearch` entry point and shares the cache. Invoked via `npm run skill:deepsearch -- "query"` or the `/bookmark-deepsearch` slash command in Claude Code. Output is JSON on stdout, identical shape to the web UI's `DeepSearchResult`.

### Cost model
Rough per-search breakdown for `grok-4`:

| Stage | Calls | Cost |
|---|---|---|
| Expansion | 1 | ~$0.02 |
| Search (with x_search) | 6 | ~$0.72 |
| Aggregation rerank | 1 | ~$0.08 |
| **Total** | **8** | **~$0.82** |

X API v2 calls are free within your rate limits. The cost estimate is displayed in the UI before running and the real post-run cost is returned in `stats.estimatedCost`.

## Environment variables

| Key | Where used | Notes |
|---|---|---|
| `X_OAUTH2_CLIENT_ID` / `X_OAUTH2_CLIENT_SECRET` | `lib/x/auth.ts` | Developer portal → app → OAuth 2.0 |
| `X_OAUTH2_REDIRECT_URI` | same | X refuses `localhost`, use `http://127.0.0.1:3000/callback` |
| `X_API_BEARER_TOKEN` | `lib/x/api.ts` | App-only bearer, used for `/tweets/:id` + search |
| `XAI_API_KEY` | `lib/x/grok-*.ts` | xAI console |
| `XAI_MODEL` | same | Default `grok-4` |

All of these live in `.env.local` and are gitignored. See `.env.example`.
