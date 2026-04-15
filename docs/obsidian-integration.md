# Obsidian integration

Everything about writing notes into an Obsidian vault lives under [`lib/obsidian/`](../lib/obsidian/). The goal is to produce vault content that behaves well when the user opens it in Obsidian: stable filenames, linkable assets, YAML frontmatter for search and graph view.

## Vault config resolution

`lib/obsidian/vault.ts::getVaultConfig()` resolves the effective vault path with three-tier precedence (implemented in `lib/user-config.ts::resolveVaultConfig`):

1. **User config** — `%APPDATA%/x-bookmark-harvester/config.json`, written by the Settings panel in the UI. Highest priority because it reflects an explicit user choice.
2. **Environment** — `OBSIDIAN_VAULT_PATH` + `OBSIDIAN_BOOKMARKS_SUBFOLDER` from `.env.local`. For headless / CI / scripts.
3. **Default** — `./vault/x-bookmarks` next to the project. Works out of the box, useful for smoke-testing.

The UI's "Vault location" panel shows which tier is active via a coloured badge.

## Note lifecycle

For every bookmark, two files get written:

```
vault/
├── x-bookmarks/
│   ├── 2026-04-15_author_first-words-of-post.md   # rendered note
│   ├── .raw/
│   │   └── <tweet-id>.json                        # cache envelope
│   └── assets/
│       └── <tweet-id>_1.jpg                       # downloaded images
└── .obsidian/                                      # user's Obsidian state
```

### The cache envelope (`lib/obsidian/cache.ts`)
```ts
{
  source: "xapi" | "grok" | "apify",
  fetchedAt: ISO,
  tweetId: string,
  post: PostExtraction,
  grokInsights?: { fetchedAt: ISO, data: GrokInsights },
  downloadedImages?: DownloadedImage[]
}
```

The envelope is the **source of truth**. The `.md` is a derived view — running `npm run render <id>` regenerates it from cache without touching the network. When we re-fetch a post, we preserve `grokInsights` and `downloadedImages` across writes so a refetch doesn't wipe enrichment.

### Filename rules (`lib/obsidian/markdown.ts::buildFilename`)

```
YYYY-MM-DD_handle_first-six-words.md
```

- Handle and words are slugified: NFKD normalize, lowercase, non-ASCII stripped, collapsed dashes, trimmed.
- URLs are removed from the word source before slugging (otherwise the filename would be `https-example-com…`).
- Max 60 chars per slug segment.

### Collision handling (`lib/obsidian/vault.ts::resolveCollision`)

Two different tweets can legitimately produce the same filename (same author, same day, same first six words — rare but happens). On write we check:
1. If the target file doesn't exist → write normally.
2. If it exists with the same `tweet-id` → treat as overwrite.
3. If it exists with a **different** `tweet-id` → append the last 8 digits of the new ID as a disambiguation suffix.

The tweet ID is recovered from the `source:` frontmatter line of the existing file.

### Frontmatter (`lib/obsidian/markdown.ts::buildFrontmatter`)

```yaml
---
title: "First line of the post"
author: "@handle"
author_name: "Display Name"
date: 2026-04-15
source: "https://x.com/handle/status/123"
likes: 42
retweets: 7
replies: 3
views: 1234
tags: [x-bookmark]
status: raw
---
```

String values go through `yaml.stringify` (from the `yaml` package, already a dep) to correctly escape quotes, newlines and unicode line separators. Numeric and plain fields stay plain.

`status: raw` flips to `status: enriched` when the `/bookmark-enrich` skill runs — see [skills.md](./skills.md).

### Rendered body sections (in order)

1. `## Contenu du post` — verbatim text (thread parts concatenated with `\n\n`).
2. `## Médias` — either `![[assets/<local>]]` embeds if the image was downloaded, or fallback `[image] <remote-url>` for videos / failed downloads.
3. `## Grok Insights` — only if `grokInsights` is attached. Subsections: Author additions, Notable links, Community sentiment, Key replies.
4. `## Commentaires notables` — top-liked comments, each as a blockquote with `> **@handle** (Name) — YYYY-MM-DD`.

The order matters: insights before comments lets the reader see the synthesis before the raw material.

## Images (`lib/obsidian/media-download.ts`)

- Filters media to `type === "image"` only. Videos and GIFs are referenced by URL but not downloaded (too heavy, and Obsidian renders them fine from remote URLs).
- Concurrency cap of 3 parallel fetches.
- Existing files are skipped (idempotent re-runs).
- Filename pattern: `<tweetId>_<index>.<ext>`. Extension derived from the URL's `format=` query param, then the path's extension, then the response `content-type` as fallback.

## Writing is cheap, fetching is not

Every step above is idempotent and cheap. The expensive thing is the X API call. The cache + render separation means the user can iterate on markdown templates or enrich content without paying for a single re-fetch.
