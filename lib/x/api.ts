import type { PostComment, PostExtraction, PostMedia } from "../types";
import { recordApiCall, recordBilledResources } from "./usage";

const BASE = "https://api.x.com/2";

const TWEET_FIELDS =
  "created_at,public_metrics,text,conversation_id,author_id,attachments,entities,referenced_tweets,note_tweet,article";
const USER_FIELDS = "username,name";
const MEDIA_FIELDS = "url,preview_image_url,type,variants";
const EXPANSIONS =
  "author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id";

/**
 * Fenêtre de la recherche récente (7 jours côté X) avec une demi-journée de
 * marge : au-delà, on bascule sur la recherche full-archive (/search/all),
 * disponible en pay-per-use — c'est elle qui répare les vieux bookmarks
 * (threads + commentaires) qui revenaient vides avant.
 */
const RECENT_WINDOW_MS = 6.5 * 24 * 60 * 60 * 1000;

export interface XApiClientOptions {
  bearerToken: string;
  /**
   * Pages de commentaires récupérées (100 résultats/page, facturé ~$0.005 par
   * post retourné). 1 page triée par pertinence suffit pour curer un top 15.
   */
  maxCommentPages?: number;
  /** Pages de la requête thread (conversation_id + from:auteur). */
  maxThreadPages?: number;
  /** Horloge injectable (tests). */
  now?: () => Date;
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

/** Texte intégral d'un tweet : article > note_tweet (long posts) > text. */
function tweetFullText(t: XTweet): string {
  if (t.article?.plain_text) {
    const title = t.article.title?.trim();
    const body = t.article.plain_text.trim();
    return title ? `${title}\n\n${body}` : body;
  }
  return t.note_tweet?.text ?? t.text;
}

function repliedToId(t: XTweet): string | undefined {
  return (t.referenced_tweets ?? []).find((r) => r.type === "replied_to")?.id;
}

/**
 * Reconstruit la chaîne self-reply de l'auteur contenant le tweet bookmarké :
 * remonte d'abord vers l'ancêtre le plus haut (bookmark pris au milieu d'un
 * thread), puis redescend. À chaque nœud on suit en priorité la branche qui
 * mène au tweet bookmarké, sinon la réponse-à-soi la plus ancienne (ordre de
 * publication = ordre du thread).
 */
export function buildSelfThread(main: XTweet, authorPosts: XTweet[]): XTweet[] {
  const byId = new Map<string, XTweet>(authorPosts.map((t) => [t.id, t]));
  byId.set(main.id, main);

  // 1. Remonter depuis le tweet bookmarké tant que le parent est de l'auteur.
  const upPath: XTweet[] = [main];
  const seen = new Set<string>([main.id]);
  let cursor = main;
  for (;;) {
    const pid = repliedToId(cursor);
    if (!pid || !byId.has(pid) || seen.has(pid)) break;
    cursor = byId.get(pid)!;
    upPath.push(cursor);
    seen.add(cursor.id);
  }
  const start = upPath[upPath.length - 1];
  // Ids sur le chemin start → main, pour préférer cette branche en descendant.
  const pathIds = new Set(upPath.map((t) => t.id));

  // 2. Redescendre en suivant les réponses-à-soi.
  const chain: XTweet[] = [start];
  const used = new Set<string>([start.id]);
  let cur = start;
  for (;;) {
    const kids = [...byId.values()]
      .filter((t) => !used.has(t.id) && repliedToId(t) === cur.id)
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
    if (kids.length === 0) break;
    const next = kids.find((t) => pathIds.has(t.id)) ?? kids[0];
    chain.push(next);
    used.add(next.id);
    cur = next;
  }
  return chain;
}

interface SearchAccumulator {
  tweets: XTweet[];
  users: Map<string, XUser>;
  media: Map<string, PostMedia>;
}

interface RunSearchOptions {
  sortOrder?: "recency" | "relevancy";
  /**
   * Borne basse de la fenêtre de recherche (ISO 8601). INDISPENSABLE sur
   * /search/all : sans start_time, X ne remonte que les 30 derniers jours
   * par défaut — exactement le piège qui rendait les vieilles conversations
   * introuvables. On passe la date du post bookmarké (moins une marge).
   */
  startTime?: string;
}

async function runSearch(
  endpoint: "recent" | "all",
  query: string,
  maxPages: number,
  bearerToken: string,
  options: RunSearchOptions = {},
): Promise<SearchAccumulator> {
  const acc: SearchAccumulator = {
    tweets: [],
    users: new Map(),
    media: new Map(),
  };
  let nextToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      query,
      "tweet.fields": TWEET_FIELDS,
      "user.fields": USER_FIELDS,
      "media.fields": MEDIA_FIELDS,
      expansions: EXPANSIONS,
      max_results: "100",
    });
    if (options.sortOrder) params.set("sort_order", options.sortOrder);
    if (endpoint === "all" && options.startTime) {
      params.set("start_time", options.startTime);
    }
    if (nextToken) params.set("next_token", nextToken);

    // /search/all est rate-limité plus bas que /search/recent : petite pause
    // entre les pages (le backoff 429 de xFetch fait le reste).
    if (endpoint === "all" && page > 0) {
      await new Promise((r) => setTimeout(r, 1100));
    }

    const res = await xFetch<XSearchResponse>(
      `/tweets/search/${endpoint}?${params}`,
      bearerToken,
    );

    recordBilledResources((res.data ?? []).length);
    for (const t of res.data ?? []) acc.tweets.push(t);
    for (const u of res.includes?.users ?? []) acc.users.set(u.id, u);
    for (const [k, v] of indexMedia(res.includes?.media ?? [])) {
      acc.media.set(k, v);
    }
    nextToken = res.meta?.next_token;
    if (!nextToken) break;
  }
  return acc;
}

