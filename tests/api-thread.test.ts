import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { extractPostWithXApi, buildSelfThread } from "../lib/x/api";

/* ───────────────────────── buildSelfThread (pur) ───────────────────────── */

interface T {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  conversation_id: string;
  referenced_tweets?: Array<{ type: "replied_to" | "quoted" | "retweeted"; id: string }>;
}

function t(id: string, opts: Partial<T> = {}): T {
  return {
    id,
    text: `tweet ${id}`,
    created_at: `2026-07-01T10:00:${id.padStart(2, "0")}.000Z`,
    author_id: "A",
    conversation_id: "1",
    ...opts,
  };
}

const reply = (to: string) => ({
  referenced_tweets: [{ type: "replied_to" as const, id: to }],
});

describe("buildSelfThread", () => {
  it("reconstructs root → tail order", () => {
    const root = t("1");
    const t2 = t("2", reply("1"));
    const t3 = t("3", reply("2"));
    const chain = buildSelfThread(root, [t3, t2, root]);
    expect(chain.map((x) => x.id)).toEqual(["1", "2", "3"]);
  });

  it("recovers ancestors when the bookmark is mid-thread", () => {
    const root = t("1");
    const t2 = t("2", reply("1"));
    const t3 = t("3", reply("2"));
    const chain = buildSelfThread(t2, [root, t3]);
    expect(chain.map((x) => x.id)).toEqual(["1", "2", "3"]);
  });

  it("prefers the branch that contains the bookmarked tweet", () => {
    const root = t("1");
    // deux réponses de l'auteur au même tweet : "2" (plus ancienne) et "5"
    const earlySibling = t("2", reply("1"));
    const bookmarked = t("5", reply("1"));
    const after = t("6", reply("5"));
    const chain = buildSelfThread(bookmarked, [root, earlySibling, after]);
    expect(chain.map((x) => x.id)).toEqual(["1", "5", "6"]);
  });

  it("keeps author replies to other users out of the chain", () => {
    const root = t("1");
    const tail = t("2", reply("1"));
    // réponse de l'auteur à un commentaire "C9" (pas un post de l'auteur)
    const toCommenter = t("3", reply("C9"));
    const chain = buildSelfThread(root, [tail, toCommenter]);
    expect(chain.map((x) => x.id)).toEqual(["1", "2"]);
  });

  it("single post → single-item chain", () => {
    const root = t("1");
    expect(buildSelfThread(root, []).map((x) => x.id)).toEqual(["1"]);
  });
});

/* ─────────────────── extractPostWithXApi (fetch mocké) ─────────────────── */

type Json = Record<string, unknown>;

function makeUser(id: string, username: string): Json {
  return { id, username, name: username.toUpperCase() };
}

function res(payload: Json) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

const NOW = () => new Date("2026-07-10T00:00:00.000Z");

function installFetch(opts: {
  mainTweet: Json;
  users: Json[];
  media?: Json[];
  threadResults?: Json[];
  commentResults?: Json[];
  commentUsers?: Json[];
}) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/tweets/search/")) {
      const q = new URL(url).searchParams.get("query") ?? "";
      if (q.includes("from:")) {
        return res({ data: opts.threadResults ?? [], includes: { users: opts.users } });
      }
      return res({
        data: opts.commentResults ?? [],
        includes: { users: [...opts.users, ...(opts.commentUsers ?? [])] },
      });
    }
    return res({
      data: opts.mainTweet,
      includes: { users: opts.users, media: opts.media ?? [] },
    });
  });
  vi.stubGlobal("fetch", impl);
  return { impl, calls };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const author = makeUser("A", "author");

function mainTweet(created: string): Json {
  return {
    id: "1000",
    text: "root tweet",
    created_at: created,
    author_id: "A",
    conversation_id: "1000",
    public_metrics: { like_count: 10, retweet_count: 1, reply_count: 3, impression_count: 99 },
  };
}

