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
import {
  getValidAccessToken,
  getAllValidAccessTokens,
} from "../../lib/x/auth";
import {
  fetchAllBookmarks,
  getAuthenticatedUserId,
  type BookmarkSummary,
} from "../../lib/x/bookmarks";
import { extractPost } from "../../lib/x/extract";
import { mcpConfigFromEnv } from "../../lib/x/mcp-source";
import { downloadImages } from "../../lib/obsidian/media-download";
import { renderNote } from "../../lib/obsidian/markdown";
import { writeNote } from "../../lib/obsidian/vault";
import {
  readCache,
  writeCache,
  writeDownloadedImages,
  hasCache,
} from "../../lib/obsidian/cache";

interface Args {
  limit: number | null;
  dryRun: boolean;
  delayMs: number;
  account: string | null;
}

function parseArgs(argv: string[]): Args {
  let limit: number | null = null;
  let dryRun = false;
  let delayMs = 0;
  let account: string | null = null;
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
    } else if (a === "--account") {
      account = argv[++i] ?? null;
    }
  }
  return { limit, dryRun, delayMs, account };
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
  authorHandle: string,
): Promise<ProcessOk | ProcessErr> {
  try {
    // Source chain: X API (or MCP if enabled) primary → Grok fallback when the
    // primary fails or is missing text/author/comments. See lib/x/extract.ts.
    const { post, source } = await extractPost(id, {
      url: `https://x.com/${authorHandle || "i"}/status/${id}`,
      bearerToken: bearer,
      grokApiKey: process.env.XAI_API_KEY,
      grokModel: process.env.XAI_MODEL,
      mcp: mcpConfigFromEnv(),
    });
    await writeCache(id, post, source);

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

  const bearer = process.env.X_API_BEARER_TOKEN;
  if (!bearer) {
    console.error("X_API_BEARER_TOKEN is not set in .env.local");
    process.exit(1);
  }

  // 1. Resolve which accounts to sync: a single --account <label>, else every
  //    connected account (auth.json + auth.<handle>.json), each token refreshed.
  let sessions: Array<{ label: string; accessToken: string }>;
  if (args.account) {
    const token = await getValidAccessToken(args.account);
    if (!token) {
      console.error(
        `Account "${args.account}" is not connected (or its token expired). Run: npm run skill:accounts`,
      );
      process.exit(1);
    }
    sessions = [{ label: args.account, accessToken: token }];
  } else {
    sessions = await getAllValidAccessTokens();
    if (sessions.length === 0) {
      console.error(
        "No connected account. Open the app and connect X once (the OAuth token is then refreshed automatically).",
      );
      process.exit(1);
    }
  }

  // 2. Fetch each account's bookmarks, dedup accounts by X user id (so the same
  //    account reachable under two labels isn't fetched twice), then merge all
  //    bookmarks into one set keyed by tweet id. The cache-level dedup
  //    (state/.raw/<id>.json) already converges cross-account duplicates to a
  //    single note; this in-memory dedup keeps counts honest and avoids
  //    processing the same tweet twice within one run.
  const seenUsers = new Set<string>();
  const accountsInfo: Array<{ label: string; username: string; total: number }> =
    [];
  const merged = new Map<string, BookmarkSummary>();

  for (const s of sessions) {
    let me: { id: string; username: string; name: string };
    try {
      me = await getAuthenticatedUserId(s.accessToken);
    } catch (e) {
      console.error(
        `[${s.label}] identity lookup failed — skipping: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    if (seenUsers.has(me.id)) {
      console.error(
        `[${s.label}] same X user as an already-synced account (@${me.username}) — skipping duplicate.`,
      );
      continue;
    }
    seenUsers.add(me.id);

    const bms = await fetchAllBookmarks({ accessToken: s.accessToken, me });
    for (const b of bms) if (!merged.has(b.id)) merged.set(b.id, b);
    accountsInfo.push({ label: s.label, username: me.username, total: bms.length });
  }

  const bookmarks = [...merged.values()];

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
          accounts: accountsInfo,
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
    const result = await processBookmark(b.id, bearer, b.authorHandle);
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
        accounts: accountsInfo,
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
