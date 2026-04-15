---
name: bookmark-tags
description: Manage the X bookmark tag taxonomy — list tags, detect synonyms, merge duplicates, alias management, coherent tag names across the library. Use when the user types /bookmark-tags, asks about tag management, tag cleanup, tag statistics, duplicate tags, renaming tags, or maintaining tag coherence across the X bookmark library at vault/x-bookmarks/.
---

# bookmark-tags

Deterministic tag taxonomy management for the X Bookmark Harvester library.

## Scope

Operates on markdown files under `vault/x-bookmarks/` and on the taxonomy file at `vault/x-bookmarks/.taxonomy.yaml`. Never modifies post content — only the `tags:` array in frontmatter and the taxonomy file itself.

## Commands

All commands run through the same CLI:

```bash
tsx --env-file=.env.local scripts/skills/tags.ts <subcommand> [args]
```

Also exposed as `npm run skill:tags -- <subcommand> [args]`.

| Subcommand | Effect |
|---|---|
| `list` | Print all tags with their usage count, sorted desc |
| `audit` | Detect quasi-duplicate tags via Levenshtein distance ≤ 2 and suggest merges |
| `merge <from> <into>` | Rename tag `from` → `into` in every .md file AND add `from` as an alias in the taxonomy |
| `alias <canonical> <a1> [<a2>...]` | Register aliases pointing to a canonical tag |
| `describe <tag> "<text>"` | Set the description of a canonical tag in the taxonomy |
| `show <tag>` | Show full info for one tag: usage, aliases, description, parent, files |

## Workflow

### When user invokes `/bookmark-tags` with no args
Run `list` first, then ask what they want to do (audit, merge, etc.).

### When user invokes `/bookmark-tags audit`
1. Run `audit`, show the candidate pairs.
2. For each pair, suggest which side should be canonical (heuristic: prefer higher usage count, then more natural spelling, then longer name).
3. Confirm each merge with the user before running.
4. After merges, suggest running `/bookmark-status` to verify the vault is clean.

### When user invokes `/bookmark-tags merge <from> <into>`
Run the merge directly. The CLI reports how many files were updated and what was added to the taxonomy.

### When user asks a natural-language question like "show me my most used tags" or "find duplicate tags"
Map it to the right subcommand (`list` or `audit`) and run it.

## Invariants

- Tag names are lowercase, hyphen-separated, ASCII only. The CLI normalizes on write.
- The `x-bookmark` tag is a library-wide marker — never suggest merging or renaming it.
- The `.taxonomy.yaml` file is managed only through this skill. Do not propose hand-edits.
- Merges are destructive (rewrite .md files). Confirm with the user before batch merges except for obvious typos flagged by `audit`.

## Output style

Relay the CLI output to the user verbatim for `list`, `show`, `audit`. Summarize succinctly for `merge`, `alias`, `describe`.