describe("extractPostWithXApi — fenêtre de recherche", () => {
  it("uses /search/recent for a fresh post", async () => {
    const { calls } = installFetch({ mainTweet: mainTweet("2026-07-08T00:00:00.000Z"), users: [author] });
    await extractPostWithXApi("1000", { bearerToken: "B", now: NOW });
    const searches = calls.filter((c) => c.includes("/tweets/search/"));
    expect(searches.length).toBeGreaterThan(0);
    for (const s of searches) expect(s).toContain("/tweets/search/recent");
  });

  it("uses /search/all for a post older than the recent window", async () => {
    const { calls } = installFetch({ mainTweet: mainTweet("2025-09-14T00:00:00.000Z"), users: [author] });
    await extractPostWithXApi("1000", { bearerToken: "B", now: NOW });
    const searches = calls.filter((c) => c.includes("/tweets/search/"));
    expect(searches.length).toBeGreaterThan(0);
    for (const s of searches) expect(s).toContain("/tweets/search/all");
  });

  it("asks relevancy ordering for the comments query only", async () => {
    const { calls } = installFetch({ mainTweet: mainTweet("2026-07-08T00:00:00.000Z"), users: [author] });
    await extractPostWithXApi("1000", { bearerToken: "B", now: NOW });
    const withSort = calls.filter((c) => c.includes("sort_order=relevancy"));
    expect(withSort).toHaveLength(1);
    expect(decodeURIComponent(withSort[0])).not.toContain("from:");
  });
});

describe("extractPostWithXApi — assemblage", () => {
  it("joins the author thread and maps comments with likes/isAuthor/isDirectReply", async () => {
    const tail = {
      id: "1001",
      text: "tail tweet",
      created_at: "2026-07-08T00:01:00.000Z",
      author_id: "A",
      conversation_id: "1000",
      referenced_tweets: [{ type: "replied_to", id: "1000" }],
    };
    const directComment = {
      id: "2001",
      text: "a direct reply with plenty of substance",
      created_at: "2026-07-08T01:00:00.000Z",
      author_id: "U1",
      conversation_id: "1000",
      referenced_tweets: [{ type: "replied_to", id: "1000" }],
      public_metrics: { like_count: 42, retweet_count: 0, reply_count: 0 },
    };
    const nested = {
      id: "2002",
      text: "a reply to the reply, also substantial",
      created_at: "2026-07-08T02:00:00.000Z",
      author_id: "U2",
      conversation_id: "1000",
      referenced_tweets: [{ type: "replied_to", id: "2001" }],
      public_metrics: { like_count: 7, retweet_count: 0, reply_count: 0 },
    };
    const authorToCommenter = {
      id: "2003",
      text: "thanks, here is a precision from the author",
      created_at: "2026-07-08T03:00:00.000Z",
      author_id: "A",
      conversation_id: "1000",
      referenced_tweets: [{ type: "replied_to", id: "2001" }],
      public_metrics: { like_count: 3, retweet_count: 0, reply_count: 0 },
    };

    installFetch({
      mainTweet: mainTweet("2026-07-08T00:00:00.000Z"),
      users: [author],
      threadResults: [tail, authorToCommenter],
      commentResults: [directComment, nested],
      commentUsers: [makeUser("U1", "u1"), makeUser("U2", "u2")],
    });

    const post = await extractPostWithXApi("1000", { bearerToken: "B", now: NOW });

    expect(post.text).toBe("root tweet\n\ntail tweet");
    expect(post.thread?.map((x) => x.id)).toEqual(["1000", "1001"]);

    const byHandle = new Map(post.comments.map((c) => [c.handle, c]));
    expect(byHandle.get("u1")).toMatchObject({ likes: 42, isAuthor: false, isDirectReply: true });
    expect(byHandle.get("u2")).toMatchObject({ likes: 7, isDirectReply: false });
    expect(byHandle.get("author")).toMatchObject({ isAuthor: true });
    // tri par likes décroissants
    expect(post.comments[0].handle).toBe("u1");
  });

  it("captures video poster URLs from media includes", async () => {
    installFetch({
      mainTweet: {
        ...mainTweet("2026-07-08T00:00:00.000Z"),
        attachments: { media_keys: ["m1"] },
      },
      users: [author],
      media: [
        {
          media_key: "m1",
          type: "video",
          preview_image_url: "https://pbs.twimg.com/poster.jpg",
          variants: [
            { bit_rate: 100, content_type: "video/mp4", url: "https://video.twimg.com/lo.mp4" },
            { bit_rate: 900, content_type: "video/mp4", url: "https://video.twimg.com/hi.mp4" },
          ],
        },
      ],
    });
    const post = await extractPostWithXApi("1000", { bearerToken: "B", now: NOW });
    expect(post.media).toEqual([
      {
        type: "video",
        url: "https://video.twimg.com/hi.mp4",
        posterUrl: "https://pbs.twimg.com/poster.jpg",
      },
    ]);
  });
});
