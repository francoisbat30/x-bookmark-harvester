import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DeepSearchCandidate } from "../lib/types";

// Mock xai-responses BEFORE importing deep-search
vi.mock("../lib/x/xai-responses", () => ({
  callResponses: vi.fn(),
  extractText: (p: { output_text?: string }) => p.output_text ?? "",
  stripJsonFences: (s: string) => {
    const trimmed = s.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) return fenced[1].trim();
    return trimmed;
  },
  XAI_RESPONSES_ENDPOINT: "https://api.x.ai/v1/responses",
}));

// Mock hasCache to always return false in tests
vi.mock("../lib/obsidian/cache", () => ({
  hasCache: vi.fn(async () => false),
}));

// Mock the X API bulk lookup
vi.mock("../lib/x/api", () => ({
  bulkLookupTweets: vi.fn(),
  searchRecentTweets: vi.fn(async () => []),
}));

import { callResponses } from "../lib/x/xai-responses";
import { bulkLookupTweets } from "../lib/x/api";
import {
  expandQuery,
  runDeepSearch,
  hashQuery,
} from "../lib/x/deep-search";
import {
  readDeepSearchCache,
  writeDeepSearchCache,
  listDeepSearchHistory,
  deleteDeepSearchCache,
} from "../lib/obsidian/deep-search-cache";

const mockedCallResponses = vi.mocked(callResponses);
const mockedBulkLookup = vi.mocked(bulkLookupTweets);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xbm-deep-"));
  vi.stubEnv("X_BOOKMARK_HOME", tmpDir);
  vi.stubEnv("OBSIDIAN_VAULT_PATH", tmpDir);
  vi.stubEnv("OBSIDIAN_BOOKMARKS_SUBFOLDER", "bm");
  mockedCallResponses.mockReset();
  mockedBulkLookup.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/* ─── helpers ─── */

function mockExpand(queries: string[]) {
  return { output_text: JSON.stringify({ queries }) };
}
function mockSearch(
  links: Array<{ url: string; why: string; format: string }>,
) {
  return { output_text: JSON.stringify({ links }) };
}
function mockAggregate(
  ranked: Array<{ tweetId: string; score: number; rationale: string }>,
) {
  return { output_text: JSON.stringify({ ranked }) };
}

function makeCandidate(
  id: string,
  overrides: Partial<DeepSearchCandidate> = {},
): DeepSearchCandidate {
  return {
    tweetId: id,
    url: `https://x.com/user/status/${id}`,
    authorHandle: "user",
    authorName: "User",
    text: "tweet text",
    date: "2026-04-10",
    format: "post",
    metrics: { likes: 10, retweets: 2, replies: 1 },
    foundBy: [],
    source: "xapi",
    rationale: "",
    mechanicalScore: 0,
    finalScore: 0,
    alreadyCached: false,
    ...overrides,
  };
}

function mockBulk(
  ids: string[],
  opts: { hallucinated?: string[]; format?: Record<string, DeepSearchCandidate["format"]>; date?: Record<string, string> } = {},
) {
  const enriched = new Map<string, DeepSearchCandidate>();
  const missingIds = new Set<string>(opts.hallucinated ?? []);
  for (const id of ids) {
    if (missingIds.has(id)) continue;
    enriched.set(
      id,
      makeCandidate(id, {
        format: opts.format?.[id] ?? "post",
        date: opts.date?.[id] ?? "2026-04-10",
      }),
    );
  }
  return { enriched, missingIds };
}

/* ─── hashQuery ─── */

describe("hashQuery", () => {
  it("is stable for same query + count + range", () => {
    expect(hashQuery("hello world", 6, "all")).toBe(
      hashQuery("hello world", 6, "all"),
    );
  });

  it("changes when count changes", () => {
    expect(hashQuery("hello", 6, "all")).not.toBe(
      hashQuery("hello", 8, "all"),
    );
  });

  it("changes when time range changes", () => {
    expect(hashQuery("hello", 6, "all")).not.toBe(
      hashQuery("hello", 6, "month"),
    );
  });

  it("is case-insensitive and trim-insensitive", () => {
    expect(hashQuery("  Hello  ", 6, "all")).toBe(hashQuery("hello", 6, "all"));
  });
});

/* ─── expandQuery ─── */

describe("expandQuery", () => {
  it("parses Grok JSON output into an array of queries", async () => {
    mockedCallResponses.mockResolvedValueOnce(
      mockExpand(["q1", "q2", "q3", "q4", "q5", "q6"]),
    );
    const result = await expandQuery("theme", 6, "key", "grok-4");
    expect(result).toHaveLength(6);
  });

  it("strips markdown fences in the response", async () => {
    mockedCallResponses.mockResolvedValueOnce({
      output_text: '```json\n{"queries": ["a", "b"]}\n```',
    });
    const result = await expandQuery("theme", 2, "key", "grok-4");
    expect(result).toEqual(["a", "b"]);
  });

  it("throws on invalid JSON", async () => {
    mockedCallResponses.mockResolvedValueOnce({
      output_text: "not json at all",
    });
    await expect(expandQuery("theme", 6, "key", "grok-4")).rejects.toThrow(
      /invalid JSON/,
    );
  });

  it("throws when queries field is missing", async () => {
    mockedCallResponses.mockResolvedValueOnce({
      output_text: JSON.stringify({ wrong: [] }),
    });
    await expect(expandQuery("theme", 6, "key", "grok-4")).rejects.toThrow(
      /missing 'queries'/,
    );
  });
});

