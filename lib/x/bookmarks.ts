import { recordApiCall, recordBilledResources } from "./usage";

const BASE = "https://api.x.com/2";

export interface BookmarkSummary {
  id: string;
  authorId: string;
  authorHandle: string;
  authorName: string;
  createdAt: string;
  text: string;
  likes: number;
  replies: number;
}

export interface FetchBookmarksOptions {
  accessToken: string;
  maxPages?: number;
  /** Pre-resolved identity (from getAuthenticatedUserId) to skip the /users/me
   * round-trip when the caller already knows who this token belongs to. */
  me?: { id: string; username: string; name: string };
  /**
   * Listing incrémental (pay-per-use : chaque bookmark retourné est facturé).
   * L'API renvoie les bookmarks du plus récemment ajouté au plus ancien : dès
   * qu'une page entière est déjà connue, tout ce qui suit l'est aussi → stop.
   * Retourne true si l'id est déjà connu (ex. hasCache). Omis = listing complet.
   */
  isKnown?: (id: string) => Promise<boolean>;
}

interface XUser {
  id: string;
  username: string;
  name: string;
}

interface XTweetLite {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  public_metrics?: { like_count: number; reply_count: number };
}

interface BookmarksResponse {
  data?: XTweetLite[];
  includes?: { users?: XUser[] };
  meta?: { result_count: number; next_token?: string };
  errors?: Array<{ title: string; detail: string }>;
}

interface MeResponse {
  data?: { id: string; username: string; name: string };
  errors?: Array<{ title: string; detail: string }>;
}

async function authFetch<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  recordApiCall(res.headers, path);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X API ${res.status} on ${path}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

export async function getAuthenticatedUserId(
  accessToken: string,
): Promise<{ id: string; username: string; name: string }> {
  const data = await authFetch<MeResponse>("/users/me", accessToken);
  if (data.errors?.length) {
    throw new Error(`X API errors: ${JSON.stringify(data.errors)}`);
  }
  if (!data.data) {
    throw new Error("X API returned no user data");
  }
  return data.data;
}

export async function fetchAllBookmarks(
  options: FetchBookmarksOptions,
): Promise<BookmarkSummary[]> {
  const { accessToken, maxPages = 20, isKnown } = options;
  const me = options.me ?? (await getAuthenticatedUserId(accessToken));

  const tweetFields = "created_at,author_id,text,public_metrics";
  const expansions = "author_id";
  const userFields = "username,name";

  const out: BookmarkSummary[] = [];
  let nextToken: string | undefined;
  let page = 0;

  while (page < maxPages) {
    const params = new URLSearchParams({
      max_results: "100",
      "tweet.fields": tweetFields,
      expansions,
      "user.fields": userFields,
    });
    if (nextToken) params.set("pagination_token", nextToken);

    const data = await authFetch<BookmarksResponse>(
      `/users/${me.id}/bookmarks?${params}`,
      accessToken,
    );

    if (data.errors?.length) {
      throw new Error(`X API errors: ${JSON.stringify(data.errors)}`);
    }

    const users = new Map(
      (data.includes?.users ?? []).map((u) => [u.id, u]),
    );

    const pageItems = data.data ?? [];
    recordBilledResources(pageItems.length);

    for (const t of pageItems) {
      const author = users.get(t.author_id);
      out.push({
        id: t.id,
        authorId: t.author_id,
        authorHandle: author?.username ?? "",
        authorName: author?.name ?? "",
        createdAt: t.created_at,
        text: t.text,
        likes: t.public_metrics?.like_count ?? 0,
        replies: t.public_metrics?.reply_count ?? 0,
      });
    }

    // Stop-early : page entière déjà connue → la suite l'est aussi.
    if (isKnown && pageItems.length > 0) {
      let allKnown = true;
      for (const t of pageItems) {
        if (!(await isKnown(t.id))) {
          allKnown = false;
          break;
        }
      }
      if (allKnown) break;
    }

    nextToken = data.meta?.next_token;
    page++;
    if (!nextToken) break;
  }

  return out;
}
