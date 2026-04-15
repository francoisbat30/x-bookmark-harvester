import type {
  DeepSearchCandidate,
  PostComment,
  PostExtraction,
  PostMedia,
} from "../types";
import { recordApiCall } from "./usage";

const BASE = "https://api.x.com/2";

const TWEET_FIELDS =
  "created_at,public_metrics,text,conversation_id,author_id,attachments,entities,referenced_tweets,note_tweet,article";
const USER_FIELDS = "username,name";
const MEDIA_FIELDS = "url,preview_image_url,type,variants";
const EXPANSIONS =
  "author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id";

export interface XApiClientOptions {
  bearerToken: string;
  /** Max replies to fetch from conversation search. Default 100 (API max per call). */
  maxReplies?: number;
}

interface XUser {
  id: string;
  username: string;
  name: string;
}

interface XMedia {
  media_key: string;
  type: "photo" | "video" | "animated_gif";
  url?: string;
  preview_image_url?: string;
  variants?: Array<{ bit_rate?: number; content_type: string; url: string }>;
}

interface XTweet {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  conversation_id: string;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    impression_count?: number;
  };
  attachments?: { media_keys?: string[] };
  referenced_tweets?: Array<{ type: "replied_to" | "quoted" | "retweeted"; id: string }>;
  note_tweet?: { text: string };
  article?: {
    title?: string;
    preview_text?: string;
    plain_text?: string;
    cover_media?: string;
    media_entities?: string[];
  };
}

interface XIncludes {
  users?: XUser[];
  media?: XMedia[];
  tweets?: XTweet[];
}

interface XTweetResponse {
  data?: XTweet;
  includes?: XIncludes;
  errors?: Array<{ title: string; detail: string }>;
}

interface XSearchResponse {
  data?: XTweet[];
  includes?: XIncludes;
  meta?: { result_count: number; next_token?: string };
  errors?: Array<{ title: string; detail: string }>;
}

async function xFetch<T>(path: string, bearerToken: string): Promise<T> {
  const maxAttempts = 3;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
    });
    recordApiCall(res.headers, path);
    if (res.ok) {
      return (await res.json()) as T;
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      const backoffMs = retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, backoffMs));
      lastErr = new Error(`X API 429 (attempt ${attempt + 1})`);
      continue;
    }
    if (res.status >= 500 && res.status < 600) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      lastErr = new Error(`X API ${res.status} (attempt ${attempt + 1})`);
      continue;
    }
    const body = await res.text();
    throw new Error(`X API ${res.status} on ${path}: ${body.slice(0, 500)}`);
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("X API: max retries exhausted");
}

