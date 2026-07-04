import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PostExtraction } from "../lib/types";

// Mock the concrete sources so the orchestrator is tested in isolation (no net).
vi.mock("../lib/x/api", () => ({ extractPostWithXApi: vi.fn() }));
vi.mock("../lib/x/grok-extract", () => ({ extractPostWithGrok: vi.fn() }));
vi.mock("../lib/x/mcp-source", () => ({
  mcpSource: { name: "mcp", extract: vi.fn() },
  mcpConfigFromEnv: vi.fn(() => ({ enabled: false })),
}));

import { extractPost } from "../lib/x/extract";
import { extractPostWithXApi } from "../lib/x/api";
import { extractPostWithGrok } from "../lib/x/grok-extract";
import { mcpSource } from "../lib/x/mcp-source";

const xapi = vi.mocked(extractPostWithXApi);
const grok = vi.mocked(extractPostWithGrok);
const mcp = vi.mocked(mcpSource.extract);

function makePost(o: Partial<PostExtraction> = {}): PostExtraction {
  return {
    url: "https://x.com/u/status/1",
    author: { handle: "u", name: "U" },
    date: "2026-01-01",
    text: "hello",
    media: [],
    metrics: { likes: 1, retweets: 0, replies: 0, views: 0 },
    comments: [],
    ...o,
  };
}

const comment = { handle: "a", name: "A", date: "2026-01-01", text: "nice" };
const URL = "https://x.com/u/status/1";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("extractPost — primary success", () => {
  it("returns xapi and never calls Grok when the primary is complete", async () => {
    // replies:0 + comments:[] is 'complete' (no missing comments to fetch)
    xapi.mockResolvedValue(makePost());
    const r = await extractPost("1", { url: URL, bearerToken: "B", grokApiKey: "G" });
    expect(r.source).toBe("xapi");
    expect(grok).not.toHaveBeenCalled();
  });

  it("does not treat a post with genuinely zero replies as incomplete", async () => {
    xapi.mockResolvedValue(makePost({ metrics: { likes: 0, retweets: 0, replies: 0, views: 0 } }));
    const r = await extractPost("1", { url: URL, bearerToken: "B", grokApiKey: "G" });
    expect(r.source).toBe("xapi");
    expect(grok).not.toHaveBeenCalled();
  });
});

describe("extractPost — Grok fallback", () => {
  it("uses Grok wholesale when the primary throws", async () => {
    xapi.mockRejectedValue(new Error("xapi down"));
    grok.mockResolvedValue(makePost({ text: "from grok", comments: [comment] }));
    const r = await extractPost("1", { url: URL, bearerToken: "B", grokApiKey: "G" });
    expect(r.source).toBe("grok");
    expect(r.post.text).toBe("from grok");
  });

  it("merges Grok comments into the primary base when comments are missing", async () => {
    // replies>0 but no comments extracted → stale → gap-fill from Grok
    xapi.mockResolvedValue(makePost({ metrics: { likes: 1, retweets: 0, replies: 5, views: 0 }, comments: [] }));
    grok.mockResolvedValue(makePost({ comments: [comment] }));
    const r = await extractPost("1", { url: URL, bearerToken: "B", grokApiKey: "G" });
    expect(r.source).toBe("xapi"); // base stays the primary
    expect(r.post.comments).toHaveLength(1);
    expect(grok).toHaveBeenCalledTimes(1);
  });

  it("keeps the primary base when Grok returns an ERROR post", async () => {
    xapi.mockResolvedValue(makePost({ metrics: { likes: 1, retweets: 0, replies: 5, views: 0 }, comments: [] }));
    grok.mockResolvedValue(makePost({ text: "ERROR: unreadable" }));
    const r = await extractPost("1", { url: URL, bearerToken: "B", grokApiKey: "G" });
    expect(r.source).toBe("xapi");
    expect(r.post.comments).toHaveLength(0);
    expect(grok).toHaveBeenCalledTimes(1);
  });

  it("skips Grok entirely when no grokApiKey is provided", async () => {
    xapi.mockResolvedValue(makePost({ metrics: { likes: 1, retweets: 0, replies: 5, views: 0 }, comments: [] }));
    const r = await extractPost("1", { url: URL, bearerToken: "B" });
    expect(r.source).toBe("xapi");
    expect(r.post.comments).toHaveLength(0);
    expect(grok).not.toHaveBeenCalled();
  });

  it("throws when every source fails and no fallback is available", async () => {
    xapi.mockRejectedValue(new Error("xapi down"));
    await expect(
      extractPost("1", { url: URL, bearerToken: "B" }),
    ).rejects.toThrow(/All sources failed/);
  });
});

describe("extractPost — MCP primary (opt-in)", () => {
  it("prefers MCP over xapi when enabled and complete", async () => {
    mcp.mockResolvedValue(makePost({ text: "from mcp" }));
    const r = await extractPost("1", {
      url: URL,
      bearerToken: "B",
      grokApiKey: "G",
      mcp: { enabled: true },
    });
    expect(r.source).toBe("mcp");
    expect(r.post.text).toBe("from mcp");
    expect(xapi).not.toHaveBeenCalled();
    expect(grok).not.toHaveBeenCalled();
  });

  it("falls back to xapi when the MCP source throws", async () => {
    mcp.mockRejectedValue(new Error("mcp down"));
    xapi.mockResolvedValue(makePost({ text: "from xapi" }));
    const r = await extractPost("1", {
      url: URL,
      bearerToken: "B",
      grokApiKey: "G",
      mcp: { enabled: true },
    });
    expect(r.source).toBe("xapi");
    expect(mcp).toHaveBeenCalledTimes(1);
    expect(r.trace).toEqual(["mcp", "xapi"]);
  });
});
