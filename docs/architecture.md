# Architecture

High-level view of how the pieces fit together. Three concerns live side by side and stay separated on purpose.

```
┌──────────────────────────────────────────────────────────────┐
│  Next.js app (app/)                                          │
│   • page.tsx        orchestration + state                    │
│   • components/     dumb UI (AuthPanel, SettingsPanel, …)    │
│   • actions.ts      server actions (extract, enrich, retry)  │
│   • settings-actions.ts   vault picker + validation          │
│   • api/            REST-ish routes (OAuth, usage, sync)     │
└──────────────────────────────────────────────────────────────┘
             │                                      │
             ▼                                      ▼
┌────────────────────────────┐   ┌────────────────────────────┐
│  lib/x/                    │   │  lib/obsidian/             │
│  All things X.com + xAI    │   │  Writing to a vault        │
│                            │   │                            │
│  • auth.ts   OAuth 2 PKCE  │   │  • vault.ts  paths + write │
│  • api.ts    v2 extraction │   │  • cache.ts  .raw/ envelope│
│  • bookmarks.ts  /users/me │   │  • markdown.ts  .md render │
│  • usage.ts  rate limits   │   │  • media-download.ts       │
│  • tweet-id.ts  URL parser │   │                            │
│  • grok-extract.ts         │   └────────────────────────────┘
│  • grok-enrich.ts          │
│  • xai-responses.ts shared │
└────────────────────────────┘
             │
             ▼
┌────────────────────────────┐
│  lib/                      │
│  • types.ts    shared DTOs │
│  • user-config.ts          │
│  • platform.ts  OS paths   │
└────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  scripts/skills/                                             │
│  CLI entry points invoked by the Claude Code skills at       │
│  .claude/skills/bookmark-*/ . Pure filesystem operations on  │
│  the vault — no network, no LLM.                             │
│                                                              │
│  tags.ts  graph.ts  status.ts  filter.ts                     │
│  enrich-list.ts  enrich-write.ts  utils.ts                   │
└──────────────────────────────────────────────────────────────┘
```

## Data flow for a single bookmark

1. **Input** — user pastes an X URL or triggers `Sync my bookmarks`.
2. **Parse** — `lib/x/tweet-id.ts` pulls the numeric ID.
3. **Cache check** — `lib/obsidian/cache.ts` looks for `<vault>/.raw/<id>.json`.
4. **Fetch** — if miss, `lib/x/api.ts` calls `GET /tweets/:id` + `GET /tweets/search/recent?q=conversation_id:...`, assembles a `PostExtraction`.
5. **Media** — `lib/obsidian/media-download.ts` grabs images in parallel (concurrency 3) into `<vault>/assets/`.
6. **Cache write** — the raw `PostExtraction` is wrapped in a `CacheEnvelope` and written to `.raw/<id>.json`.
7. **Render** — `lib/obsidian/markdown.ts` turns the envelope into a `.md` note with YAML frontmatter.
8. **Write note** — `lib/obsidian/vault.ts` resolves collisions (same filename, different tweet ID → append suffix) and writes.

## Who reads what

| Caller | Reads | Writes |
|---|---|---|
| `app/actions.ts` | cache, x-api, grok | cache, vault notes |
| `app/settings-actions.ts` | user-config | user-config |
| `app/api/auth/x/*` | lib/x/auth | tokens (in `%APPDATA%`) |
| `app/api/bookmarks/list` | lib/x/bookmarks + cache | — |
| `app/api/xapi/usage` | lib/x/usage snapshot | — |
| `scripts/skills/*` | vault .md + .raw | vault frontmatter + taxonomy |

## Why three namespaces

`lib/x/` and `lib/obsidian/` are intentionally kept apart because the two domains evolve independently: X API shapes and rate limits change often, Obsidian rendering is stable. A developer new to the code should be able to answer "how do we talk to X?" by reading one folder, and "how do we lay out notes?" by reading another.

`scripts/skills/` is isolated because it's invoked by a different runtime (the Claude Code slash commands) with a different mental model: deterministic filesystem operations, no network, no state sharing with the running Next.js server.

## Where secrets live

- **OAuth tokens** — `%APPDATA%/x-bookmark-harvester/auth.json` on Windows (equivalent per-user dirs on macOS/Linux). **Never** in the vault, **never** in the project folder, so that OneDrive/Dropbox sync can't leak them.
- **API keys** — `.env.local` at project root. Gitignored.
- **User vault settings** — `%APPDATA%/x-bookmark-harvester/config.json`. Also outside the project.

See [x-integration.md](./x-integration.md) for the auth flow details.
