/**
 * Standalone spike for X API v2 stage-1 extraction.
 *
 *   npm run spike:xapi -- <x-post-url-or-id>
 *
 * Writes raw JSON to vault/x-bookmarks/.raw/<id>.xapi.json so it can
 * be diffed against the Grok cache (<id>.json). Does NOT overwrite
 * the main cache — this is for side-by-side comparison.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { extractPostWithXApi } from "../lib/x/api";
import { renderNote } from "../lib/obsidian/markdown";
import { parseTweetRef } from "../lib/x/tweet-id";
import { getVaultConfig, resolveTargetDir } from "../lib/obsidian/vault";
import type { CacheEnvelope } from "../lib/obsidian/cache";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: npm run spike:xapi -- <x-post-url-or-id>");
    process.exit(1);
  }
  const ref = parseTweetRef(arg);
  const tweetId = ref?.id ?? arg;

  const bearer = process.env.X_API_BEARER_TOKEN;
  if (!bearer) {
    console.error("X_API_BEARER_TOKEN missing in .env.local");
    process.exit(1);
  }

  console.log(`→ Fetching tweet ${tweetId} via X API v2`);
  const t0 = Date.now();
  const post = await extractPostWithXApi(tweetId, { bearerToken: bearer });
  const elapsed = Date.now() - t0;
  console.log(`✓ X API responded in ${elapsed}ms`);
  console.log("  author:", post.author.handle, "-", post.author.name);
  console.log("  date:", post.date);
  console.log(
    "  text:",
    post.text.slice(0, 120) + (post.text.length > 120 ? "…" : ""),
  );
  console.log("  media:", post.media.length, "items");
  console.log("  comments:", post.comments.length, "items");
  console.log("  metrics:", post.metrics);

  const rawDir = path.join(resolveTargetDir(getVaultConfig()), ".raw");
  await fs.mkdir(rawDir, { recursive: true });
  const envelope: CacheEnvelope = {
    source: "xapi",
    fetchedAt: new Date().toISOString(),
    tweetId,
    post,
  };
  const jsonPath = path.join(rawDir, `${tweetId}.xapi.json`);
  await fs.writeFile(jsonPath, JSON.stringify(envelope, null, 2), "utf8");
  console.log(`✓ Wrote ${jsonPath}`);

  const note = renderNote(post);
  const mdPath = path.join(rawDir, `${tweetId}.xapi.md`);
  await fs.writeFile(mdPath, note.content, "utf8");
  console.log(`✓ Wrote ${mdPath}`);
}

main().catch((e) => {
  console.error("✗ X API spike failed:", e);
  process.exit(1);
});