/* ─── runDeepSearch with bulk validation ─── */

describe("runDeepSearch", () => {
  it("requires a bearer token", async () => {
    await expect(
      runDeepSearch({ naturalQuery: "theme", apiKey: "key" }),
    ).rejects.toThrow(/X_API_BEARER_TOKEN/);
  });

  it("drops hallucinated IDs reported by bulk lookup", async () => {
    mockedCallResponses.mockResolvedValueOnce(mockExpand(["q1"]));
    mockedCallResponses.mockResolvedValueOnce(
      mockSearch([
        // Fake ID (hallucinated)
        {
          url: "https://x.com/fake/status/1780000000000000000",
          why: "fake",
          format: "post",
        },
        // Real ID
        {
          url: "https://x.com/real/status/1979949365650497770",
          why: "real",
          format: "post",
        },
      ]),
    );
    // Aggregation call — returns nothing useful
    mockedCallResponses.mockResolvedValueOnce(mockAggregate([]));

    mockedBulkLookup.mockResolvedValueOnce(
      mockBulk(["1780000000000000000", "1979949365650497770"], {
        hallucinated: ["1780000000000000000"],
      }),
    );

    const r = await runDeepSearch({
      naturalQuery: "theme",
      apiKey: "key",
      options: {
        subQueryCount: 1,
        bearerToken: "bearer",
      },
    });

    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].tweetId).toBe("1979949365650497770");
    expect(r.stats.hallucinatedCount).toBe(1);
  });

  it("ranks article > thread > post at equal engagement", async () => {
    mockedCallResponses.mockResolvedValueOnce(mockExpand(["q1"]));
    mockedCallResponses.mockResolvedValueOnce(
      mockSearch([
        { url: "https://x.com/u/status/100", why: "post", format: "post" },
        { url: "https://x.com/u/status/101", why: "thread", format: "thread" },
        {
          url: "https://x.com/u/status/102",
          why: "article",
          format: "article",
        },
      ]),
    );
    mockedCallResponses.mockResolvedValueOnce(mockAggregate([]));

    mockedBulkLookup.mockResolvedValueOnce(
      mockBulk(["100", "101", "102"], {
        format: { "100": "post", "101": "thread", "102": "article" },
      }),
    );

    const r = await runDeepSearch({
      naturalQuery: "theme",
      apiKey: "key",
      options: {
        subQueryCount: 1,
        enableAggregationRerank: false,
        bearerToken: "bearer",
      },
    });

    expect(r.candidates.map((c) => c.tweetId)).toEqual(["102", "101", "100"]);
  });

  it("applies time range filter on candidate dates", async () => {
    mockedCallResponses.mockResolvedValueOnce(mockExpand(["q1"]));
    mockedCallResponses.mockResolvedValueOnce(
      mockSearch([
        { url: "https://x.com/u/status/100", why: "old", format: "post" },
        { url: "https://x.com/u/status/101", why: "recent", format: "post" },
      ]),
    );
    mockedCallResponses.mockResolvedValueOnce(mockAggregate([]));

    const today = new Date().toISOString().slice(0, 10);
    const longAgo = "2020-01-01";

    mockedBulkLookup.mockResolvedValueOnce(
      mockBulk(["100", "101"], {
        date: { "100": longAgo, "101": today },
      }),
    );

    const r = await runDeepSearch({
      naturalQuery: "theme",
      apiKey: "key",
      options: {
        subQueryCount: 1,
        enableAggregationRerank: false,
        bearerToken: "bearer",
        timeRange: "week",
      },
    });

    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].tweetId).toBe("101");
    expect(r.stats.timeFilteredCount).toBe(1);
  });

  it("does not apply filter when timeRange is 'all'", async () => {
    mockedCallResponses.mockResolvedValueOnce(mockExpand(["q1"]));
    mockedCallResponses.mockResolvedValueOnce(
      mockSearch([
        { url: "https://x.com/u/status/100", why: "old", format: "post" },
      ]),
    );
    mockedCallResponses.mockResolvedValueOnce(mockAggregate([]));

    mockedBulkLookup.mockResolvedValueOnce(
      mockBulk(["100"], { date: { "100": "2020-01-01" } }),
    );

    const r = await runDeepSearch({
      naturalQuery: "theme",
      apiKey: "key",
      options: {
        subQueryCount: 1,
        enableAggregationRerank: false,
        bearerToken: "bearer",
        timeRange: "all",
      },
    });

    expect(r.candidates).toHaveLength(1);
    expect(r.stats.timeFilteredCount).toBe(0);
  });

  it("skips Grok URLs that aren't status or article", async () => {
    mockedCallResponses.mockResolvedValueOnce(mockExpand(["q1"]));
    mockedCallResponses.mockResolvedValueOnce(
      mockSearch([
        { url: "https://x.com/profile", why: "bogus", format: "post" },
        { url: "https://x.com/u/status/999", why: "ok", format: "post" },
      ]),
    );
    mockedCallResponses.mockResolvedValueOnce(mockAggregate([]));
    mockedBulkLookup.mockResolvedValueOnce(mockBulk(["999"]));

    const r = await runDeepSearch({
      naturalQuery: "theme",
      apiKey: "key",
      options: {
        subQueryCount: 1,
        enableAggregationRerank: false,
        bearerToken: "bearer",
      },
    });

    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].tweetId).toBe("999");
  });

  it("reports accurate stats with bulk lookup call count", async () => {
    mockedCallResponses.mockResolvedValueOnce(mockExpand(["q1", "q2"]));
    mockedCallResponses.mockResolvedValueOnce(
      mockSearch([{ url: "https://x.com/u/status/10", why: "w", format: "post" }]),
    );
    mockedCallResponses.mockResolvedValueOnce(
      mockSearch([{ url: "https://x.com/u/status/20", why: "w", format: "post" }]),
    );
    mockedCallResponses.mockResolvedValueOnce(mockAggregate([]));
    mockedBulkLookup.mockResolvedValueOnce(mockBulk(["10", "20"]));

    const r = await runDeepSearch({
      naturalQuery: "theme",
      apiKey: "key",
      options: {
        subQueryCount: 2,
        bearerToken: "bearer",
      },
    });

    expect(r.stats.grokCallCount).toBe(4); // expand + 2 search + aggregation
    expect(r.stats.xApiCallCount).toBe(1); // one bulk lookup batch
    expect(r.stats.estimatedCost).toBeGreaterThan(0);
  });
});

