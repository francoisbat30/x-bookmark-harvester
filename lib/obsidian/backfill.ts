/**
 * Planification du backfill des notes existantes (option B validée le
 * 2026-07-12 : échantillon d'abord, devis --dry-run avant toute dépense).
 *
 * Deux gestes par post du corpus :
 *   - re-render : nouveau format + rapatriement des médias depuis les URLs du
 *     cache → gratuit (pas d'appel X API) ;
 *   - refetch : posts « stale » (0 commentaire capturé mais replies > 0) →
 *     re-extraction complète via search/all (thread + commentaires avec likes).
 *
 * Le devis est un PLAFOND : 1 lecture (lookup) + ~3 (posts de l'auteur dans la
 * conversation) + min(replies × 1.2, 100) commentaires (1 page max), le tout à
 * COST_PER_READ_USD. La déduplication 24 h de X ne peut que faire baisser la
 * facture réelle.
 */
import type { CacheEnvelope } from "./cache";
import { COST_PER_READ_USD } from "../x/usage";

export interface BackfillItem {
  tweetId: string;
  /** true = re-extraction API nécessaire (stale), false = re-render seul. */
  refetch: boolean;
  replies: number;
  /** Lectures facturables estimées (0 si re-render seul). */
  estReads: number;
}

export interface BackfillPlan {
  items: BackfillItem[];
  totals: {
    posts: number;
    refetch: number;
    rerenderOnly: number;
    estReadsMax: number;
    estCostMaxUsd: number;
  };
}

export function isStale(env: CacheEnvelope): boolean {
  return env.post.comments.length === 0 && env.post.metrics.replies > 0;
}

function estimateReads(replies: number): number {
  // 1 lookup + ~3 posts d'auteur + page relevancy (~12 max observé) +
  // page recency d'appoint (l'arbre de réponses dépasse souvent le compteur
  // `replies`, qui ne compte que les réponses directes → marge ×1.5, min 30).
  const relevancyReads = 12;
  const recencyReads = Math.min(Math.ceil(Math.max(replies, 20) * 1.5), 100);
  return 1 + 3 + relevancyReads + recencyReads;
}

export interface PlanOptions {
  /** Ne traiter que les N premiers posts du plan (échantillon). */
  limit?: number | null;
  /** Refetcher TOUT le corpus, pas seulement les stale (défaut false). */
  refetchAll?: boolean;
}

/**
 * Construit le plan : les refetch (stale) d'abord — c'est eux qu'un
 * `--limit 10` doit échantillonner — puis les re-render purs.
 */
export function planBackfill(
  envelopes: CacheEnvelope[],
  options: PlanOptions = {},
): BackfillPlan {
  const { limit = null, refetchAll = false } = options;

  const items: BackfillItem[] = envelopes
    .map((env) => {
      const refetch = refetchAll || isStale(env);
      const replies = env.post.metrics.replies;
      return {
        tweetId: env.tweetId,
        refetch,
        replies,
        estReads: refetch ? estimateReads(replies) : 0,
      };
    })
    .sort((a, b) => Number(b.refetch) - Number(a.refetch));

  const kept = limit !== null && limit > 0 ? items.slice(0, limit) : items;

  const refetch = kept.filter((i) => i.refetch).length;
  const estReadsMax = kept.reduce((sum, i) => sum + i.estReads, 0);
  return {
    items: kept,
    totals: {
      posts: kept.length,
      refetch,
      rerenderOnly: kept.length - refetch,
      estReadsMax,
      estCostMaxUsd:
        Math.round(estReadsMax * COST_PER_READ_USD * 100) / 100,
    },
  };
}
