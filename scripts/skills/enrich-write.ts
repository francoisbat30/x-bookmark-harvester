/**
 * Write an enrichment (summary + tags) onto a bookmark.
 *
 *   tsx --env-file=.env.local scripts/skill-enrich-write.ts <tweetId> \
 *       --summary "3-5 line summary in English" \
 *       --tags "tag1,tag2,tag3"
 *
 * Effects:
 *   - Flip frontmatter status: raw → enriched
 *   - Replace or insert the `## Summary` section right after frontmatter
 *   - Update `tags:` with canonicalized tags (via .taxonomy.yaml + aliases)
 *   - Register any new canonical tags in .taxonomy.yaml
 */
import { promises as fs } from "node:fs";
import {
  listBookmarks,
  loadTaxonomy,
  saveTaxonomy,
  canonicalize,
  normalizeTagName,
  serializeBookmark,
} from "./utils";

interface Args {
  id: string;
  summary: string;
  tags: string[];
}

function parseArgs(argv: string[]): Args {
  let id = "";
  let summary = "";
  const tags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--summary") {
      summary = argv[++i] ?? "";
    } else if (a === "--tags") {
      const v = argv[++i] ?? "";
      for (const t of v.split(",")) {
        const tt = t.trim();
        if (tt) tags.push(tt);
      }
    } else if (!id && !a.startsWith("--")) {
      id = a;
    }
  }
  return { id, summary, tags };
}

function replaceOrInsertSummary(body: string, summary: string): string {
  const section = `## Summary\n\n${summary.trim()}\n`;
  const existing = body.match(
    /(?<=^|\n)##\s+Summary\s*\n[\s\S]+?(?=\n##\s|$)/,
  );
  if (existing) {
    return body.replace(existing[0], section);
  }
  return `${section}\n${body.replace(/^\s+/, "")}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id) {
    console.error("Missing <tweetId>");
    process.exit(1);
  }
  if (!args.summary) {
    console.error("Missing --summary");
    process.exit(1);
  }
  if (args.tags.length === 0) {
    console.error("Missing --tags");
    process.exit(1);
  }

  const bookmarks = await listBookmarks();
  const target = bookmarks.find((b) => b.tweetId === args.id);
  if (!target) {
    console.error(`Bookmark with tweet id ${args.id} not found`);
    process.exit(1);
  }

  const tax = await loadTaxonomy();
  const normalized = args.tags.map((t) => canonicalize(t, tax));
  const merged = Array.from(new Set(["x-bookmark", ...normalized]));

  target.frontmatter.tags = merged;
  target.frontmatter.status = "enriched";
  const newBody = replaceOrInsertSummary(target.body, args.summary);

  await fs.writeFile(
    target.filePath,
    serializeBookmark(target.frontmatter, newBody),
    "utf8",
  );

  let taxChanged = false;
  for (const t of normalized) {
    const canonical = normalizeTagName(t);
    if (!tax.tags[canonical]) {
      tax.tags[canonical] = {};
      taxChanged = true;
    }
  }
  if (taxChanged) await saveTaxonomy(tax);

  console.log(
    JSON.stringify(
      {
        ok: true,
        id: args.id,
        file: target.filename,
        tags: merged,
        status: "enriched",
        newCanonicalTags: taxChanged,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
