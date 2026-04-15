# Claude Code skills

Seven slash-commands maintained as Claude Code skills under [`.claude/skills/`](../.claude/skills/). Each skill is two things living side by side:

- A `SKILL.md` file declaring the slash command, its trigger conditions, and the workflow Claude should follow.
- A TypeScript CLI in [`scripts/skills/`](../scripts/skills/) that does the deterministic filesystem work — reading the vault, writing frontmatter, computing stats. Zero network calls, zero LLM calls.

Claude Code reads both: the SKILL.md tells it *what* to do, the CLI is the tool it *uses*.

## Inventory

| Skill | CLI | Slash command | What it does |
|---|---|---|---|
| `bookmark-status` | `scripts/skills/status.ts` | `/bookmark-status` | Health dashboard — counts, top authors, top tags, orphan caches, raw-to-enrich queue |
| `bookmark-enrich` | `scripts/skills/enrich-list.ts` + `enrich-write.ts` | `/bookmark-enrich [id]` | LLM-generated Summary + canonical tags, flip `status: raw` → `enriched` |
| `bookmark-tags` | `scripts/skills/tags.ts` | `/bookmark-tags` | Tag taxonomy — list, audit (Levenshtein), merge, alias, describe |
| `bookmark-graph` | `scripts/skills/graph.ts` | `/bookmark-graph` | Obsidian graph view color groups from `groups.yaml` → `vault/.obsidian/graph.json` |
| `bookmark-query` | `scripts/skills/filter.ts` | `/bookmark-query` | Filter-first Q&A with corpus gates at 15/50 bookmarks |
| `bookmark-digest` | `scripts/skills/filter.ts` (reused) | `/bookmark-digest` | Periodic rollup (week/month/custom) into `vault/x-bookmarks/digests/` |

All CLIs are also exposed as `npm run skill:*` scripts for direct invocation during development.

## Shared plumbing (`scripts/skills/utils.ts`)

Every skill CLI imports from this module:

- `listBookmarks()` — walks `<vault>/x-bookmarks/*.md`, parses YAML frontmatter, returns `ParsedBookmark[]` with `{ filePath, filename, frontmatter, body, tweetId }`.
- `extractFrontmatter(content)` — regex + `yaml.parse` on `^---\n…\n---\n?`.
- `serializeBookmark(fm, body)` — `yaml.stringify` + `---` wrapping. Used by enrich and tags when mutating.
- `loadTaxonomy()` / `saveTaxonomy()` — `.taxonomy.yaml` management (canonicals + aliases).
- `loadEntities()` / `saveEntities()` — `.entities.yaml` for the graph skill.
- `canonicalize(tag, tax)` — resolve a tag through its alias chain.
- `normalizeTagName(tag)` — lowercase, hyphen-separated, ASCII only.

Test coverage for this module lives in [`tests/skill-utils.test.ts`](../tests/skill-utils.test.ts).

## What a skill invocation looks like end-to-end

**Example: `/bookmark-status`**

1. User types `/bookmark-status` in Claude Code.
2. Claude loads `.claude/skills/bookmark-status/SKILL.md`, sees: "Run `tsx --env-file=.env.local scripts/skills/status.ts`".
3. Claude runs the CLI via the Bash tool.
4. The CLI reads every `.md` in the vault, every `.raw/*.json`, computes the dashboard, prints to stdout.
5. Claude relays the stdout verbatim back to the user.

No LLM thinking in the middle — this is pure plumbing. That's deliberate: `status`, `tags`, `graph` are deterministic and should produce identical output regardless of which model runs them.

**Example: `/bookmark-enrich <id>`** (the only skill that uses LLM judgment)

1. Claude runs `enrich-list.ts <id>`, gets the raw JSON path.
2. Claude reads `vault/x-bookmarks/.raw/<id>.json` directly with its Read tool.
3. Claude generates a 3–5 line English summary + 2–5 canonical tags following the style rules in the SKILL.md.
4. Claude runs `enrich-write.ts <id> --summary "…" --tags "a,b,c"`.
5. The writer canonicalizes the tags against `.taxonomy.yaml`, replaces or inserts the `## Summary` section, flips `status`, registers new canonicals, and prints a JSON receipt.

The split matters: Claude owns the creative work (summary, tag selection), the CLI owns the deterministic work (file I/O, canonicalization, atomic writes).

## Adding a new skill

1. Create `.claude/skills/<name>/SKILL.md` with YAML frontmatter (`name`, `description`) and a workflow section. See existing skills for shape.
2. If the skill needs filesystem operations, add a CLI in `scripts/skills/<name>.ts` that imports from `./utils`.
3. Add an `npm run skill:<name>` entry in `package.json`.
4. Reload Claude Code — skills are picked up on session start.

## Why CLIs instead of MCP tools

Claude Code could in principle talk to the vault through an MCP server, but that adds a server process, a schema surface, and protocol overhead for what is ultimately a handful of file operations. A standalone CLI that Claude invokes via Bash is simpler, debuggable (you can `npm run skill:status` yourself), and composable with any shell pipeline. The SKILL.md is the "schema" — it tells Claude when and how to call the tool.
