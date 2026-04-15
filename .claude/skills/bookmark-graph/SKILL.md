---
name: bookmark-graph
description: Configure Obsidian graph view color groups for the X bookmark vault. Reads group definitions from a yaml file and writes them to vault/.obsidian/graph.json. Use when the user types /bookmark-graph, asks to set up graph colors, group bookmarks visually by theme, update the Obsidian graph view, or refresh color groups after tag cleanup.
---

# bookmark-graph

Writes Obsidian graph view color groups to `vault/.obsidian/graph.json` based on a yaml definition file managed in this skill directory.

## Scope

Operates on two files:
- **Input** — `.claude/skills/bookmark-graph/groups.yaml` (editable group definitions)
- **Output** — `<vaultRoot>/.obsidian/graph.json` (merged with any existing settings; only the `colorGroups` field is overwritten)

Never touches bookmark markdown files or the taxonomy.

## Commands

```bash
tsx --env-file=.env.local scripts/skills/graph.ts <subcommand>
```

Also: `npm run skill:graph -- <subcommand>`.

| Subcommand | Effect |
|---|---|
| `apply` | Read groups.yaml and write color groups to graph.json |
| `show` | Print current color groups from graph.json |
| `reset` | Clear all color groups from graph.json |

## groups.yaml format

```yaml
groups:
  - name: Claude & agentic coding        # label (not shown in Obsidian, for human editing)
    query: "tag:#claude-code OR tag:#agent-harness"
    color: "#a855f7"                     # hex, 6 digits
```

The `query` uses Obsidian search syntax. Most common patterns:
- `tag:#foo` — notes with the `foo` tag
- `tag:#foo OR tag:#bar` — union
- `path:x-bookmarks/` — notes under a folder
- `file:2026-03` — filename substring

Colors are hex (`#rrggbb`); the script converts to Obsidian's `{a, rgb}` integer format.

## Workflow

### When user invokes `/bookmark-graph` with no args
Run `show` to display current groups, then ask if they want to edit `groups.yaml` or re-`apply`.

### When user invokes `/bookmark-graph apply`
Run `apply` directly. Report which groups were written.

### When user asks to add/change a group
Edit `groups.yaml` (add/modify/remove a group entry), then run `apply`.

### When user runs this after a tag cleanup (merges, renames)
Re-run `apply` to refresh. Any merged-away tags still in queries should be replaced with their canonical replacement. Check `vault/x-bookmarks/.taxonomy.yaml` for aliases if unsure.

## Invariants

- Never hand-edit `graph.json` — always go through `apply`.
- `apply` merges with the existing `graph.json`, preserving user-set force/display settings. It only overwrites `colorGroups` and ensures `showTags: true`.
- If Obsidian is currently open on this vault when you run `apply`, the user must reload the vault (Ctrl+R) or Obsidian will overwrite the file on its next save. Warn them.
- Queries must use actual canonical tag names (check `.taxonomy.yaml` for the current canonicals).

## Output style

Relay the CLI output verbatim for `show` and `apply`. After `apply`, remind the user to reload Obsidian if it was open.
