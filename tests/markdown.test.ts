import { describe, it, expect } from "vitest";
import { renderNote, buildFilename } from "../lib/obsidian/markdown";
import type { PostExtraction, GrokInsights } from "../lib/types";

const basePost: PostExtraction = {
  url: "https://x.com/user/status/1234567890",
  author: { handle: "user", name: "User Name" },
  date: "2026-04-15",
  text: "This is the first line\nand more body content",
  media: [],
  metrics: { likes: 100, retweets: 20, replies: 5, views: 1000 },
  comments: [],
};

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
    // not YYYY-MM-DD
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

describe("renderNote", () => {
  it("renders basic frontmatter and body", () => {
    const note = renderNote(basePost);
    expect(note.content).toMatch(/^---\n/);
    expect(note.content).toContain('title: "This is the first line"');
    expect(note.content).toContain('author: "@user"');
    expect(note.content).toContain("date: 2026-04-15");
    expect(note.content).toContain("likes: 100");
    expect(note.content).toContain("status: raw");
    expect(note.content).toContain("## Post");
  });

  it("omits Médias section when no media", () => {
    expect(renderNote(basePost).content).not.toContain("## Media");
  });

  it("includes Médias section with remote URL when media not downloaded", () => {
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

  it("omits Notable comments section when no comments", () => {
    expect(renderNote(basePost).content).not.toContain(
      "## Notable comments",
    );
  });

  it("renders comments section with quoted content", () => {
    const note = renderNote({
      ...basePost,
      comments: [
        {
          handle: "other",
          name: "Other User",
          date: "2026-04-15",
          text: "reply text",
        },
      ],
    });
    expect(note.content).toContain("## Notable comments");
    expect(note.content).toContain("**@other**");
    expect(note.content).toContain("> reply text");
  });

  it("renders Grok Insights section when provided", () => {
    const insights: GrokInsights = {
      author_additions: "Author clarified their intent.",
      notable_links: [{ url: "https://github.com/x/y", context: "the repo" }],
      sentiment: "Mostly positive.",
      key_replies: [
        { handle: "someone", quote: "Great insight", why: "Summarizes" },
      ],
    };
    const note = renderNote(basePost, { insights });
    expect(note.content).toContain("## Grok Insights");
    expect(note.content).toContain("### Author additions");
    expect(note.content).toContain("### Notable links");
    expect(note.content).toContain("https://github.com/x/y");
    expect(note.content).toContain("### Community sentiment");
    expect(note.content).toContain("### Key replies");
    expect(note.content).toContain("**@someone**");
  });

  it("places Grok Insights before Notable comments", () => {
    const note = renderNote(
      {
        ...basePost,
        comments: [
          { handle: "a", name: "A", date: "2026-04-15", text: "hi" },
        ],
      },
      {
        insights: {
          author_additions: null,
          notable_links: [],
          sentiment: "neutral",
          key_replies: [],
        },
      },
    );
    const grokIdx = note.content.indexOf("## Grok Insights");
    const commentsIdx = note.content.indexOf("## Notable comments");
    expect(grokIdx).toBeGreaterThan(0);
    expect(commentsIdx).toBeGreaterThan(grokIdx);
  });
});