export async function extractPostWithXApi(
  tweetId: string,
  options: XApiClientOptions,
): Promise<PostExtraction> {
  const {
    bearerToken,
    maxCommentPages = 1,
    maxThreadPages = 2,
    now = () => new Date(),
  } = options;

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

  recordBilledResources(1);

  const tweet = main.data;
  const userById = new Map((main.includes?.users ?? []).map((u) => [u.id, u]));
  const mediaByKey = indexMedia(main.includes?.media ?? []);
  const author = userById.get(tweet.author_id);

  const ageMs = now().getTime() - new Date(tweet.created_at).getTime();
  const endpoint: "recent" | "all" = ageMs > RECENT_WINDOW_MS ? "all" : "recent";

  // Fenêtre full-archive : depuis la publication du post (marge 1 min).
  const startTime = new Date(
    new Date(tweet.created_at).getTime() - 60_000,
  ).toISOString();

  // ── Thread de l'auteur : requête ciblée, quelques dizaines de résultats max.
  let threadAcc: SearchAccumulator = {
    tweets: [],
    users: new Map(),
    media: new Map(),
  };
  if (author?.username && maxThreadPages > 0) {
    try {
      threadAcc = await runSearch(
        endpoint,
        `conversation_id:${tweet.conversation_id} from:${author.username}`,
        maxThreadPages,
        bearerToken,
        { startTime },
      );
    } catch (e) {
      console.warn(
        `[xapi] thread search (${endpoint}) failed for ${tweetId}: ${(e as Error).message}`,
      );
    }
  }

  // ── Commentaires : 1 page triée par pertinence par défaut (coût plafonné),
  //    re-triée par likes en local.
  let commentsAcc: SearchAccumulator = {
    tweets: [],
    users: new Map(),
    media: new Map(),
  };
  try {
    if (maxCommentPages > 0) {
      commentsAcc = await runSearch(
        endpoint,
        `conversation_id:${tweet.conversation_id}`,
        maxCommentPages,
        bearerToken,
        { sortOrder: "relevancy", startTime },
      );
    }
  } catch (e) {
    console.warn(
      `[xapi] conversation search (${endpoint}) failed for ${tweetId}: ${(e as Error).message}`,
    );
  }

  // Le tri "relevancy" de X filtre agressivement (souvent 3-10 résultats même
  // sur un post à centaines de réponses). Quand la moisson est maigre par
  // rapport aux replies annoncées, on complète avec UNE page chronologique —
  // coût borné, et la curation locale (tri par likes) fait le reste.
  const expectedComments = Math.min(
    30,
    tweet.public_metrics?.reply_count ?? 0,
  );
  const harvested = new Set(
    commentsAcc.tweets.filter((t) => t.id !== tweet.id).map((t) => t.id),
  ).size;
  if (maxCommentPages > 0 && harvested < expectedComments) {
    try {
      const topUp = await runSearch(
        endpoint,
        `conversation_id:${tweet.conversation_id}`,
        1,
        bearerToken,
        { startTime },
      );
      commentsAcc = {
        tweets: [...commentsAcc.tweets, ...topUp.tweets],
        users: new Map([...commentsAcc.users, ...topUp.users]),
        media: new Map([...commentsAcc.media, ...topUp.media]),
      };
    } catch (e) {
      console.warn(
        `[xapi] recency top-up (${endpoint}) failed for ${tweetId}: ${(e as Error).message}`,
      );
    }
  }

  const allUsers = new Map([
    ...userById,
    ...threadAcc.users,
    ...commentsAcc.users,
  ]);
  const allMedia = new Map([
    ...mediaByKey,
    ...threadAcc.media,
    ...commentsAcc.media,
  ]);

  // ── Chaîne self-reply (ancêtres + suite), à partir des posts de l'auteur.
  const authorPosts = new Map<string, XTweet>();
  for (const t of [...threadAcc.tweets, ...commentsAcc.tweets]) {
    if (t.author_id === tweet.author_id) authorPosts.set(t.id, t);
  }
  for (const t of main.includes?.tweets ?? []) {
    if (t.author_id === tweet.author_id) authorPosts.set(t.id, t);
  }
  const chain = buildSelfThread(tweet, [...authorPosts.values()]);
  const chainIds = new Set(chain.map((t) => t.id));

  const fullText = chain.map(tweetFullText).join("\n\n");

  const threadMedia: PostMedia[] = [];
  for (const t of chain) {
    for (const key of t.attachments?.media_keys ?? []) {
      const m = allMedia.get(key);
      if (m) threadMedia.push(m);
    }
  }

  // ── Commentaires : tout ce qui n'est pas la chaîne, dédoublonné par id,
  //    avec les likes (traction) et le lien de parenté pour la curation.
  const commentById = new Map<string, XTweet>();
  for (const t of [...commentsAcc.tweets, ...threadAcc.tweets]) {
    if (!chainIds.has(t.id)) commentById.set(t.id, t);
  }
  const comments: PostComment[] = [...commentById.values()]
    .sort(
      (a, b) =>
        (b.public_metrics?.like_count ?? 0) - (a.public_metrics?.like_count ?? 0),
    )
    .slice(0, 300)
    .map((t) => {
      const u = allUsers.get(t.author_id);
      const parent = repliedToId(t);
      return {
        handle: u?.username ?? "",
        name: u?.name ?? "",
        date: (t.created_at ?? "").slice(0, 10),
        text: t.note_tweet?.text ?? t.text,
        likes: t.public_metrics?.like_count ?? 0,
        isAuthor: t.author_id === tweet.author_id,
        isDirectReply: parent !== undefined && chainIds.has(parent),
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
    thread: chain.map((t) => ({ id: t.id, text: tweetFullText(t) })),
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
    if ((type === "video" || type === "gif") && m.variants?.length) {
      const best = [...m.variants]
        .filter((v) => v.content_type === "video/mp4")
        .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0];
      if (best?.url) url = best.url;
    }
    const posterUrl =
      type === "video" || type === "gif" ? m.preview_image_url : undefined;
    map.set(m.media_key, { type, url, ...(posterUrl ? { posterUrl } : {}) });
  }
  return map;
}
