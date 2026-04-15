/**
 * bookmark-status skill CLI — health check + inventory.
 *
 *   tsx --env-file=.env.local scripts/skill-status.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { listBookmarks, rawDir, tweetIdFromSource } from "./utils";

interface Issue {
  severity: "warn" | "info";
  message: string;
}

async function main() {
  const bookmarks = await listBookmarks();

  let cachedIds: string[] = [];
  try {
    const entries = await fs.readdir(rawDir());
    cachedIds = entries
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => f.slice(0, -5));
  } catch {
    // raw dir missing — treat as empty
  }
  const cachedSet = new Set(cachedIds);

  const now = Date.now();
  const sevenDays = 7 * 24 * 3600 * 1000;

  const byStatus: Record<string, number> = { raw: 0, enriched: 0 };
  const authors: Record<string, number> = {};
  const tags: Record<string, number> = {};
  const issues: Issue[] = [];

  let totalComments = 0;
  let commentedBookmarks = 0;

  const mdIds = new Set<string>();

  for (const b of bookmarks) {
    const fm = b.frontmatter;
    const status = fm.status ?? "raw";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (fm.author) authors[fm.author] = (authors[fm.author] ?? 0) + 1;
    for (const t of fm.tags ?? []) tags[t] = (tags[t] ?? 0) + 1;

    const id = tweetIdFromSource(fm.source);
    if (id) mdIds.add(id);

    if (id) {
      const rawPath = path.join(rawDir(), `${id}.json`);
      try {
        const raw = JSON.parse(await fs.readFile(rawPath, "utf8"));
        const commentsLen = raw.post?.comments?.length ?? 0;
        totalComments += commentsLen;
        commentedBookmarks++;
        const postTs = fm.date ? new Date(fm.date).getTime() : NaN;
        if (
          commentsLen === 0 &&
          !Number.isNaN(postTs) &&
          now - postTs > sevenDays
        ) {
          issues.push({
            severity: "warn",
            message: `${b.filename}: 0 comments and post > 7 days old (X API window missed). Retry with --useGrok.`,
          });
        }
      } catch {
        issues.push({
          severity: "warn",
          message: `${b.filename}: raw cache missing (orphan .md).`,
        });
      }
    }
  }

  for (const rawId of cachedSet) {
    if (!mdIds.has(rawId)) {
      issues.push({
        severity: "info",
        message: `orphan cache: .raw/${rawId}.json has no matching .md (delete or re-render)`,
      });
    }
  }

  if (byStatus.raw > 0) {
    issues.push({
      severity: "info",
      message: `${byStatus.raw} bookmark(s) still status:raw. Run /bookmark-enrich.`,
    });
  }

  console.log(
    `\n📚 X Bookmark Library — ${new Date().toISOString().slice(0, 10)}\n`,
  );
  console.log(`   Total bookmarks       : ${bookmarks.length}`);
  console.log(`   Status raw            : ${byStatus.raw ?? 0}`);
  console.log(`   Status enriched       : ${byStatus.enriched ?? 0}`);
  if (commentedBookmarks > 0) {
    console.log(
      `   Avg comments/bookmark : ${Math.round(totalComments / commentedBookmarks)}`,
    );
  }
  console.log(`   Cached raw JSON       : ${cachedSet.size}`);

  const topAuthors = Object.entries(authors)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  if (topAuthors.length) {
    console.log(`\n   Top authors:`);
    for (const [a, c] of topAuthors) {
      console.log(`     ${String(c).padStart(3)}  ${a}`);
    }
  }

  const topTags = Object.entries(tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  if (topTags.length) {
    console.log(`\n   Top tags:`);
    for (const [t, c] of topTags) {
      console.log(`     ${String(c).padStart(3)}  ${t}`);
    }
  }

  if (issues.length > 0) {
    console.log(`\n   ⚠️  Issues (${issues.length}):`);
    for (const issue of issues) {
      const prefix = issue.severity === "warn" ? "⚠" : "·";
      console.log(`     ${prefix} ${issue.message}`);
    }
  } else {
    console.log(`\n   ✓ No issues detected.`);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
