import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

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

// Mock X API search to return nothing by default (no bearer token set)
vi.mock("../lib/x/api", () => ({
  searchRecentTweets: vi.fn(async () => []),
}));

import { callResponses } from "../lib/x/xai-responses";
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

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xbm-deep-"));
  vi.stubEnv("X_BOOKMARK_HOME", tmpDir);
  vi.stubEnv("OBSIDIAN_VAULT_PATH", tmpDir);
  vi.stubEnv("OBSIDIAN_BOOKMARKS_SUBFOLDER", "bm");
  mockedCallResponses.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function mockExpand(queries: string[]) {
  return {
    output_text: JSON.stringify({ queries }),
  };
}

function mockSearch(links: Array<{ url: string; why: string; format: string }>) {
  return {
    output_text: JSON.stringify({ links }),
  };
}

function mockAggregate(ranked: Array<{ tweetId: string; score: number; rationale: string }>) {
  return {
    output_text: JSON.stringify({ ranked }),
  };
}

describe("hashQuery", () => {
  it("is stable for same query + count", () => {
    expect(hashQuery("hello world", 6)).toBe(hashQuery("hello world", 6));
  });

  it("changes when count changes", () => {
    expect(hashQuery("hello", 6)).not.toBe(hashQuery("hello", 8));
  });

  it("is case-insensitive and trim-insensitive", () => {
    expect(hashQuery("  Hello  ", 6)).toBe(hashQuery("hello", 6));
  });
});

describe("expandQuery", () => {
  it("parses Grok JSON output into an array of queries", async () => {
    mockedCallResponses.mockResolvedValueOnce(
      mockExpand(["q1", "q2", "q3", "q4", "q5", "q6"]),
    );
    const result = await expandQuery("theme", 6, "key", "grok-4");
    expect(result).toHaveLength(6);
    expect(result[0]).toBe("q1");
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

  it("clips to requested count when Grok returns more", async () => {
    mockedCallResponses.mockResolvedValueOnce(
      mockExpand(["a", "b", "c", "d", "e", "f", "g", "h"]),
    );
    const result = await expandQuery("theme", 6, "key", "grok-4");
    expect(result).toHaveLength(6);
  });
});

describe("runDeepSearch", () => {
  function setupFullRun(
    subQueries: string[],
    linksPerQuery: number,
    overlapCount = 0,
  ) {
    // Expansion call
    mockedCallResponses.mockResolvedValueOnce(mockExpand(subQueries));

    // N search calls, each returning `linksPerQuery` links.
    // overlapCount links are shared across queries (same tweetId) to test dedup.
    for (let i = 0; i < subQueries.length; i++) {
      const links: Array<{ url: string; why: string; format: string }> = [];
      for (let j = 0; j < linksPerQuery; j++) {
        // First `overlapCount` links are shared (same id 1000-1000+overlap)
        const id =
          j < overlapCount ? 1000 + j : 2000 + i * 100 + j;
        const format = j === 0 ? "article" : j === 1 ? "thread" : "post";
        links.push({
          url: `https://x.com/user${i}/status/${id}`,
          why: `why ${i}-${j}`,
          format,
        });
      }
      mockedCallResponses.mockResolvedValueOnce(mockSearch(links));
    }

    // Aggregation call — return scores in reverse order so we can assert reordering
    const expectedCount =
      subQueries.length * linksPerQuery - (subQueries.length - 1) * overlapCount;
    const ranked: Array<{ tweetId: string; score: number; rationale: string }> = [];
    // Will be populated based on actual candidates after dedup, done inside test
    mockedCallResponses.mockResolvedValueOnce(mockAggregate(ranked));

    return expectedCount;
  }

  it("dedupes by tweetId across sub-queries", async () => {
    setupFullRun(["a", "b", "c"], 5, 2);

    const r = await runDeepSearch({
      naturalQuery: "theme",
      apiKey: "key",
      options: { enableAggregationRerank: false },
    });

    // 3 queries × 5 links = 15 raw, minus duplicates:
    // 2 links are shared across 3 queries = 2 unique + 3*3 non-shared = 2+9 = 11
    expect(r.candidates.length).toBe(11);
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

    const r = await runDeepSearch({
      naturalQuery: "theme",
      apiKey: "key",
      options: { subQueryCount: 1, enableAggregationRerank: false },
    });

    expect(r.candidates.map((c) => c.tweetId)).toEqual(["102", "101", "100"]);
  });

  it("boosts candidates matched by multiple sub-queries", async () => {
    mockedCallResponses.mockResolvedValueOnce(mockExpand(["a", "b"]));
    mockedCallResponses.mockResolvedValueOnce(
      mockSearch([
        {
          url: "https://x.com/u/status/500",
          why: "shared",
          format: "post",
        },
      ]),
    );
    mockedCallResponses.mockResolvedValueOnce(
      mockSearch([
        {
          url: "https://x.com/u/status/500",
          why: "shared-again",
          format: "post",
        },
        {
          url: "https://x.com/u/status/600",
          why: "solo",
          format: "post",
        },
      ]),
    );

    const r = await runDeepSearch({
      naturalQuery: "theme",
      apiKey: "key",
      options: { subQueryCount: 2, enableAggregationRerank: false },
    });

    const five = r.candidates.find((c) => c.tweetId === "500");
    const six = r.candidates.find((c) => c.tweetId === "600");
    expect(five).toBeDefined();
    expect(six).toBeDefined();
    expect(five!.foundBy).toHaveLength(2);
    expect(five!.finalScore).toBeGreaterThan(six!.finalScore);
  });

  it("skips URLs that are not status or article URLs", async () => {
    mockedCallResponses.mockResolvedValueOnce(mockExpand(["q1"]));
    mockedCallResponses.mockResolvedValueOnce(
      mockSearch([
        { url: "https://x.com/user", why: "profile", format: "post" },
        {
          url: "https://x.com/u/status/999",
          why: "ok",
          format: "post",
        },
      ]),
    );

    const r = await runDeepSearch({
      naturalQuery: "theme",
      apiKey: "key",
      options: { subQueryCount: 1, enableAggregationRerank: false },
    });

    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].tweetId).toBe("999");
  });

  it("reports accurate stats", async () => {
    mockedCallResponses.mockResolvedValueOnce(mockExpand(["q1", "q2"]));
    mockedCallResponses.mockResolvedValueOnce(mockSearch([]));
    mockedCallResponses.mockResolvedValueOnce(mockSearch([]));

    const r = await runDeepSearch({
      naturalQuery: "theme",
      apiKey: "key",
      options: { subQueryCount: 2, enableAggregationRerank: false },
    });

    expect(r.stats.grokCallCount).toBe(3); // 1 expand + 2 searches
    expect(r.stats.xApiCallCount).toBe(0); // no bearer
    expect(r.stats.estimatedCost).toBeGreaterThan(0);
  });
});