/* ─── cache ─── */

describe("deep-search cache (version 2)", () => {
  it("returns null when no cache exists", async () => {
    expect(await readDeepSearchCache("nope")).toBeNull();
  });

  it("writes and reads a fresh envelope with timeRange", async () => {
    const hash = hashQuery("test query", 6, "month");
    await writeDeepSearchCache({
      version: 2,
      queryHash: hash,
      query: "test query",
      subQueryCount: 6,
      timeRange: "month",
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      subQueries: ["a", "b"],
      candidates: [],
      stats: {
        grokCallCount: 8,
        xApiCallCount: 1,
        estimatedCost: 0.82,
        elapsedMs: 60000,
      },
    });
    const read = await readDeepSearchCache(hash);
    expect(read).not.toBeNull();
    expect(read!.timeRange).toBe("month");
  });

  it("expires after TTL (2h)", async () => {
    const hash = hashQuery("old", 6, "all");
    const oldDate = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await writeDeepSearchCache({
      version: 2,
      queryHash: hash,
      query: "old",
      subQueryCount: 6,
      timeRange: "all",
      createdAt: oldDate,
      lastAccessedAt: oldDate,
      subQueries: [],
      candidates: [],
      stats: {
        grokCallCount: 0,
        xApiCallCount: 0,
        estimatedCost: 0,
        elapsedMs: 0,
      },
    });
    expect(await readDeepSearchCache(hash)).toBeNull();
  });

  it("lists history sorted by createdAt desc, including timeRange", async () => {
    const h1 = hashQuery("first", 6, "all");
    const h2 = hashQuery("second", 6, "week");
    const base = {
      version: 2 as const,
      subQueryCount: 6,
      subQueries: [],
      candidates: [],
      stats: {
        grokCallCount: 0,
        xApiCallCount: 0,
        estimatedCost: 0.5,
        elapsedMs: 0,
      },
    };
    await writeDeepSearchCache({
      ...base,
      queryHash: h1,
      query: "first",
      timeRange: "all",
      createdAt: "2026-04-15T10:00:00.000Z",
      lastAccessedAt: "2026-04-15T10:00:00.000Z",
    });
    await writeDeepSearchCache({
      ...base,
      queryHash: h2,
      query: "second",
      timeRange: "week",
      createdAt: "2026-04-16T10:00:00.000Z",
      lastAccessedAt: "2026-04-16T10:00:00.000Z",
    });
    const history = await listDeepSearchHistory();
    expect(history).toHaveLength(2);
    expect(history[0].query).toBe("second");
    expect(history[0].timeRange).toBe("week");
    expect(history[1].query).toBe("first");
    expect(history[1].timeRange).toBe("all");
  });

  it("deletes a cache entry", async () => {
    const hash = hashQuery("bye", 6, "all");
    await writeDeepSearchCache({
      version: 2,
      queryHash: hash,
      query: "bye",
      subQueryCount: 6,
      timeRange: "all",
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      subQueries: [],
      candidates: [],
      stats: {
        grokCallCount: 0,
        xApiCallCount: 0,
        estimatedCost: 0,
        elapsedMs: 0,
      },
    });
    await deleteDeepSearchCache(hash);
    expect(await readDeepSearchCache(hash)).toBeNull();
  });
});
