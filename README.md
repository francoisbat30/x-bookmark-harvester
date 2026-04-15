# X Bookmark Harvester

Turn your X (Twitter) bookmarks into a searchable, structured [Obsidian](https://obsidian.md/) vault. Sync the list from your account, harvest post content + comments + media via the X API, optionally enrich each bookmark with Grok insights, then query and maintain the whole library through Claude Code skills.

Local-first, single-user, your data never leaves your machine.

## Features

- **Sync your X bookmarks** from `GET /users/:id/bookmarks` with OAuth 2.0 PKCE — dedups against what's already in the vault, processes only the new ones.
- **Manual paste mode** — drop any list of X post URLs and extract them in batch.
- **Rich extraction** — full post text (including long-form and threads), author, date, metrics, media, top comments sorted by likes.
- **Grok enrichment on demand** — per-bookmark synthesis: author additions, notable links from comments, community sentiment, key replies.
- **Native vault location picker** — choose any folder on your machine through a system file dialog (PowerShell on Windows, osascript on macOS, zenity on Linux).
- **Cache + re-render** — every fetch is persisted to `.raw/<id>.json`. You can re-render a note without re-calling the API, useful when you tweak the markdown template.
- **Seven Claude Code skills** (`/bookmark-status`, `/bookmark-enrich`, `/bookmark-tags`, `/bookmark-graph`, `/bookmark-query`, `/bookmark-digest`) for maintaining the library without leaving Claude Code.

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/francoisbat30/x-bookmark-harvester.git
cd x-bookmark-harvester
npm install

# 2. Configure credentials
cp .env.example .env.local
# Edit .env.local — see "Credentials" below

# 3. Run
npm run dev
# open http://127.0.0.1:3000
```

Click **Connect X account**, authorize, then either press **Sync my bookmarks** or paste URLs manually.

## Credentials

You need two things in `.env.local`:

| Key | How to get it |
|---|---|
| `X_API_BEARER_TOKEN` | [developer.x.com](https://developer.x.com) → your app → Keys and tokens → Bearer Token |
| `X_OAUTH2_CLIENT_ID` + `X_OAUTH2_CLIENT_SECRET` | Same app → User authentication settings → enable OAuth 2.0, Confidential client. Set redirect URI to `http://127.0.0.1:3000/callback` (X does not accept `localhost`). Then Keys and tokens → OAuth 2.0 Client ID and Secret. |
| `XAI_API_KEY` (optional) | [console.x.ai](https://console.x.ai) — only needed for the Grok enrich and Grok-fallback extraction buttons |

## Vault location

The vault folder is where your `.md` notes are written. It can be set three ways, in order of precedence:

1. **The UI Settings panel** — click "Change…" in the Vault location card, then "Browse…". Your choice persists to `%APPDATA%/x-bookmark-harvester/config.json` (Windows) / `~/Library/Application Support/` (macOS) / `~/.config/` (Linux).
2. **Environment variable** — `OBSIDIAN_VAULT_PATH` + `OBSIDIAN_BOOKMARKS_SUBFOLDER` in `.env.local`.
3. **Default** — `./vault/x-bookmarks` inside the project, useful for trying the app out.

Your OAuth tokens (`auth.json`) and user config (`config.json`) are deliberately stored **outside** the vault, in the OS-specific per-user data directory, so that cloud-syncing your vault (OneDrive, iCloud, Dropbox) can't leak credentials.

## Documentation

Architecture and design docs for developers:

- [`docs/architecture.md`](./docs/architecture.md) — overall shape, namespaces, data flow
- [`docs/x-integration.md`](./docs/x-integration.md) — X API v2, OAuth 2.0 PKCE, Grok usage
- [`docs/obsidian-integration.md`](./docs/obsidian-integration.md) — vault layout, cache envelope, markdown rendering, collisions
- [`docs/skills.md`](./docs/skills.md) — how the Claude Code skills work end-to-end
- [`PRD-x-bookmark-harvester.md`](./PRD-x-bookmark-harvester.md) — product requirements

## Project layout

```
app/                Next.js app router — pages, components, server actions, API routes
lib/
  x/                X API + OAuth + Grok (xAI) integration
  obsidian/         Vault paths, cache envelope, markdown rendering, media downloads
  types.ts          Shared DTOs
  user-config.ts    Per-user vault settings persisted in %APPDATA%
  platform.ts       OS-specific per-user data dir resolution
scripts/
  skills/           CLI entry points for the Claude Code skills (deterministic fs ops)
  render.ts         Re-render a note from its cache without hitting the API
  spike-*.ts        Standalone exploration scripts
tests/              Vitest unit tests
.claude/skills/     Slash command definitions (SKILL.md per skill)
docs/               Architecture + integration docs
```

## Development

```bash
npm run dev         # Next.js dev server at 127.0.0.1:3000
npm test            # Run the test suite (vitest)
npm run test:watch  # Watch mode
npm run build       # Production build
npx tsc --noEmit    # Type-check only
```

Skill CLIs can be invoked directly without the Claude Code front-end:

```bash
npm run skill:status              # dashboard
npm run skill:tags -- audit       # find duplicate tags
npm run skill:graph -- apply      # push color groups to Obsidian
npm run skill:filter -- --tags=mlx,local-inference
```

## License

MIT. See [LICENSE](./LICENSE).
