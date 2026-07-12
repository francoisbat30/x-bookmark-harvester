import { describe, it, expect } from "vitest";
import { planBackfill, isStale } from "../lib/obsidian/backfill";
import type { CacheEnvelope } from "../lib/obsidian/cache";

function env(id: string, replies: number, comments: number): CacheEnvelope {
  return {
    version: 2,
    source: "xapi",
    fetchedAt: "2026-07-01T00:00:00.000Z",
    tweetId: id,
    post: {
      url: `https://x.com/u/status/${id}`,
      author: { handle: "u", name: "U" },
      date: "2026-01-01",
      text: "t",
      media: [],
      metrics: { likes: 0, retweets: 0, replies, views: 0 },
      comments: Array.from({ length: comments }, (_, i) => ({
        handle: `c${i}`,
        name: "",
        date: "",
        text: "some comment text long enough",
      })),
    },
  };
}

describe("isStale", () => {
  it("stale = replies>0 et 0 commentaire capturé", () => {
    expect(isStale(env("1", 10, 0))).toBe(true);
    expect(isStale(env("2", 0, 0))).toBe(false);
    expect(isStale(env("3", 10, 4))).toBe(false);
  });
});

describe("planBackfill", () => {
  const corpus = [
    env("a", 0, 0), // re-render seul
    env("b", 40, 0), // stale
    env("c", 10, 5), // re-render seul (commentaires déjà là)
    env("d", 6000, 0), // stale, gros volume → plafonné à 100 lectures de commentaires
  ];

  it("met les refetchs en premier et chiffre le plafond", () => {
    const plan = planBackfill(corpus);
    expect(plan.items.slice(0, 2).every((i) => i.refetch)).toBe(true);
    expect(plan.totals).toMatchObject({
      posts: 4,
      refetch: 2,
      rerenderOnly: 2,
    });
    // b(40 replies): 1+3+12+60=76 ; d(6000): 1+3+12+100=116 → 192 ≤ $0.96
    expect(plan.totals.estReadsMax).toBe(192);
    expect(plan.totals.estCostMaxUsd).toBe(0.96);
  });

  it("--limit échantillonne d'abord les stale", () => {
    const plan = planBackfill(corpus, { limit: 2 });
    expect(plan.items).toHaveLength(2);
    expect(plan.items.every((i) => i.refetch)).toBe(true);
  });

  it("--refetch-all force la re-extraction de tout", () => {
    const plan = planBackfill(corpus, { refetchAll: true });
    expect(plan.totals.refetch).toBe(4);
    expect(plan.totals.rerenderOnly).toBe(0);
  });

  it("le re-render seul coûte zéro lecture", () => {
    const plan = planBackfill([env("a", 0, 0), env("c", 10, 5)]);
    expect(plan.totals.estReadsMax).toBe(0);
    expect(plan.totals.estCostMaxUsd).toBe(0);
  });
});
