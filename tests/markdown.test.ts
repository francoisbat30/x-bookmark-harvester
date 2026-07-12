import { describe, it, expect } from "vitest";
import { renderNote, buildFilename } from "../lib/obsidian/markdown";
import type { PostExtraction, GrokInsights, PostComment } from "../lib/types";

const basePost: PostExtraction = {
  url: "https://x.com/user/status/1234567890",
  author: { handle: "user", name: "User Name" },
  date: "2026-04-15",
  text: "This is the first line\nand more body content",
  media: [],
  metrics: { likes: 100, retweets: 20, replies: 5, views: 1000 },
  comments: [],
};

function comment(o: Partial<PostComment>): PostComment {
  return {
    handle: "someone",
    name: "Some One",
    date: "2026-04-15",
    text: "a sufficiently long and meaningful reply",
    likes: 1,
    isAuthor: false,
    isDirectReply: true,
    ...o,
  };
}

describe("buildFilename", () => {
  it("builds the standard YYYY-MM-DD_handle_first-words format", () => {
    expect(buildFilename(basePost)).toBe(
      "2026-04-15_user_this-is-the-first-line-and.md",
    );
  });

  it("falls back to 'post' for empty text", () => {
    expect(buildFilename({ ...basePost, text: "" })).toBe(
      "2026-04-15_user_post.md",
    );
  });

  it("strips URLs from first words", () => {
    const fn = buildFilename({
      ...basePost,
      text: "https://example.com check this out",
    });
    expect(fn).toContain("check-this-out");
    expect(fn).not.toContain("example");
  });

  it("normalizes handle with special characters", () => {
    const fn = buildFilename({
      ...basePost,
      author: { handle: "User.Name!", name: "User" },
      text: "Hello",
    });
    expect(fn).toMatch(/^2026-04-15_user-name_/);
  });

  it("falls back to 0000-00-00 when date is not a strict ISO date", () => {
    const fn = buildFilename({ ...basePost, date: "../../../etc" });
    expect(fn.startsWith("0000-00-00_")).toBe(true);
    expect(fn).not.toContain("..");
  });

  it("falls back when date is missing", () => {
    const fn = buildFilename({ ...basePost, date: "" });
    expect(fn.startsWith("0000-00-00_")).toBe(true);
  });

  it("rejects non-canonical but plausible-looking dates", () => {
    expect(
      buildFilename({ ...basePost, date: "2026/04/15" }).startsWith(
        "0000-00-00_",
      ),
    ).toBe(true);
    expect(
      buildFilename({ ...basePost, date: "2026-4-15" }).startsWith(
        "0000-00-00_",
      ),
    ).toBe(true);
  });
});

describe("renderNote — frontmatter", () => {
  it("renders basic frontmatter and body", () => {
    const note = renderNote(basePost);
    expect(note.content).toMatch(/^---\n/);
    expect(note.content).toContain('title: "This is the first line"');
    expect(note.content).toContain('author: "@user"');
    expect(note.content).toContain("date: 2026-04-15");
    expect(note.content).toContain("likes: 100");
    expect(note.content).toContain("status: raw");
    expect(note.content).toContain("statut: source");
    expect(note.content).toContain("## Post");
  });

  it("records thread length and captured comment count", () => {
    const note = renderNote({
      ...basePost,
      thread: [
        { id: "1", text: "one" },
        { id: "2", text: "two" },
      ],
      comments: [comment({ handle: "a" }), comment({ handle: "b", text: "another quite long and meaningful reply" })],
    });
    expect(note.content).toContain("thread: 2");
    expect(note.content).toContain("comments_captured: 2");
  });
});

