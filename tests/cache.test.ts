import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readCache,
  writeCache,
  writeDownloadedImages,
  writeInsights,
} from "../lib/obsidian/cache";
import type { PostExtraction } from "../lib/types";

const samplePost: PostExtraction = {
  url: "https://x.com/user/status/999",
  author: { handle: "user", name: "User" },
  date: "2026-04-15",
  text: "hello",
  media: [],
  metrics: { likes: 1, retweets: 0, replies: 0, views: 10 },
  comments: [],
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xbm-cache-"));
  vi.stubEnv("OBSIDIAN_VAULT_PATH", tmpDir);
  vi.stubEnv("OBSIDIAN_BOOKMARKS_SUBFOLDER", "bm");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("cache envelope", () => {
  it("writes and reads a fresh cache", async () => {
    await writeCache("999", samplePost, "xapi");
    const envelope = await readCache("999");
    expect(envelope).not.toBeNull();
    expect(envelope!.source).toBe("xapi");
    expect(envelope!.tweetId).toBe("999");
    expect(envelope!.post.text).toBe("hello");
    expect(envelope!.post.author.handle).toBe("user");
  });

  it("returns null when no cache exists", async () => {
    const envelope = await readCache("nothing-here");
    expect(envelope).toBeNull();
  });

  it("preserves grokInsights across writeCache", async () => {
    await writeCache("999", samplePost, "xapi");
    await writeInsights("999", {
      author_additions: "author context",
      notable_links: [{ url: "https://gh/x", context: "repo" }],
      sentiment: "positive",
      key_replies: [],
    });

    const updated = { ...samplePost, text: "updated text" };
    await writeCache("999", updated, "xapi");

    const envelope = await readCache("999");
    expect(envelope!.post.text).toBe("updated text");
    expect(envelope!.grokInsights).toBeDefined();
    expect(envelope!.grokInsights!.data.author_additions).toBe(
      "author context",
    );
    expect(envelope!.grokInsights!.data.notable_links).toHaveLength(1);
  });

  it("preserves downloadedImages across writeCache", async () => {
    await writeCache("999", samplePost, "xapi");
    await writeDownloadedImages("999", [
      {
        remoteUrl: "https://example.com/a.jpg",
        localFilename: "999_1.jpg",
      },
    ]);
    await writeCache("999", { ...samplePost, text: "new" }, "xapi");
    const envelope = await readCache("999");
    expect(envelope!.downloadedImages).toHaveLength(1);
    expect(envelope!.downloadedImages![0].localFilename).toBe("999_1.jpg");
  });

  it("writeInsights fails when no prior cache exists", async () => {
    await expect(
      writeInsights("missing", {
        author_additions: null,
        notable_links: [],
        sentiment: "",
        key_replies: [],
      }),
    ).rejects.toThrow(/no cache/i);
  });
});
