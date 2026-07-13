import { describe, it, expect } from "vitest";
import { curateComments } from "../lib/obsidian/comments";
import type { PostComment } from "../lib/types";

function c(o: Partial<PostComment>): PostComment {
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

const OPTS = { authorHandle: "author" };

describe("curateComments — filtres", () => {
  it("drops replies under 15 useful characters", () => {
    const { shown } = curateComments(
      [c({ text: "🔥🔥" }), c({ handle: "ok", text: "this one is long enough to stay" })],
      OPTS,
    );
    expect(shown.map((x) => x.handle)).toEqual(["ok"]);
  });

  it("ignores leading @mentions when measuring usefulness", () => {
    const { shown } = curateComments(
      [c({ text: "@author @other yes!" })],
      OPTS,
    );
    expect(shown).toHaveLength(0);
  });

  it("drops replies-to-replies but keeps unknown parentage (v1)", () => {
    const { shown } = curateComments(
      [
        c({ handle: "deep", isDirectReply: false }),
        c({ handle: "legacy", text: "legacy cache comment long enough", isDirectReply: undefined }),
      ],
      OPTS,
    );
    expect(shown.map((x) => x.handle)).toEqual(["legacy"]);
  });

  it("never filters the author, even short or nested", () => {
    const { shown } = curateComments(
      [c({ handle: "author", text: "yes.", isDirectReply: false, isAuthor: true })],
      OPTS,
    );
    expect(shown).toHaveLength(1);
  });
});

describe("curateComments — dédoublonnage", () => {
  it("dedupes same handle + same text", () => {
    const { shown } = curateComments(
      [c({ handle: "a" }), c({ handle: "a" })],
      OPTS,
    );
    expect(shown).toHaveLength(1);
  });

  it("dedupes identical text across handles (spam)", () => {
    const { shown } = curateComments(
      [
        c({ handle: "a", text: "identical spam body long enough" }),
        c({ handle: "b", text: "identical spam body long enough" }),
      ],
      OPTS,
    );
    expect(shown).toHaveLength(1);
    expect(shown[0].handle).toBe("a");
  });
});

describe("curateComments — tri et plafond", () => {
  it("author replies first (chronological), then likes desc, then unknown likes", () => {
    const { shown } = curateComments(
      [
        c({ handle: "mid", text: "a decent reply with some traction", likes: 10 }),
        c({ handle: "legacy", text: "an old cache v1 comment long enough", likes: undefined }),
        c({ handle: "top", text: "the most liked reply of them all", likes: 500 }),
        c({ handle: "author", text: "author second addition here", isAuthor: true, date: "2026-04-16" }),
        c({ handle: "author", text: "author first addition here", isAuthor: true, date: "2026-04-15" }),
      ],
      OPTS,
    );
    expect(shown.map((x) => x.text.split(" ")[1])).toEqual([
      "first",
      "second",
      "most",
      "decent",
      "old",
    ]);
  });

  it("caps the total", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      c({ handle: `u${i}`, text: `reply ${i} long enough to pass filters`, likes: i }),
    );
    const { shown, captured } = curateComments(many, { ...OPTS, cap: 5 });
    expect(captured).toBe(30);
    expect(shown).toHaveLength(5);
    expect(shown[0].handle).toBe("u29");
  });

  it("detects the author by handle when isAuthor is missing (v1/Grok)", () => {
    const { shown } = curateComments(
      [
        c({ handle: "fan", text: "a long reply from a fan account", likes: 99 }),
        c({ handle: "Author", text: "short.", isAuthor: undefined }),
      ],
      OPTS,
    );
    expect(shown[0].handle).toBe("Author");
  });
});
