/**
 * Deep Search CLI skill — invoked by the /bookmark-deepsearch slash command
 * or directly via `npm run skill:deepsearch`.
 *
 *   tsx --env-file=.env.local scripts/skills/deep-search.ts "<natural query>"
 *   npm run skill:deepsearch -- "seedance 2.0 capcut prompting"
 *
 * Shares the same cache as the web UI (vault/.deepsearch/<hash>.json), so
 * running the same query in both places within the 2h TTL returns the
 * same result without additional Grok spend.
 *
 * Output: JSON on stdout, identical shape to DeepSearchResult in
 * lib/types.ts. Exit codes: 0 ok, 1 error.
 */
import { hashQuery, runDeepSearch } from "../../lib/x/deep-search";
import {
  readDeepSearchCache,
  touchDeepSearchCache,
  writeDeepSearchCache,
} from "../../lib/obsidian/deep-search-cache";
import type { DeepSearchTimeRange } from "../../lib/types";

const DEFAULT_SUB_QUERIES = 6;

function parseTimeRange(args: string[]): DeepSearchTimeRange {
  const flag = args.find((a) => a.startsWith("--since="));
  if (!flag) return "all";
  const v = flag.slice(8);
  if (
    v === "all" ||
    v === "year" ||
    v === "6months" ||
    v === "3months" ||
    v === "month" ||
    v === "week"
  ) {
    return v;
  }
  return "all";
}

async function main() {
  const args = process.argv.slice(2);
  const forceFresh = args.includes("--fresh");
  const timeRange = parseTimeRange(args);
  const query = args.filter((a) => !a.startsWith("--")).join(" ").trim();

  if (!query) {
    console.error(
      'Usage: tsx scripts/skills/deep-search.ts [--fresh] [--since=<all|year|6months|3months|month|week>] "<natural query>"',
    );
    process.exit(1);
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    console.error("XAI_API_KEY is not set in .env.local");
    process.exit(1);
  }
  const bearerToken = process.env.X_API_BEARER_TOKEN;
  if (!bearerToken) {
    console.error(
      "X_API_BEARER_TOKEN is not set — required for tweet validation",
    );
    process.exit(1);
  }

  const queryHash = hashQuery(query, DEFAULT_SUB_QUERIES, timeRange);

  if (!forceFresh) {
    const cached = await readDeepSearchCache(queryHash);
    if (cached) {
      await touchDeepSearchCache(queryHash);
      console.log(
        JSON.stringify(
          {
            ok: true,
            queryHash: cached.queryHash,
            query: cached.query,
            timeRange: cached.timeRange,
            createdAt: cached.createdAt,
            fromCache: true,
            subQueries: cached.subQueries,
            candidates: cached.candidates,
            stats: cached.stats,
          },
          null,
          2,
        ),
      );
      return;
    }
  }

  try {
    const result = await runDeepSearch({
      naturalQuery: query,
      apiKey,
      model: process.env.XAI_MODEL,
      options: {
        subQueryCount: DEFAULT_SUB_QUERIES,
        enableAggregationRerank: true,
        bearerToken,
        timeRange,
      },
    });
    await writeDeepSearchCache({
      version: 2,
      queryHash: result.queryHash,
      query: result.query,
      subQueryCount: DEFAULT_SUB_QUERIES,
      timeRange: result.timeRange,
      createdAt: result.createdAt,
      lastAccessedAt: result.createdAt,
      subQueries: result.subQueries,
      candidates: result.candidates,
      stats: result.stats,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(
      JSON.stringify({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
