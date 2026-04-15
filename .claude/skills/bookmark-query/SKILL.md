---
name: bookmark-query
description: Answer a question about the X bookmark library by filtering to a relevant subset (tags, author, date, text search), reading only those bookmarks, and citing sources via Obsidian wikilinks. Use when the user types /bookmark-query, asks a question about saved bookmarks, wants insights from their library, asks "what did I save about X", "find bookmarks about Y", or wants to query a specific corpus.
---

# bookmark-query

Filter-first Q&A over the bookmark library. Filters cut the corpus down; then summaries are scanned; only then full bodies are read if needed.

## Invocation

```
/bookmark-query [--tags=a,b] [--author=@handle] [--since=YYYY-MM-DD] [--until=YYYY-MM-DD] [--text="keyword"] <question>
```

All filters are optional but at least one filter OR a question is required.

## Workflow

### Step 1 — resolve corpus

```bash
tsx --env-file=.env.local scripts/skills/filter.ts [filters]
```

Output JSON: `{ count, bookmarks: [{ id, filename, path, title, author, date, tags, status, likes, summary }] }`. The `summary` field is the `## Summary` section if the bookmark is enriched, or the first 300 chars of body otherwise.

### Step 2 — corpus size gates

- `count == 0` → tell the user no matches, echo the filters tried, suggest looser ones.
- `1 ≤ count ≤ 15` → proceed to Step 3 directly.
- `16 ≤ count ≤ 50` → warn the user "N matches, proceeding with summary-scan mode", proceed.
- `count > 50` → STOP. Report top tags and top authors of the matched corpus (computed in-memory from the filter output) so the user can narrow. Do not read anything yet.

### Step 3 — scan mode (cheap)

Show the user the list of matching bookmarks as a compact table:

```
  [YYYY-MM-DD]  @author  title (truncated)  — tags
```

Then decide:
- **If the question can be answered from summaries alone** (e.g. "what tools did I save about video generation?"), answer directly from the summaries without reading any full body.
- **If the question requires details from the post body** (e.g. "what exact benchmark numbers does @X cite?"), proceed to Step 4.

### Step 4 — deep read (expensive)

Read the full `.md` of each matching bookmark using the Read tool. Up to the gate limit (15 unprompted, 50 with warning).

### Step 5 — answer

Structure the answer with:

- The user's question as an H2 heading
- A direct answer first, 2-5 sentences
- A "Sources" section listing the bookmarks used, as Obsidian wikilinks: `- [[filename]] — short reason why this source`
- If there is no clear answer, say so and explain what is missing

Citation format uses Obsidian wikilinks (`[[filename]]`) so the user can click through to the bookmark directly in Obsidian.

## Quality invariants

- Never invent facts outside the corpus. If the corpus is thin, say so explicitly.
- When a claim rests on a single bookmark, say "based on a single source".
- When bookmarks contradict, surface the disagreement rather than picking a side.
- Keep the answer tight — 2-5 sentences at the top, details in sources only if the user asks.
- Obey the user's filters strictly: do not silently widen them to get more matches.
