---
name: bookmark-digest
description: Generate a periodic rollup (week, month, custom range) of recently added X bookmarks — counts, top authors, emerging tags, notable quotes, grouped themes — saved as a new markdown file in vault/x-bookmarks/digests/. Use when the user types /bookmark-digest, asks for a weekly summary, monthly roundup, what they saved this week, or a themed overview of recent bookmarks.
---

# bookmark-digest

Periodic digest of new bookmarks, scoped to a time window. Output is a standalone markdown note in the vault that the user can open in Obsidian.

## Invocation

- `/bookmark-digest week` → last 7 days
- `/bookmark-digest month` → last 30 days
- `/bookmark-digest --since YYYY-MM-DD [--until YYYY-MM-DD]` → custom range (until defaults to today)

## Workflow

### Step 1 — resolve window

| Input | Computed window |
|---|---|
| `week` | since = today - 7 days, until = today |
| `month` | since = today - 30 days, until = today |
| `--since X [--until Y]` | use provided |

Use today in ISO date format. Pass the window to the filter CLI.

### Step 2 — collect

```bash
tsx --env-file=.env.local scripts/skills/filter.ts --since <since> --until <until>
```

If `count == 0`, tell the user the window is empty and ask whether to widen it. Do NOT write an empty digest file.

### Step 3 — synthesize

Generate the following sections for the digest:

1. **Headline** — `N bookmarks added between <since> and <until>`
2. **Top 5 authors** — bullet list `@handle — N posts`
3. **Top 10 tags** — bullet list `tag — N`
4. **Emerging tags** — tags present in this window but absent from the prior equal-length window. (To compute: re-run the filter for the prior window and diff the tag sets. If the prior window is empty, skip this section.)
5. **Top 3 quotes** — three of the most quotable single sentences from the matched bookmarks, each attributed `— @author ([[filename]])`. Pick sentences that are insight-dense, concrete, or memorable. Skip generic reactions.
6. **Themes** — group the bookmarks into 3-6 themes based on tags and content overlap. For each theme:
   - `### <Theme name>`
   - 1-sentence description
   - Bullet list of wikilinks: `- [[filename]] — one-line takeaway`

Everything in English.

### Step 4 — write the file

Determine the output filename:

| Window | Filename |
|---|---|
| `week` | `YYYY-Www.md` using ISO week number (e.g. `2026-W15.md`) |
| `month` | `YYYY-MM.md` (e.g. `2026-04.md`) |
| custom | `YYYY-MM-DD_to_YYYY-MM-DD.md` |

Output path: `vault/x-bookmarks/digests/<filename>`. Create the directory if it does not exist (use `mkdir -p` via Bash, or let the Write tool auto-create the parent — Write does NOT auto-create, use Bash first).

Frontmatter for the digest file:

```yaml
---
title: "Digest — <period label>"
type: digest
period_start: YYYY-MM-DD
period_end: YYYY-MM-DD
bookmark_count: N
generated_at: <ISO timestamp>
tags: [x-bookmark-digest]
---
```

### Step 5 — report

After writing, tell the user:
- The full path of the new digest file
- A one-line teaser of the top theme
- Suggest opening it in Obsidian

## Invariants

- Never regenerate an existing digest file silently. If the target file already exists, ask the user whether to overwrite.
- Only use data from the filter output — do not fetch new bookmarks during digest generation.
- The digest is a derived artifact, not a source of truth — if a bookmark is later deleted or edited, the digest is NOT auto-updated.
- Themes must be derived from content, not guessed. If a bookmark is ambiguous, put it in an "Other" theme rather than forcing a wrong fit.
