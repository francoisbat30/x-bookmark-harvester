import { describe, it, expect } from "vitest";
import {
  extractFrontmatter,
  serializeBookmark,
  canonicalize,
  canonicalizeEntity,
  normalizeTagName,
} from "../scripts/skills/utils";
import type {
  BookmarkFrontmatter,
  Taxonomy,
  EntityTaxonomy,
} from "../scripts/skills/utils";

const sampleFrontmatter: BookmarkFrontmatter = {
  title: "Test title",
  author: "@user",
  author_name: "User",
  date: "2026-04-15",
  source: "https://x.com/user/status/999",
  likes: 100,
  retweets: 20,
  replies: 5,
  views: 1000,
  tags: ["x-bookmark", "test"],
  status: "raw",
};

describe("frontmatter round-trip", () => {
  it("serializes then parses a basic bookmark", () => {
    const serialized = serializeBookmark(sampleFrontmatter, "body content");
    const { frontmatter, body } = extractFrontmatter(serialized);
    expect(frontmatter.title).toBe("Test title");
    expect(frontmatter.tags).toEqual(["x-bookmark", "test"]);
    expect(frontmatter.status).toBe("raw");
    expect(frontmatter.likes).toBe(100);
    expect(body.trim()).toBe("body content");
  });

  it("throws when no frontmatter present", () => {
    expect(() => extractFrontmatter("just body no yaml")).toThrow(
      /frontmatter/i,
    );
  });

  it("round-trips enriched status with summary", () => {
    const fm: BookmarkFrontmatter = {
      ...sampleFrontmatter,
      status: "enriched",
      tags: ["x-bookmark", "mlx", "local-inference"],
    };
    const serialized = serializeBookmark(
      fm,
      "## Summary\n\nSome summary\n\n## Post\n\nbody",
    );
    const parsed = extractFrontmatter(serialized);
    expect(parsed.frontmatter.status).toBe("enriched");
    expect(parsed.frontmatter.tags).toEqual([
      "x-bookmark",
      "mlx",
      "local-inference",
    ]);
    expect(parsed.body).toContain("## Summary");
    expect(parsed.body).toContain("Some summary");
  });

  it("round-trips graph fields (entities + graphed)", () => {
    const fm: BookmarkFrontmatter = {
      ...sampleFrontmatter,
      status: "enriched",
      entities: ["MLX", "Gemma 4", "M2 Max"],
      graphed: true,
    };
    const serialized = serializeBookmark(fm, "body");
    const parsed = extractFrontmatter(serialized);
    expect(parsed.frontmatter.entities).toEqual([
      "MLX",
      "Gemma 4",
      "M2 Max",
    ]);
    expect(parsed.frontmatter.graphed).toBe(true);
  });
});

describe("normalizeTagName", () => {
  it("lowercases and hyphenates", () => {
    expect(normalizeTagName("Video Generation")).toBe("video-generation");
  });

  it("strips leading hash", () => {
    expect(normalizeTagName("#prompting")).toBe("prompting");
  });

  it("drops non-alphanumeric characters", () => {
    expect(normalizeTagName("MLX!@#$")).toBe("mlx");
  });
});

describe("canonicalize (tags)", () => {
  const tax: Taxonomy = {
    tags: {
      "video-generation": { aliases: ["video-gen", "t2v"] },
      prompting: {},
    },
  };

  it("returns canonical for exact match after normalization", () => {
    expect(canonicalize("Video-Generation", tax)).toBe("video-generation");
  });

  it("resolves an alias to its canonical", () => {
    expect(canonicalize("video-gen", tax)).toBe("video-generation");
    expect(canonicalize("T2V", tax)).toBe("video-generation");
  });

  it("returns normalized input for unknown tag", () => {
    expect(canonicalize("Brand New Tag", tax)).toBe("brand-new-tag");
  });
});

describe("canonicalizeEntity", () => {
  const tax: EntityTaxonomy = {
    entities: {
      "Gemma 4": { aliases: ["gemma4", "gemma-4"] },
      MLX: { aliases: ["mlx framework"] },
    },
  };

  it("returns canonical for exact match", () => {
    expect(canonicalizeEntity("Gemma 4", tax)).toBe("Gemma 4");
  });

  it("resolves alias case-insensitively", () => {
    expect(canonicalizeEntity("gemma4", tax)).toBe("Gemma 4");
    expect(canonicalizeEntity("GEMMA4", tax)).toBe("Gemma 4");
    expect(canonicalizeEntity("MLX framework", tax)).toBe("MLX");
  });

  it("preserves input casing for unknown entities", () => {
    expect(canonicalizeEntity("Qwen3.5", tax)).toBe("Qwen3.5");
  });

  it("handles whitespace", () => {
    expect(canonicalizeEntity("  Gemma 4  ", tax)).toBe("Gemma 4");
  });
});
