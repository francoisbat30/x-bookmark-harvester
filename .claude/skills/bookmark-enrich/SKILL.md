---
name: bookmark-enrich
description: Add an AI-generated Summary section and canonical tags to X bookmark markdown files with status:raw, then flip them to status:enriched. Use when the user types /bookmark-enrich, asks to enrich raw bookmarks, generate summaries for saved bookmarks, add summaries and tags, or make the X bookmark library AI-scannable for future queries.
---

# bookmark-enrich

Upgrades `status: raw` bookmarks to `status: enriched` by adding a short English Summary section and canonical tags. This is what makes the library efficient to query later: Claude can skim summaries instead of re-reading every verbatim post.

## When a bookmark is "raw"

A bookmark has `status: raw` in its YAML frontmatter when it was freshly harvested and has never been enriched. Its body contains `## Contenu du post`, optional `## Médias`, and optional `## Commentaires notables`, but no `## Summary` section.

After enrichment:
- Frontmatter `status: enriched`
- Frontmatter `tags:` contains `x-bookmark` plus 2-5 canonical topic tags
- Body begins with a `## Summary` section inserted right after the frontmatter

## Invocation

- `/bookmark-enrich` → process every bookmark in the vault that still has `status: raw`
- `/bookmark-enrich <tweet-id>` → process a single bookmark

## Workflow

### Step 1 — list candidates

```bash
tsx --env-file=.env.local scripts/skills/enrich-list.ts [<tweet-id>]
```

Output is JSON with `{ count, bookmarks: [{ id, mdPath, rawJsonPath, title, author, date }] }`. If `count` is 0, tell the user there is nothing to enrich and exit.

### Step 2 — for each bookmark, read the raw JSON

Read the file at `rawJsonPath` with the Read tool. The `post` field holds `text`, `author`, `date`, `media`, `metrics`, `comments` (an array of `{handle, name, date, text}`). This is the verbatim source of truth — use it, not the rendered .md.

### Step 3 — generate Summary and tag candidates

Produce a **Summary in English**, 3-5 lines, under 500 characters. Style rules:

- First sentence states the core claim or insight of the post.
- Second/third sentence names concrete specifics: tools, model names, benchmark numbers, techniques, datasets.
- Neutral voice, no first-person, no hype language.
- NO bullet points, NO headings — flowing paragraph only.
- If the post is a question or observation without a claim, say so explicitly ("Author asks how X compares to Y").

**Good example:**
> Gemma 4 26B runs locally on a 3-year-old M2 Max MacBook via MLX and orchestrates Falcon Perception for real-time video segmentation, outperforming SAM 3 on SA-Co benchmarks (68.0 vs 62.3 Macro-F1). The author runs it through LM Studio with a lightweight Python agent loop that calls Falcon as a tool.

**Bad example:**
> A cool post about AI models running locally. Worth checking out!

Produce 2-5 **tag candidates** drawn from the main topics, tools, techniques, or domains present. Keep them lowercase hyphen-separated (e.g. `local-inference`, `video-generation`, `mlx`, `prompting`). Do not invent topics not present in the post.

Before writing, read `vault/x-bookmarks/.taxonomy.yaml` to check for existing canonical names and aliases. If a candidate matches an alias, use the canonical form instead. If nothing matches, the candidate becomes a new canonical (the writer will auto-register it).

### Step 4 — write the enrichment

```bash
tsx --env-file=.env.local scripts/skills/enrich-write.ts <id> \
    --summary "..." \
    --tags "tag1,tag2,tag3"
```

The writer:
- Normalizes and canonicalizes every tag through the taxonomy
- Always keeps `x-bookmark` in the list
- Replaces the existing `## Summary` section if already present, otherwise inserts it
- Flips `status: raw` → `status: enriched`
- Registers any brand-new canonical tags in `.taxonomy.yaml`
- Prints a JSON receipt: `{ ok, id, file, tags, status, newCanonicalTags }`

### Step 5 — batch reporting

When processing multiple bookmarks, after the loop print a 3-line summary:

- How many bookmarks were enriched
- Which new canonical tags were introduced (so the user can audit them later via `/bookmark-tags audit`)
- A suggestion to run `/bookmark-status` to verify

## Invariants

- The raw JSON in `.raw/` is the source of truth for Summary generation. Never invent facts not in it.
- Do not touch `## Contenu du post`, `## Médias`, or `## Commentaires notables` sections — only insert Summary.
- Do not skip bookmarks just because they have many comments; the comments are part of the context but the Summary describes the post itself, not the conversation.
- If a bookmark has `text` starting with `ERROR:` in the raw JSON, skip it and report as an enrichment failure — it means the extraction itself failed.
