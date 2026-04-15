/**
 * Filter bookmarks by tags / author / date / text. Prints JSON to stdout.
 * Shared by /bookmark-query and /bookmark-digest.
 *
 *   tsx --env-file=.env.local scripts/skill-filter.ts \
 *       --tags=video-generation,prompting \
 *       --author=@MaziyarPanahi \
 *       --since=2026-01-01 \
 *       --until=2026-04-30 \
 *       --text="mlx"
 */
import { listBookmarks } from "./utils";

interface Filters {
  tags: string[];
  author: string | null;
  since: string | null;
  until: string | null;
  text: string | null;
}

function parseArgs(argv: string[]): Filters {
  const out: Filters = {
    tags: [],
    author: null,
    since: null,
    until: null,
    text: null,
  };
  for (const a of argv) {
    if (a.startsWith("--tags=")) {
      out.tags = a
        .slice(7)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a.startsWith("--author=")) {
      out.author = a.slice(9).replace(/^@/, "").toLowerCase();
    } else if (a.startsWith("--since=")) {
      out.since = a.slice(8);
    } else if (a.startsWith("--until=")) {
      out.until = a.slice(8);
    } else if (a.startsWith("--text=")) {
      out.text = a.slice(7).toLowerCase();
    }
  }
  return out;
}

function extractSummary(body: string): string {
  const m = body.match(/##\s+Summary\s*\n+([\s\S]+?)(?=\n##|\n---|\s*$)/);
  if (m) return m[1].trim();
  return body
    .replace(/##[^\n]*\n/g, "")
    .slice(0, 300)
    .replace(/\n+/g, " ")
    .trim();
}

async function main() {
  const filters = parseArgs(process.argv.slice(2));
  const bookmarks = await listBookmarks();

  const matched = bookmarks.filter((b) => {
    const fm = b.frontmatter;
    if (filters.tags.length) {
      const hasAny = filters.tags.some((t) => (fm.tags ?? []).includes(t));
      if (!hasAny) return false;
    }
    if (filters.author) {
      const hay = `${fm.author ?? ""} ${fm.author_name ?? ""}`.toLowerCase();
      if (!hay.includes(filters.author)) return false;
    }
    if (filters.since && (fm.date ?? "") < filters.since) return false;
    if (filters.until && (fm.date ?? "") > filters.until) return false;
    if (filters.text) {
      const hay = `${fm.title ?? ""} ${b.body}`.toLowerCase();
      if (!hay.includes(filters.text)) return false;
    }
    return true;
  });

  const result = matched.map((b) => ({
    id: b.tweetId,
    filename: b.filename,
    path: b.filePath,
    title: b.frontmatter.title,
    author: b.frontmatter.author,
    date: b.frontmatter.date,
    tags: b.frontmatter.tags ?? [],
    status: b.frontmatter.status,
    likes: b.frontmatter.likes,
    summary: extractSummary(b.body),
  }));

  console.log(JSON.stringify({ count: result.length, bookmarks: result }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