export async function extractPostWithXApi(
  tweetId: string,
  options: XApiClientOptions,
): Promise<PostExtraction> {
  const { bearerToken, maxReplies = 300 } = options;
  const hardCap = Math.min(Math.max(maxReplies, 10), 500);

  const tweetParams = new URLSearchParams({
    "tweet.fields": TWEET_FIELDS,
    "user.fields": USER_FIELDS,
    "media.fields": MEDIA_FIELDS,
    expansions: EXPANSIONS,
  });

  const main = await xFetch<XTweetResponse>(
    `/tweets/${tweetId}?${tweetParams}`,
    bearerToken,
  );

  if (main.errors?.length) {
    throw new Error(`X API errors: ${JSON.stringify(main.errors)}`);
  }
  if (!main.data) {
    throw new Error(`X API returned no data for tweet ${tweetId}`);
  }

  const tweet = main.data;
  const userById = indexById(main.includes?.users ?? []);
  const mediaByKey = indexMedia(main.includes?.media ?? []);
  const author = userById.get(tweet.author_id);

  const conversationTweets: XTweet[] = [];
  const conversationUsers: Map<string, XUser> = new Map();
  const conversationMedia: Map<string, PostMedia> = new Map();
  let nextToken: string | undefined;
  let pageCount = 0;
  const maxPages = 5;

  try {
    while (conversationTweets.length < hardCap && pageCount < maxPages) {
      const searchParams = new URLSearchParams({
        query: `conversation_id:${tweet.conversation_id}`,
        "tweet.fields": TWEET_FIELDS,
        "user.fields": USER_FIELDS,
        "media.fields": MEDIA_FIELDS,
        expansions: EXPANSIONS,
        max_results: "100",
      });
      if (nextToken) searchParams.set("next_token", nextToken);

      const search = await xFetch<XSearchResponse>(
        `/tweets/search/recent?${searchParams}`,
        bearerToken,
      );

      for (const t of search.data ?? []) conversationTweets.push(t);
      for (const u of search.includes?.users ?? []) {
        conversationUsers.set(u.id, u);
      }
      const pageMedia = indexMedia(search.includes?.media ?? []);
      for (const [k, v] of pageMedia) conversationMedia.set(k, v);

      nextToken = search.meta?.next_token;
      pageCount++;
      if (!nextToken) break;
    }
  } catch (e) {
    console.warn(
      `[xapi] conversation search failed on page ${pageCount + 1} (post may be older than 7 days): ${(e as Error).message}`,
    );
  }

  const allUsers = new Map([...userById, ...conversationUsers]);
  const allMedia = new Map([...mediaByKey, ...conversationMedia]);

  const includedTweetsById = new Map<string, XTweet>();
  for (const t of main.includes?.tweets ?? []) includedTweetsById.set(t.id, t);
  for (const t of conversationTweets) includedTweetsById.set(t.id, t);
  includedTweetsById.set(tweet.id, tweet);

  const isThreadContinuation = (t: XTweet): boolean => {
    const repliedTo = (t.referenced_tweets ?? []).find(
      (r) => r.type === "replied_to",
    );
    if (!repliedTo) return false;
    const parent = includedTweetsById.get(repliedTo.id);
    if (!parent) return false;
    return parent.author_id === tweet.author_id;
  };

  const threadTail = conversationTweets
    .filter(
      (t) =>
        t.author_id === tweet.author_id &&
        t.id !== tweet.id &&
        isThreadContinuation(t),
    )
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

  const threadTweets = [tweet, ...threadTail];
  const fullText = threadTweets
    .map((t) => {
      if (t.article?.plain_text) {
        const title = t.article.title?.trim();
        const body = t.article.plain_text.trim();
        return title ? `${title}\n\n${body}` : body;
      }
      return t.note_tweet?.text ?? t.text;
    })
    .join("\n\n");

  const threadMedia: PostMedia[] = [];
  for (const t of threadTweets) {
    for (const key of t.attachments?.media_keys ?? []) {
      const m = allMedia.get(key);
      if (m) threadMedia.push(m);
    }
  }

  const threadTailIds = new Set(threadTail.map((t) => t.id));
  const comments: PostComment[] = conversationTweets
    .filter((t) => t.id !== tweet.id && !threadTailIds.has(t.id))
    .sort(
      (a, b) => (b.public_metrics?.like_count ?? 0) - (a.public_metrics?.like_count ?? 0),
    )
    .slice(0, hardCap)
    .map((t) => {
      const u = allUsers.get(t.author_id);
      return {
        handle: u?.username ?? "",
        name: u?.name ?? "",
        date: (t.created_at ?? "").slice(0, 10),
        text: t.note_tweet?.text ?? t.text,
      };
    });

  return {
    url: `https://x.com/${author?.username ?? "i"}/status/${tweet.id}`,
    author: {
      handle: author?.username ?? "",
      name: author?.name ?? "",
    },
    date: (tweet.created_at ?? "").slice(0, 10),
    text: fullText,
    media: threadMedia,
    metrics: {
      likes: tweet.public_metrics?.like_count ?? 0,
      retweets: tweet.public_metrics?.retweet_count ?? 0,
      replies: tweet.public_metrics?.reply_count ?? 0,
      views: tweet.public_metrics?.impression_count ?? 0,
    },
    comments,
  };
}

function indexById(users: XUser[]): Map<string, XUser> {
  return new Map(users.map((u) => [u.id, u]));
}

function indexMedia(media: XMedia[]): Map<string, PostMedia> {
  const map = new Map<string, PostMedia>();
  for (const m of media) {
    const type: PostMedia["type"] =
      m.type === "video"
        ? "video"
        : m.type === "animated_gif"
          ? "gif"
          : "image";
    let url = m.url ?? m.preview_image_url ?? "";
    if (type === "video" && m.variants?.length) {
      const best = [...m.variants]
        .filter((v) => v.content_type === "video/mp4")
        .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0];
      if (best?.url) url = best.url;
    }
    map.set(m.media_key, { type, url });
  }
  return map;
}

/* ───────── /2/tweets?ids=… bulk lookup (Deep Search validation) ───────── */

export interface BulkLookupResult {
  enriched: Map<string, DeepSearchCandidate>;
  missingIds: Set<string>;
}

interface BulkTweetsResponse {
  data?: XTweet[];
  includes?: XIncludes;
  errors?: Array<{
    resource_id?: string;
    title?: string;
    detail?: string;
    resource_type?: string;
  }>;
}

/**
 * Bulk-resolve tweet IDs via GET /2/tweets?ids=... (up to 100 per call).
 * The primary purpose in Deep Search is to DETECT HALLUCINATED IDs
 * returned by Grok: X returns real tweets in `data` and an `errors` entry
 * per unknown ID, so we can drop the fakes and keep only verified content.
 *
 * Returns a Map<id, DeepSearchCandidate> for the successful lookups and
 * a Set<id> of IDs X did not recognize (hallucinated or deleted).
 *
 * Available on all X API v2 tiers (same endpoint used for single-tweet
 * extraction), unlike /search/recent which requires Basic+.
 */
