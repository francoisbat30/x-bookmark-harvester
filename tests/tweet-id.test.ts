import { describe, it, expect } from "vitest";
import { parseTweetRef } from "../lib/x/tweet-id";

describe("parseTweetRef", () => {
  it("parses a standard x.com URL", () => {
    const ref = parseTweetRef("https://x.com/user/status/1234567890");
    expect(ref).toEqual({
      id: "1234567890",
      handle: "user",
      canonicalUrl: "https://x.com/user/status/1234567890",
    });
  });

  it("parses a twitter.com URL and rewrites canonical to x.com", () => {
    const ref = parseTweetRef("https://twitter.com/user/status/1234567890");
    expect(ref?.id).toBe("1234567890");
    expect(ref?.canonicalUrl).toBe("https://x.com/user/status/1234567890");
  });

  it("strips query parameters from canonical URL", () => {
    const ref = parseTweetRef(
      "https://x.com/MaziyarPanahi/status/2043675576452706814?s=20",
    );
    expect(ref?.id).toBe("2043675576452706814");
    expect(ref?.canonicalUrl).toBe(
      "https://x.com/MaziyarPanahi/status/2043675576452706814",
    );
  });

  it("handles handles with underscores", () => {
    const ref = parseTweetRef("https://x.com/_Evan_Boyle/status/9876543210");
    expect(ref?.handle).toBe("_Evan_Boyle");
  });

  it("accepts the legacy /statuses/ path", () => {
    const ref = parseTweetRef("https://twitter.com/user/statuses/123");
    expect(ref?.id).toBe("123");
  });

  it("returns null for plain text", () => {
    expect(parseTweetRef("not a url")).toBeNull();
  });

  it("returns null for URL without status segment", () => {
    expect(parseTweetRef("https://x.com/user")).toBeNull();
  });

  it("returns null for URL with non-numeric id", () => {
    expect(parseTweetRef("https://x.com/user/status/abc")).toBeNull();
  });
});
