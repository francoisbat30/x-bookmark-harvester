/**
 * Standalone spike / CLI to fetch one X post end-to-end.
 *
 *   npm run spike:grok -- <x-post-url>
 *   npm run spike:grok -- --force <x-post-url>   # bypass cache
 *
 * On first run: calls Grok, writes raw JSON to cache, renders .md.
 * On second run: reads from cache, re-renders .md (no API call).
 */
import { extractPostWithGrok } from "../lib/x/grok-extract";
import { renderNote } from "../lib/obsidian/markdown";
import { writeNote } from "../lib/obsidian/vault";
import { readCache, writeCache } from "../lib/obsidian/cache";
import { parseTweetRef } from "../lib/x/tweet-id";

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const urlArg = args.find((a) => !a.startsWith("--"));

  if (!urlArg) {
    console.error("Usage: npm run spike:grok -- [--force] <x-post-url>");
    process.exit(1);
  }

  const ref = parseTweetRef(urlArg);
  if (!ref) {
    console.error("Invalid X/Twitter URL");
    process.exit(1);
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    console.error("XAI_API_KEY missing in .env.local");
    process.exit(1);
  }

  const cached = force ? null : await readCache(ref.id);
  let post;
  if (cached) {
    console.log(`✓ Cache hit for ${ref.id} (fetched ${cached.fetchedAt}, source=${cached.source})`);
    post = cached.post;
  } else {
    console.log(`→ Extracting ${ref.canonicalUrl}`);
    const t0 = Date.now();
    post = await extractPostWithGrok(ref.canonicalUrl, {
      apiKey,
      model: process.env.XAI_MODEL,
    });
    console.log(`✓ Grok responded in ${Date.now() - t0}ms`);
    await writeCache(ref.id, post, "grok");
    console.log(`✓ Cached raw JSON`);
  }

  console.log("  author:", post.author.handle, "-", post.author.name);
  console.log("  date:", post.date);
  console.log(
    "  text:",
    post.text.slice(0, 120) + (post.text.length > 120 ? "…" : ""),
  );
  console.log("  media:", post.media.length, "items");
  console.log("  comments:", post.comments.length, "items");
  console.log("  metrics:", post.metrics);

  const note = renderNote(post);
  const res = await writeNote(note.filename, note.content, undefined, {
    overwrite: true,
  });
  console.log(`✓ Wrote ${res.absolutePath}`);
}

main().catch((e) => {
  console.error("✗ Spike failed:", e);
  process.exit(1);
});
