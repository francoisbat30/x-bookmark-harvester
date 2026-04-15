import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeNote } from "../lib/obsidian/vault";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xbm-vault-"));
  vi.stubEnv("X_BOOKMARK_HOME", tmpDir);
  vi.stubEnv("OBSIDIAN_VAULT_PATH", tmpDir);
  vi.stubEnv("OBSIDIAN_BOOKMARKS_SUBFOLDER", "bm");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("writeNote path traversal guard", () => {
  it("writes a normal note", async () => {
    const result = await writeNote("2026-04-15_user_hello.md", "content");
    expect(result.skipped).toBe(false);
    expect(result.absolutePath).toContain(path.join(tmpDir, "bm"));
  });

  it("refuses filenames with ..", async () => {
    await expect(
      writeNote("../escape.md", "evil"),
    ).rejects.toThrow(/outside vault dir/);
  });

  it("refuses absolute-path filenames", async () => {
    const evil =
      process.platform === "win32" ? "C:/Windows/evil.md" : "/etc/evil.md";
    await expect(writeNote(evil, "evil")).rejects.toThrow(/outside vault dir/);
  });

  it("refuses nested traversal like foo/../../escape.md", async () => {
    await expect(
      writeNote("foo/../../escape.md", "evil"),
    ).rejects.toThrow(/outside vault dir/);
  });

  it("does NOT write the escape file to disk", async () => {
    try {
      await writeNote("../leaked.md", "nope");
    } catch {
      // expected
    }
    const parentDir = path.dirname(tmpDir);
    await expect(fs.access(path.join(parentDir, "leaked.md"))).rejects.toThrow();
  });
});
