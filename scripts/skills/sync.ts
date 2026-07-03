/**
 * Headless bookmark sync — the CLI twin of the UI Sync button.
 *
 * Pulls all bookmarks from the authenticated X account, then for each one not
 * already cached, runs the same extraction pipeline as the `extractBookmark`
 * server action: X API fetch → cache → image download → render → write note.
 *
 *   tsx --env-file=.env.local scripts/skills/sync.ts                 # process all new
 *   tsx --env-file=.env.local scripts/skills/sync.ts --limit 10      # first 10 new only
 *   tsx --env-file=.env.local scripts/skills/sync.ts --dry-run       # list new, write nothing
 *   tsx --env-file=.env.local scripts/skills/sync.ts --delay 1100    # ms between posts (rate-limit cushion)
 *
 * Auth:
 *   - Bookmark listing uses the stored OAuth user token (auth.json), which is
 *     refreshed automatically via the refresh_token (offline.access scope).
 *   - Per-tweet extraction uses X_API_BEARER_TOKEN (app bearer), like the UI.
 *
 * Output is a JSON summary so a Claude routine can act on the result.
 */
import path from "node:path";
import { getValidAccessToken } from "../../lib/x/auth";
import { fetchAllBookmarks } from "../../lib/x/bookmarks";
import { extractPostWithXApi } from "../../lib/x/api";
import { downloadImages } from "../../lib/obsidian/media-download";
import { renderNote } from "../../lib/obsidian/markdown";
import { writeNote } from "../../lib/obsidian/vault";
import {
  readCache,
  writeCache,
  writeDownloadedImages,
  hasCache,
} from "../../lib/obsidian/cache";
import type { PostExtraction } from "../../lib/types";

interface Args {
  limit: number | null;
  dryRun: boolean;
  delayMs: number;
}

function parseArgs(argv: string[]): Args {
  let limit: number | null = null;
  let dryRun = false;
  let delayMs = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") {
      const n = Number(argv[++i]);
      limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--delay") {
      const n = Number(argv[++i]);
      delayMs = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    }
  }
  return { limit, dryRun, delayMs };
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

interface ProcessOk {
  ok: true;
  id: string;
  filename: string;
  absolutePath: string;
}
interface ProcessErr {
  ok: false;
  id: string;
  error: string;
}

async function processBookmark(
  id: string,
  bearer: string,
): Promise<ProcessOk | ProcessErr> {
  try {
    const post: PostExtraction = await extractPostWithXApi(id, {
      bearerToken: bearer,
    });
    await writeCache(id, post, "xapi");

    const downloaded = await downloadImages(id, post.media);
    if (downloaded.length > 0) {
      await writeDownloadedImages(id, downloaded);
    }

    const freshCache = await readCache(id);
    const note = renderNote(post, {
      insights: freshCache?.grokInsights?.data,
      downloadedImages: freshCache?.downloadedImages,
    });
    const written = await writeNote(note.filename, note.content, undefined, {
      overwrite: true,
      uniqueKey: id,
    });

    return {
      ok: true,
      id,
      filename: written.filename,
      absolutePath: written.absolutePath,
    };
  } catch (e) {
    return { ok: false, id, error: e instanceof Error ? e.message : String(e) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    console.error(
      "Not authenticated. Open the app and connect X once (the OAuth token is then refreshed automatically).",
    );
    process.exit(1);
  }

  const bearer = process.env.X_API_BEARER_TOKEN;
  if (!bearer) {
    console.error("X_API_BEARER_TOKEN is not set in .env.local");
    process.exit(1);
  }

  const bookmarks = await fetchAllBookmarks({ accessToken });

  const withStatus = await Promise.all(
    bookmarks.map(async (b) => ({ ...b, alreadyCached: await hasCache(b.id) })),
  );
  const known = withStatus.filter((b) => b.alreadyCached);
  let pending = withStatus.filter((b) => !b.alreadyCached);

  const skippedByLimit =
    args.limit !== null ? Math.max(0, pending.length - args.limit) : 0;
  if (args.limit !== null) pending = pending.slice(0, args.limit);

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          total: withStatus.length,
          known: known.length,
          new: pending.length + skippedByLimit,
          wouldProcess: pending.map((b) => ({
            id: b.id,
            author: b.authorHandle,
            text: b.text.slice(0, 80),
          })),
          skippedByLimit,
        },
        null,
        2,
      ),
    );
    return;
  }

  const processed: ProcessOk[] = [];
  const failed: ProcessErr[] = [];
  for (let i = 0; i < pending.length; i++) {
    const b = pending[i];
    const result = await processBookmark(b.id, bearer);
    if (result.ok) processed.push(result);
    else failed.push(result);
    console.error(
      `[${i + 1}/${pending.length}] ${result.ok ? "✓" : "✗"} ${b.id} @${b.authorHandle}` +
        (result.ok ? "" : ` — ${result.error}`),
    );
    if (i < pending.length - 1) await sleep(args.delayMs);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        total: withStatus.length,
        known: known.length,
        processed: processed.length,
        failed: failed.length,
        skippedByLimit,
        vaultDir: path.dirname(processed[0]?.absolutePath ?? ""),
        failures: failed,
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
