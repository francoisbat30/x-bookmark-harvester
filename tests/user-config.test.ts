import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadUserConfig,
  loadUserConfigSync,
  saveUserConfig,
  clearUserConfig,
  resolveVaultConfig,
} from "../lib/user-config";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xbm-cfg-"));
  vi.stubEnv("X_BOOKMARK_HOME", tmpDir);
  vi.stubEnv("OBSIDIAN_VAULT_PATH", "");
  vi.stubEnv("OBSIDIAN_BOOKMARKS_SUBFOLDER", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("user-config", () => {
  it("returns null when no config file exists", async () => {
    expect(await loadUserConfig()).toBeNull();
    expect(loadUserConfigSync()).toBeNull();
  });

  it("saves and reads back a config", async () => {
    await saveUserConfig({
      vaultPath: "C:/test/vault",
      subfolder: "bm",
      updatedAt: "2026-04-15T00:00:00.000Z",
    });
    const loaded = await loadUserConfig();
    expect(loaded).not.toBeNull();
    expect(loaded!.vaultPath).toBe("C:/test/vault");
    expect(loaded!.subfolder).toBe("bm");
  });

  it("sync and async loaders agree", async () => {
    await saveUserConfig({
      vaultPath: "/var/vault",
      subfolder: "x",
      updatedAt: "2026-04-15T00:00:00.000Z",
    });
    const a = await loadUserConfig();
    const b = loadUserConfigSync();
    expect(a).toEqual(b);
  });

  it("ignores malformed config", async () => {
    const configPath = path.join(tmpDir, "config.json");
    await fs.writeFile(configPath, "{ not json", "utf8");
    expect(await loadUserConfig()).toBeNull();
  });

  it("ignores config missing required fields", async () => {
    const configPath = path.join(tmpDir, "config.json");
    await fs.writeFile(configPath, JSON.stringify({ foo: "bar" }), "utf8");
    expect(await loadUserConfig()).toBeNull();
  });

  it("clearUserConfig removes the file", async () => {
    await saveUserConfig({
      vaultPath: "/tmp/v",
      subfolder: "x",
      updatedAt: "2026-04-15T00:00:00.000Z",
    });
    await clearUserConfig();
    expect(await loadUserConfig()).toBeNull();
  });
});

describe("resolveVaultConfig precedence", () => {
  it("uses default when nothing is set", () => {
    const resolved = resolveVaultConfig();
    expect(resolved.source).toBe("default");
    expect(resolved.vaultPath).toBe("./vault");
    expect(resolved.subfolder).toBe("x-bookmarks");
  });

  it("uses env var when set and no user config", () => {
    vi.stubEnv("OBSIDIAN_VAULT_PATH", "/env/vault");
    vi.stubEnv("OBSIDIAN_BOOKMARKS_SUBFOLDER", "notes");
    const resolved = resolveVaultConfig();
    expect(resolved.source).toBe("env");
    expect(resolved.vaultPath).toBe("/env/vault");
    expect(resolved.subfolder).toBe("notes");
  });

  it("user config wins over env var", async () => {
    vi.stubEnv("OBSIDIAN_VAULT_PATH", "/env/vault");
    await saveUserConfig({
      vaultPath: "/user/vault",
      subfolder: "bm",
      updatedAt: "2026-04-15T00:00:00.000Z",
    });
    const resolved = resolveVaultConfig();
    expect(resolved.source).toBe("user-config");
    expect(resolved.vaultPath).toBe("/user/vault");
    expect(resolved.subfolder).toBe("bm");
  });
});