describe("renderNote — Post (thread)", () => {
  it("joins thread tweets with --- separators", () => {
    const note = renderNote({
      ...basePost,
      thread: [
        { id: "1", text: "first tweet" },
        { id: "2", text: "second tweet" },
        { id: "3", text: "third tweet" },
      ],
    });
    const post = note.content.split("## Post")[1];
    expect(post).toContain("first tweet\n\n---\n\nsecond tweet");
    expect((post.match(/\n---\n/g) ?? []).length).toBe(2);
  });

  it("falls back to joined text for v1 caches without thread[]", () => {
    const note = renderNote(basePost);
    expect(note.content).toContain("This is the first line\nand more body content");
    expect(note.content.split("## Post")[1]).not.toContain("\n---\n");
  });
});

describe("renderNote — Media", () => {
  it("omits the section when no media", () => {
    expect(renderNote(basePost).content).not.toContain("## Media");
  });

  it("keeps the remote URL when the image is not downloaded", () => {
    const note = renderNote({
      ...basePost,
      media: [{ type: "image", url: "https://pbs.twimg.com/media/foo.jpg" }],
    });
    expect(note.content).toContain("## Media");
    expect(note.content).toContain(
      "[image] https://pbs.twimg.com/media/foo.jpg",
    );
  });

  it("uses Obsidian embed syntax when image is downloaded", () => {
    const note = renderNote(
      {
        ...basePost,
        media: [{ type: "image", url: "https://pbs.twimg.com/media/foo.jpg" }],
      },
      {
        downloadedImages: [
          {
            remoteUrl: "https://pbs.twimg.com/media/foo.jpg",
            localFilename: "1234567890_1.jpg",
          },
        ],
      },
    );
    expect(note.content).toContain("![[assets/1234567890_1.jpg]]");
    expect(note.content).not.toContain(
      "[image] https://pbs.twimg.com/media/foo.jpg",
    );
  });

  it("renders a video as local poster + remote link", () => {
    const note = renderNote(
      {
        ...basePost,
        media: [
          {
            type: "video",
            url: "https://video.twimg.com/vid.mp4",
            posterUrl: "https://pbs.twimg.com/poster.jpg",
          },
        ],
      },
      {
        downloadedImages: [
          {
            remoteUrl: "https://pbs.twimg.com/poster.jpg",
            localFilename: "1234567890_1_poster.jpg",
          },
        ],
      },
    );
    expect(note.content).toContain("![[assets/1234567890_1_poster.jpg]]");
    expect(note.content).toContain("[video] https://video.twimg.com/vid.mp4");
  });

  it("renders a transcript under its video", () => {
    const note = renderNote(
      {
        ...basePost,
        media: [
          {
            type: "video",
            url: "https://video.twimg.com/vid.mp4",
            posterUrl: "https://pbs.twimg.com/poster.jpg",
          },
        ],
      },
      {
        videoTranscripts: [
          { url: "https://video.twimg.com/vid.mp4", text: "Hello world spoken words" },
        ],
      },
    );
    expect(note.content).toContain("> Transcript :");
    expect(note.content).toContain("> Hello world spoken words");
  });
});

