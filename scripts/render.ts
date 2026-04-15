/**
 * Re-generate a .md file from the cached raw JSON without re-calling Grok.
 *
 * Usage:
 *   npm run render -- <tweet-id-or-url>
 *
 * Useful for:
 *   - iterating on the markdown template
 *   - fixing a wrong rendering without paying the API again
 *   - batch re-rendering all cached posts (`all`)
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { readCache } from "../lib/obsidian/cache";
import { renderNote } from "../lib/obsidian/markdown";
import { writeNote, getVaultConfig, resolveTargetDir } from "../lib/obsidian/vault";
import { parseTweetRef } from "../lib/x/tweet-id";

async function renderOne(tweetId: string): Promise<void> {
  const cached = await readCache(tweetId);
  if (!cached) {
    console.error(`✗ No cache for ${tweetId}`);
    process.exitCode = 1;
    return;
  }
  const note = renderNote(cached.post, {
    insights: cached.grokInsights?.data,
    downloadedImages: cached.downloadedImages,
  });
  const { absolutePath } = await writeNote(note.filename, note.content, undefined, {
    overwrite: true,
  });
  console.log(`✓ ${tweetId} → ${absolutePath}`);
}

async function renderAll(): Promise<void> {
  const dir = path.join(resolveTargetDir(getVaultConfig()), ".raw");
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const ids = entries
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ""));
  if (ids.length === 0) {
    console.log("No cached posts found.");
    return;
  }
  console.log(`Re-rendering ${ids.length} cached post(s)…`);
  for (const id of ids) {
    await renderOne(id);
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: npm run render -- <tweet-id-or-url|all>");
    process.exit(1);
  }

  if (arg === "all") {
    await renderAll();
    return;
  }

  const ref = parseTweetRef(arg);
  const tweetId = ref?.id ?? arg;
  await renderOne(tweetId);
}

main().catch((e) => {
  console.error("✗ Render failed:", e);
  process.exit(1);
});
