import type { PostExtraction, PostComment, PostMedia } from "../types";
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