describe("renderNote — Comments (curation)", () => {
  it("omits the section when no comments", () => {
    expect(renderNote(basePost).content).not.toContain("## Comments");
  });

  it("sorts by likes desc and shows the like count", () => {
    const note = renderNote({
      ...basePost,
      comments: [
        comment({ handle: "small", text: "a long enough reply with little traction", likes: 2 }),
        comment({ handle: "big", text: "a long enough reply with huge traction", likes: 1500 }),
      ],
    });
    expect(note.content).toContain("## Comments");
    const big = note.content.indexOf("**@big**");
    const small = note.content.indexOf("**@small**");
    expect(big).toBeGreaterThan(0);
    expect(big).toBeLessThan(small);
    expect(note.content).toContain("♥ 1.5k");
  });

  it("puts author replies first with the ✍️ marker", () => {
    const note = renderNote({
      ...basePost,
      comments: [
        comment({ handle: "fan", text: "a long enough reply from a fan", likes: 9000 }),
        comment({ handle: "user", text: "short author add", likes: 0, isAuthor: true }),
      ],
    });
    const author = note.content.indexOf("✍️ **@user**");
    const fan = note.content.indexOf("**@fan**");
    expect(author).toBeGreaterThan(0);
    expect(author).toBeLessThan(fan);
  });

  it("caps at 15 and prints the captured/shown footer", () => {
    const comments = Array.from({ length: 40 }, (_, i) =>
      comment({
        handle: `u${i}`,
        text: `reply number ${i} long enough to pass the filter`,
        likes: i,
      }),
    );
    const note = renderNote({ ...basePost, comments });
    expect(note.content).toContain("_40 comments captured · 15 shown_");
    expect(note.content).not.toContain("**@u0**");
    expect(note.content).toContain("**@u39**");
  });

  it("drops short/noise replies and cross-handle duplicates", () => {
    const note = renderNote({
      ...basePost,
      comments: [
        comment({ handle: "noise", text: "🔥🔥", likes: 50 }),
        comment({ handle: "a", text: "identical spam reply body here", likes: 3 }),
        comment({ handle: "b", text: "identical spam reply body here", likes: 2 }),
        comment({ handle: "deep", text: "a reply to a reply, quite long too", likes: 99, isDirectReply: false }),
      ],
    });
    expect(note.content).not.toContain("**@noise**");
    expect(note.content).toContain("**@a**");
    expect(note.content).not.toContain("**@b**");
    expect(note.content).not.toContain("**@deep**");
  });

  it("renders v1 comments (no likes) without the ♥ part", () => {
    const note = renderNote({
      ...basePost,
      comments: [
        comment({ handle: "old", text: "a legacy comment from cache v1", likes: undefined, isAuthor: undefined, isDirectReply: undefined }),
      ],
    });
    expect(note.content).toContain("**@old**");
    const line = note.content.split("\n").find((l) => l.includes("**@old**"))!;
    expect(line).not.toContain("♥");
  });
});

describe("renderNote — preservation of enrich work", () => {
  const existing = `---
title: "Old title"
tags:
  - x-bookmark
  - ai-agents
status: enriched
statut: source
---

## Summary

A hand-checked summary that must survive re-renders.

## Contenu du post

old body
`;

  it("preserves ## Summary, curated tags and status from the existing note", () => {
    const note = renderNote(basePost, { existingContent: existing });
    expect(note.content).toContain("## Summary\n\nA hand-checked summary that must survive re-renders.");
    expect(note.content).toContain("tags: [x-bookmark, ai-agents]");
    expect(note.content).toContain("status: enriched");
    expect(note.content).not.toContain("## Contenu du post");
  });

  it("defaults to raw/x-bookmark when there is no existing note", () => {
    const note = renderNote(basePost, { existingContent: null });
    expect(note.content).toContain("tags: [x-bookmark]");
    expect(note.content).toContain("status: raw");
    expect(note.content).not.toContain("## Summary");
  });
});

describe("renderNote — Grok Insights", () => {
  it("renders the section and keeps it before Comments", () => {
    const insights: GrokInsights = {
      author_additions: "Author clarified their intent.",
      notable_links: [{ url: "https://github.com/x/y", context: "the repo" }],
      sentiment: "Mostly positive.",
      key_replies: [
        { handle: "someone", quote: "Great insight", why: "Summarizes" },
      ],
    };
    const note = renderNote(
      { ...basePost, comments: [comment({ handle: "c1" })] },
      { insights },
    );
    expect(note.content).toContain("## Grok Insights");
    expect(note.content).toContain("### Author additions");
    expect(note.content).toContain("https://github.com/x/y");
    const grokIdx = note.content.indexOf("## Grok Insights");
    const commentsIdx = note.content.indexOf("## Comments");
    expect(grokIdx).toBeGreaterThan(0);
    expect(commentsIdx).toBeGreaterThan(grokIdx);
  });
});
