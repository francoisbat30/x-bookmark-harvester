/**
 * List bookmarks that still have status: raw, optionally filtered to one id.
 * Output is JSON so Claude can iterate the enrichment one bookmark at a time.
 *
 *   tsx --env-file=.env.local scripts/skill-enrich-list.ts            # all raw
 *   tsx --env-file=.env.local scripts/skill-enrich-list.ts <tweetId>  # just one
 */
import path from "node:path";
import { listBookmarks, rawDir } from "./utils";

async function main() {
  const targetId = process.argv[2] ?? null;
  const bookmarks = await listBookmarks();

  const raw = bookmarks
    .filter((b) => b.frontmatter.status === "raw")
    .filter((b) => !targetId || b.tweetId === targetId)
    .map((b) => ({
      id: b.tweetId,
      filename: b.filename,
      mdPath: b.filePath,
      rawJsonPath: b.tweetId ? path.join(rawDir(), `${b.tweetId}.json`) : null,
      title: b.frontmatter.title,
      author: b.frontmatter.author,
      date: b.frontmatter.date,
    }));

  console.log(JSON.stringify({ count: raw.length, bookmarks: raw }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
