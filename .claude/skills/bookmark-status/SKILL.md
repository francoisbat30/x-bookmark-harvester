---
name: bookmark-status
description: Print a health and inventory dashboard of the X bookmark library — total counts, status breakdown, top authors and tags, detected issues like orphan caches, missing comments on old posts, or raw bookmarks needing enrichment. Use when the user types /bookmark-status, asks for library stats, dashboard, inventory, health check, or what needs attention in the vault.
---

# bookmark-status

Deterministic dashboard of the X bookmark library. No LLM work — just reads files and computes.

## Invocation

- `/bookmark-status` → print the report

## Implementation

Run the CLI and relay its output to the user as-is:

```bash
tsx --env-file=.env.local scripts/skills/status.ts
```

Also exposed as `npm run skill:status`.

## What the report covers

- Total bookmarks (count of .md files at the root of `vault/x-bookmarks/`, excluding dotfiles and subfolders)
- Breakdown by status (`raw` vs `enriched`)
- Average number of comments per bookmark (from raw JSON caches)
- Cached raw JSON count (for sanity vs total)
- Top 5 authors by count
- Top 10 tags by count
- Issues section:
  - `⚠` warn: bookmark has `0` comments and post date is older than 7 days — means X API conversation window missed the replies, suggest re-fetch via Grok
  - `⚠` warn: bookmark's `.md` exists but its `.raw/<id>.json` is missing
  - `·` info: orphan raw caches (json with no matching .md)
  - `·` info: number of bookmarks still `status: raw` — suggest `/bookmark-enrich`

## When the user asks follow-up questions from the report

- "Which ones have empty comments?" → re-run the CLI and pipe through grep if needed, OR just list the names from the issues section
- "Can you enrich the raw ones?" → invoke `/bookmark-enrich`
- "Delete the orphan caches" → confirm first, then use Bash to `rm` the specific files listed in the issues section

## Invariants

- Never auto-delete files based on detected issues. The skill reports issues but the user explicitly confirms any destructive fix.
- The report is regenerated on every call — it has no state of its own.
