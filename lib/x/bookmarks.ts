import { recordApiCall } from "./usage";

const BASE = "https://api.x.com/2";

export interface BookmarkSummary {
  id: string;
  authorId: string;
  authorHandle: string;
  authorName: string;
  createdAt: string;
  text: string;
}

export interface FetchBookmarksOptions {
  accessToken: string;
  maxPages?: number;
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
  const { accessToken, maxPages = 20 } = options;
  const me = await getAuthenticatedUserId(accessToken);

  const tweetFields = "created_at,author_id,text";
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

    for (const t of data.data ?? []) {
      const author = users.get(t.author_id);
      out.push({
        id: t.id,
        authorId: t.author_id,
        authorHandle: author?.username ?? "",
        authorName: author?.name ?? "",
        createdAt: t.created_at,
        text: t.text,
      });
    }

    nextToken = data.meta?.next_token;
    page++;
    if (!nextToken) break;
  }

  return out;
}