describe("deep-search cache", () => {
  it("returns null when no cache exists", async () => {
    expect(await readDeepSearchCache("nope")).toBeNull();
  });

  it("writes and reads a fresh envelope", async () => {
    const hash = hashQuery("test query", 6);
    const envelope = {
      version: 1 as const,
      queryHash: hash,
      query: "test query",
      subQueryCount: 6,
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      subQueries: ["a", "b"],
      candidates: [],
      stats: {
        grokCallCount: 8,
        xApiCallCount: 0,
        estimatedCost: 0.82,
        elapsedMs: 60000,
      },
    };
    await writeDeepSearchCache(envelope);
    const read = await readDeepSearchCache(hash);
    expect(read).not.toBeNull();
    expect(read!.query).toBe("test query");
    expect(read!.stats.estimatedCost).toBe(0.82);
  });

  it("expires after TTL (2h)", async () => {
    const hash = hashQuery("old", 6);
    const oldDate = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await writeDeepSearchCache({
      version: 1,
      queryHash: hash,
      query: "old",
      subQueryCount: 6,
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
    const read = await readDeepSearchCache(hash);
    expect(read).toBeNull();
  });

  it("lists history sorted by createdAt desc", async () => {
    const h1 = hashQuery("first", 6);
    const h2 = hashQuery("second", 6);
    const base = {
      version: 1 as const,
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
      createdAt: "2026-04-15T10:00:00.000Z",
      lastAccessedAt: "2026-04-15T10:00:00.000Z",
    });
    await writeDeepSearchCache({
      ...base,
      queryHash: h2,
      query: "second",
      createdAt: "2026-04-16T10:00:00.000Z",
      lastAccessedAt: "2026-04-16T10:00:00.000Z",
    });
    const history = await listDeepSearchHistory();
    expect(history).toHaveLength(2);
    expect(history[0].query).toBe("second");
    expect(history[1].query).toBe("first");
  });

  it("deletes a cache entry", async () => {
    const hash = hashQuery("bye", 6);
    await writeDeepSearchCache({
      version: 1,
      queryHash: hash,
      query: "bye",
      subQueryCount: 6,
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
