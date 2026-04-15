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
- `callResponses({ apiKey, model, instructions, input, tools? })` — one POST helper.
- `extractText(payload)` — pulls `output_text` or assembles it from `output[].content[]`.
- `stripJsonFences(text)` — normalizes LLM JSON output (handles ```json fences and falls back to outermost `{…}`).

## Environment variables

| Key | Where used | Notes |
|---|---|---|
| `X_OAUTH2_CLIENT_ID` / `X_OAUTH2_CLIENT_SECRET` | `lib/x/auth.ts` | Developer portal → app → OAuth 2.0 |
| `X_OAUTH2_REDIRECT_URI` | same | X refuses `localhost`, use `http://127.0.0.1:3000/callback` |
| `X_API_BEARER_TOKEN` | `lib/x/api.ts` | App-only bearer, used for `/tweets/:id` + search |
| `XAI_API_KEY` | `lib/x/grok-*.ts` | xAI console |
| `XAI_MODEL` | same | Default `grok-4` |

All of these live in `.env.local` and are gitignored. See `.env.example`.
