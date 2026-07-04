import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseAccountLabel,
  listAccounts,
  saveTokens,
  saveAccountTokens,
  loadTokens,
  getAllValidAccessTokens,
  DEFAULT_LABEL,
  type StoredTokens,
} from "../lib/x/auth";

let tmpDir: string;

function tokens(overrides: Partial<StoredTokens> = {}): StoredTokens {
  return {
    access_token: "ACCESS",
    refresh_token: "REFRESH",
    token_type: "bearer",
    scope: "bookmark.read tweet.read users.read offline.access",
    expires_at: Date.now() + 3_600_000,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "xbm-acc-"));
  vi.stubEnv("X_BOOKMARK_HOME", tmpDir);
  // Point the (unused here) legacy vault path inside tmp so migrateLegacyAuth
  // never touches a real vault during tests.
  vi.stubEnv("OBSIDIAN_VAULT_PATH", tmpDir);
  vi.stubEnv("OBSIDIAN_BOOKMARKS_SUBFOLDER", "vault");
  // OAuth config so getValidAccessToken proceeds (no network for valid tokens).
  vi.stubEnv("X_OAUTH2_CLIENT_ID", "cid");
  vi.stubEnv("X_OAUTH2_CLIENT_SECRET", "secret");
  vi.stubEnv("X_OAUTH2_REDIRECT_URI", "http://127.0.0.1:3000/callback");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("parseAccountLabel", () => {
  it("maps auth.json to the default label", () => {
    expect(parseAccountLabel("auth.json")).toBe(DEFAULT_LABEL);
  });
  it("extracts the label from auth.<label>.json", () => {
    expect(parseAccountLabel("auth.francois.json")).toBe("francois");
    expect(parseAccountLabel("auth.foo.bar.json")).toBe("foo.bar");
  });
  it("ignores non-token files", () => {
    expect(parseAccountLabel("config.json")).toBeNull();
    expect(parseAccountLabel("authfoo.json")).toBeNull();
    expect(parseAccountLabel("random.txt")).toBeNull();
  });
});

describe("listAccounts", () => {
  it("lists auth.json + auth.<handle>.json, default first, ignoring config.json", async () => {
    await saveTokens(tokens({ account: { id: "1", username: "alice", name: "Alice" } }));
    await saveTokens(
      tokens({ account: { id: "2", username: "bob", name: "Bob" } }),
      "bob",
    );
    // an unrelated file must be ignored
    await fs.writeFile(path.join(tmpDir, "config.json"), "{}", "utf8");

    const accounts = await listAccounts();
    expect(accounts.map((a) => a.label)).toEqual([DEFAULT_LABEL, "bob"]);
    expect(accounts[0].username).toBe("alice");
    expect(accounts[1].username).toBe("bob");
  });

  it("lists a token file that has no embedded identity (username undefined)", async () => {
    await saveTokens(tokens()); // no account metadata
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].label).toBe(DEFAULT_LABEL);
    expect(accounts[0].username).toBeUndefined();
  });

  it("returns an empty list when nothing is connected", async () => {
    expect(await listAccounts()).toEqual([]);
  });
});

describe("saveAccountTokens", () => {
  it("stores tokens under auth.<handle>.json with identity embedded", async () => {
    const label = await saveAccountTokens(tokens(), {
      id: "42",
      username: "charlie",
      name: "Charlie",
    });
    expect(label).toBe("charlie");
    const loaded = await loadTokens("charlie");
    expect(loaded?.account?.username).toBe("charlie");
    // and it did not clobber the default slot
    expect(await loadTokens(DEFAULT_LABEL)).toBeNull();
  });
});

describe("getAllValidAccessTokens", () => {
  it("returns valid tokens and skips expired-without-refresh accounts", async () => {
    await saveTokens(
      tokens({ access_token: "GOOD", account: { id: "1", username: "alice", name: "Alice" } }),
    );
    await saveTokens(
      tokens({
        access_token: "STALE",
        refresh_token: undefined,
        expires_at: Date.now() - 1000,
      }),
      "bob",
    );

    const valid = await getAllValidAccessTokens();
    expect(valid).toHaveLength(1);
    expect(valid[0].label).toBe(DEFAULT_LABEL);
    expect(valid[0].accessToken).toBe("GOOD");
    expect(valid[0].username).toBe("alice");
  });
});
