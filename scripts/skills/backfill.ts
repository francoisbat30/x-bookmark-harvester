/**
 * Backfill des notes existantes — mise au nouveau standard (chantier qualité).
 *
 *   npm run skill:backfill -- --dry-run             # DEVIS seul, zéro appel API, zéro écriture
 *   npm run skill:backfill -- --limit 10            # échantillon : 10 posts stale refetchés + re-rendus
 *   npm run skill:backfill -- --delay 1200          # ms entre refetchs (rate-limit search/all)
 *   npm run skill:backfill --                       # corpus entier (refetch stale + re-render tout)
 *   npm run skill:backfill -- --refetch-all         # re-extraction API de TOUT (rarement utile)
 *   npm run skill:backfill -- --videos              # + téléchargement des mp4
 *
 * Garanties :
 *   - Summary / tags / status des notes enrichies préservés (note-merge) ;
 *   - dédoublonnage par tweet ID intact (writeNote uniqueKey) ;
 *   - idempotent : re-runnable, le cache absorbe les refetchs déjà faits (24 h
 *     de dédup côté X en prime) ;
 *   - jamais de suppression.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { stateDir } from "../../lib/state";
import {
  readCache,
  writeCache,
  writeDownloadedImages,
  type CacheEnvelope,
} from "../../lib/obsidian/cache";
import { planBackfill } from "../../lib/obsidian/backfill";
import { extractPost } from "../../lib/x/extract";
import { mcpConfigFromEnv } from "../../lib/x/mcp-source";
import { downloadImages } from "../../lib/obsidian/media-download";
import { renderNote, buildFilename } from "../../lib/obsidian/markdown";
import { writeNote, readExistingNote } from "../../lib/obsidian/vault";
import { getUsageSnapshot, estimatedCostUsd } from "../../lib/x/usage";

interface Args {
  dryRun: boolean;
  limit: number | null;
  refetchAll: boolean;
  delayMs: number;
  videos: boolean;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let limit: number | null = null;
  let refetchAll = false;
  let delayMs = 1200;
  let videos = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--limit") {
      const n = Number(argv[++i]);
      limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    } else if (a === "--refetch-all") refetchAll = true;
    else if (a === "--delay") {
      const n = Number(argv[++i]);
      delayMs = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1200;
    } else if (a === "--videos") videos = true;
  }
  return { dryRun, limit, refetchAll, delayMs, videos };
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

async function loadAllCaches(): Promise<CacheEnvelope[]> {
  const dir = path.join(stateDir(), ".raw");
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const out: CacheEnvelope[] = [];
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue;
    const env = await readCache(f.replace(/\.json$/, ""));
    if (env) out.push(env);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const envelopes = await loadAllCaches();
  if (envelopes.length === 0) {
    console.error("Aucun cache sous state/.raw — rien à backfiller.");
    process.exit(1);
  }

  const plan = planBackfill(envelopes, {
    limit: args.limit,
    refetchAll: args.refetchAll,
  });

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          ...plan.totals,
          summaryLine: `devis : ${plan.totals.posts} posts (${plan.totals.refetch} refetch, ${plan.totals.rerenderOnly} re-render) · ≤ ${plan.totals.estReadsMax} lectures · ≤ $${plan.totals.estCostMaxUsd.toFixed(2)}`,
        },
        null,
        2,
      ),
    );
    return;
  }

  const bearer = process.env.X_API_BEARER_TOKEN;
  if (plan.totals.refetch > 0 && !bearer) {
    console.error("X_API_BEARER_TOKEN manquant (.env.local) — requis pour les refetchs.");
    process.exit(1);
  }

  const byId = new Map(envelopes.map((e) => [e.tweetId, e]));
  let refetched = 0;
  let rerendered = 0;
  const failed: Array<{ id: string; error: string }> = [];
  const warnings: Array<{ id: string; warnings: string[] }> = [];

  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i];
    const env = byId.get(item.tweetId)!;
    try {
      let post = env.post;

      if (item.refetch && bearer) {
        const r = await extractPost(item.tweetId, {
          url: post.url || `https://x.com/i/status/${item.tweetId}`,
          bearerToken: bearer,
          grokApiKey: process.env.XAI_API_KEY,
          grokModel: process.env.XAI_MODEL,
          mcp: mcpConfigFromEnv(),
        });
        post = r.post;
        await writeCache(item.tweetId, post, r.source);
        if (r.warnings.length > 0) {
          warnings.push({ id: item.tweetId, warnings: r.warnings });
        }
        refetched++;
        if (i < plan.items.length - 1) await sleep(args.delayMs);
      }

      const downloaded = await downloadImages(item.tweetId, post.media, {
        includeVideoFiles: args.videos,
      });
      if (downloaded.length > 0) {
        await writeDownloadedImages(item.tweetId, downloaded);
      }

      const fresh = await readCache(item.tweetId);
      const existingContent = await readExistingNote(
        buildFilename(post),
        item.tweetId,
      );
      const note = renderNote(post, {
        insights: fresh?.grokInsights?.data,
        downloadedImages: fresh?.downloadedImages,
        videoTranscripts: fresh?.videoTranscripts,
        existingContent,
      });
      await writeNote(note.filename, note.content, undefined, {
        overwrite: true,
        uniqueKey: item.tweetId,
      });
      rerendered++;
      console.error(
        `[${i + 1}/${plan.items.length}] ✓ ${item.tweetId}${item.refetch ? " (refetch)" : ""}`,
      );
    } catch (e) {
      failed.push({
        id: item.tweetId,
        error: e instanceof Error ? e.message : String(e),
      });
      console.error(`[${i + 1}/${plan.items.length}] ✗ ${item.tweetId} — ${failed[failed.length - 1].error}`);
    }
  }

  const apiReads = getUsageSnapshot().billedResources;
  const costUsd = estimatedCostUsd();
  const summaryLine = `${rerendered} notes re-rendues (${refetched} refetchées) · ${failed.length} erreur${failed.length === 1 ? "" : "s"} · ~$${costUsd.toFixed(2)}`;

  console.log(
    JSON.stringify(
      {
        ok: true,
        summaryLine,
        planned: plan.totals,
        rerendered,
        refetched,
        failed: failed.length,
        apiReads,
        estimatedCostUsd: costUsd,
        failures: failed,
        warnings,
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