export async function bulkLookupTweets(
  tweetIds: string[],
  bearerToken: string,
): Promise<BulkLookupResult> {
  const enriched = new Map<string, DeepSearchCandidate>();
  const missingIds = new Set<string>();

  const uniqueIds = Array.from(new Set(tweetIds.filter((id) => /^\d+$/.test(id))));
  if (uniqueIds.length === 0) {
    return { enriched, missingIds };
  }

  // Batch into chunks of 100 (X API limit per call)
  const batchSize = 100;
  for (let i = 0; i < uniqueIds.length; i += batchSize) {
    const batch = uniqueIds.slice(i, i + batchSize);
    const params = new URLSearchParams({
      ids: batch.join(","),
      "tweet.fields":
        "created_at,public_metrics,text,author_id,note_tweet,article,referenced_tweets",
      expansions: "author_id",
      "user.fields": USER_FIELDS,
    });
    const data = await xFetch<BulkTweetsResponse>(
      `/tweets?${params}`,
      bearerToken,
    );

    const users = new Map(
      (data.includes?.users ?? []).map((u) => [u.id, u]),
    );

    // Track which of the requested IDs came back in `data`
    const receivedIds = new Set((data.data ?? []).map((t) => t.id));
    for (const id of batch) {
      if (!receivedIds.has(id)) missingIds.add(id);
    }
    // Also mark explicitly errored IDs (in case some appear in errors[])
    for (const err of data.errors ?? []) {
      if (err.resource_id && err.resource_type === "tweet") {
        missingIds.add(err.resource_id);
      }
    }

    for (const t of data.data ?? []) {
      const user = users.get(t.author_id);
      const handle = user?.username ?? "";
      // Article detection: an X Article has a non-null `article` field.
      // Thread heuristic: tweet references a replied_to from same author.
      const isArticle = !!t.article;
      const repliedToSameAuthor = (t.referenced_tweets ?? []).some(
        (r) => r.type === "replied_to",
      );
      const format: "article" | "thread" | "post" = isArticle
        ? "article"
        : t.note_tweet || repliedToSameAuthor
          ? "thread"
          : "post";
      // Prefer note_tweet (long-form) text when present
      const fullText = t.note_tweet?.text ?? t.text ?? "";
      enriched.set(t.id, {
        tweetId: t.id,
        url: `https://x.com/${handle || "i"}/status/${t.id}`,
        authorHandle: handle,
        authorName: user?.name ?? "",
        text: fullText.slice(0, 240),
        date: (t.created_at ?? "").slice(0, 10),
        format,
        metrics: {
          likes: t.public_metrics?.like_count ?? 0,
          retweets: t.public_metrics?.retweet_count ?? 0,
          replies: t.public_metrics?.reply_count ?? 0,
          views: t.public_metrics?.impression_count,
        },
        foundBy: [],
        source: "xapi",
        rationale: "",
        mechanicalScore: 0,
        finalScore: 0,
        alreadyCached: false,
      });
    }
  }

  return { enriched, missingIds };
}

/* ───────── /2/tweets/search/recent (legacy — paid tier only) ───────── */

/**
 * Query the public X API v2 recent search (last 7 days) with a natural
 * text query. Used by Deep Search to complement Grok's x_search with
 * ground-truth results straight from X's search index.
 *
 * Limits: 7-day window on the basic tier. Retweets are excluded via the
 * `-is:retweet` operator.
 */
export async function searchRecentTweets(
  query: string,
  bearerToken: string,
  maxResults = 20,
): Promise<DeepSearchCandidate[]> {
  const params = new URLSearchParams({
    query: `${query} -is:retweet`,
    max_results: String(Math.min(Math.max(maxResults, 10), 100)),
    "tweet.fields": "created_at,public_metrics,text,author_id,entities",
    expansions: "author_id",
    "user.fields": "username,name",
  });
  const data = await xFetch<XSearchResponse>(
    `/tweets/search/recent?${params}`,
    bearerToken,
  );
  if (data.errors?.length) {
    throw new Error(`X API errors: ${JSON.stringify(data.errors)}`);
  }
  const users = new Map(
    (data.includes?.users ?? []).map((u) => [u.id, u]),
  );
  const out: DeepSearchCandidate[] = [];
  for (const t of data.data ?? []) {
    const user = users.get(t.author_id);
    const handle = user?.username ?? "";
    if (!handle) continue; // skip if author not resolved
    out.push({
      tweetId: t.id,
      url: `https://x.com/${handle}/status/${t.id}`,
      authorHandle: handle,
      authorName: user?.name ?? "",
      text: (t.text ?? "").slice(0, 240),
      date: (t.created_at ?? "").slice(0, 10),
      format: "post",
      metrics: {
        likes: t.public_metrics?.like_count ?? 0,
        retweets: t.public_metrics?.retweet_count ?? 0,
        replies: t.public_metrics?.reply_count ?? 0,
        views: t.public_metrics?.impression_count,
      },
      foundBy: [], // set by caller
      source: "xapi",
      rationale: "",
      mechanicalScore: 0,
      finalScore: 0,
      alreadyCached: false,
    });
  }
  return out;
}
