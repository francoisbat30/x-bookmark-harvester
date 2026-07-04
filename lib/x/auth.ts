import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { getVaultConfig, resolveTargetDir } from "../obsidian/vault";
import { appDataDir } from "../platform";

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";

export const OAUTH_SCOPES = [
  "bookmark.read",
  "tweet.read",
  "users.read",
  "offline.access",
];

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface AccountIdentity {
  id: string;
  username: string;
  name: string;
}

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  token_type: "bearer";
  scope: string;
  expires_at: number;
  /**
   * Identity of the X account these tokens belong to. Written at OAuth
   * callback time (via saveAccountTokens). Absent on the legacy single-account
   * auth.json until it is refreshed by an account-aware code path.
   */
  account?: AccountIdentity;
}

/**
 * Multi-account model — one token file per account:
 *   - the legacy `auth.json` is the account labelled DEFAULT_LABEL ("default"),
 *   - every other account lives in `auth.<label>.json` (label = @handle).
 * The tweet-id dedup (lib/obsidian/cache.ts) is global, so the same tweet
 * bookmarked by several accounts still converges to a single note.
 */
export const DEFAULT_LABEL = "default";

export interface Account {
  label: string;
  filePath: string;
  /** From token metadata when available (no network call). */
  username?: string;
}

export function getOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.X_OAUTH2_CLIENT_ID;
  const clientSecret = process.env.X_OAUTH2_CLIENT_SECRET;
  const redirectUri = process.env.X_OAUTH2_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generateCodeVerifier(): string {
  return base64url(randomBytes(48));
}

export function generateCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function generateState(): string {
  return base64url(randomBytes(16));
}

export function buildAuthorizeUrl(
  config: OAuthConfig,
  state: string,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: OAUTH_SCOPES.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params}`;
}

interface TokenResponse {
  token_type: "bearer";
  access_token: string;
  refresh_token?: string;
  scope: string;
  expires_in: number;
}

export async function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${config.clientId}:${config.clientSecret}`,
      ).toString("base64")}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${err.slice(0, 500)}`);
  }

  const data = (await res.json()) as TokenResponse;
  return toStored(data);
}

export async function refreshTokens(
  config: OAuthConfig,
  refreshToken: string,
): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(
        `${config.clientId}:${config.clientSecret}`,
      ).toString("base64")}`,
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${err.slice(0, 500)}`);
  }

  const data = (await res.json()) as TokenResponse;
  return toStored(data);
}

function toStored(data: TokenResponse): StoredTokens {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: "bearer",
    scope: data.scope,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

/** Sanitize an account label for safe use in a filename. X handles are
 * already `[A-Za-z0-9_]{1,15}`, but stay defensive against odd input. */
function sanitizeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9_-]/g, "_") || DEFAULT_LABEL;
}

/** Resolve the token file for a given account label.
 * DEFAULT_LABEL → the legacy `auth.json`; anything else → `auth.<label>.json`. */
function accountFilePath(label: string = DEFAULT_LABEL): string {
  const name =
    label === DEFAULT_LABEL ? "auth.json" : `auth.${sanitizeLabel(label)}.json`;
  return path.join(appDataDir(), name);
}

/** Extract an account label from a token filename, or null if it is not one.
 * `auth.json` → "default"; `auth.francois.json` → "francois"; other → null
 * (so config.json and unrelated files are ignored). */
export function parseAccountLabel(filename: string): string | null {
  const m = /^auth(?:\.(.+))?\.json$/.exec(filename);
  if (!m) return null;
  return m[1] ?? DEFAULT_LABEL;
}

function authFilePath(): string {
  return accountFilePath(DEFAULT_LABEL);
}

function legacyAuthFilePath(): string {
  return path.join(resolveTargetDir(getVaultConfig()), ".auth.json");
}

/**
 * One-shot migration: if a legacy .auth.json exists inside the Obsidian vault
 * (old hardcoded location), move it to the new per-user data dir and delete
 * the old file. Silent on missing legacy / already-migrated.
 */
async function migrateLegacyAuth(): Promise<void> {
  const legacy = legacyAuthFilePath();
  const target = authFilePath();
  try {
    const raw = await fs.readFile(legacy, "utf8");
    try {
      await fs.access(target);
      // new path already exists — legacy is stale, just delete it
      await fs.unlink(legacy).catch(() => {});
      return;
    } catch {
      // fall through: copy legacy to new path
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, raw, "utf8");
    await fs.chmod(target, 0o600).catch(() => {});
    await fs.unlink(legacy).catch(() => {});
    console.info(
      `[xauth] migrated auth tokens from vault to ${target}`,
    );
  } catch {
    // no legacy file, nothing to do
  }
}

export async function saveTokens(
  tokens: StoredTokens,
  label: string = DEFAULT_LABEL,
): Promise<void> {
  const p = accountFilePath(label);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(tokens, null, 2), "utf8");
  await fs.chmod(p, 0o600).catch(() => {});
}

export async function loadTokens(
  label: string = DEFAULT_LABEL,
): Promise<StoredTokens | null> {
  // Legacy vault → appDataDir migration only concerns the default account.
  if (label === DEFAULT_LABEL) await migrateLegacyAuth();
  try {
    const raw = await fs.readFile(accountFilePath(label), "utf8");
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

export async function clearTokens(
  label: string = DEFAULT_LABEL,
): Promise<void> {
  try {
    await fs.unlink(accountFilePath(label));
  } catch {
    // already gone
  }
  // the legacy vault location only ever held the default account
  if (label === DEFAULT_LABEL) {
    try {
      await fs.unlink(legacyAuthFilePath());
    } catch {
      // already gone
    }
  }
}

/**
 * Persist tokens for a freshly-connected account, keyed by its @handle, with
 * the account identity embedded. Used by the OAuth callback so a second (third…)
 * login never overwrites the existing `auth.json` / another account's file.
 * Returns the label the account was saved under.
 */
export async function saveAccountTokens(
  tokens: StoredTokens,
  identity: AccountIdentity,
): Promise<string> {
  const label = sanitizeLabel(identity.username);
  await saveTokens({ ...tokens, account: identity }, label);
  return label;
}

/**
 * Enumerate every connected account (default first). Runs the one-shot legacy
 * migration, then scans appDataDir for `auth*.json`. Best-effort reads the
 * embedded identity for display (no network call).
 */
export async function listAccounts(): Promise<Account[]> {
  await migrateLegacyAuth();
  const dir = appDataDir();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const accounts: Account[] = [];
  for (const f of entries) {
    const label = parseAccountLabel(f);
    if (label === null) continue;
    const filePath = path.join(dir, f);
    let username: string | undefined;
    try {
      const t = JSON.parse(await fs.readFile(filePath, "utf8")) as StoredTokens;
      username = t.account?.username;
    } catch {
      // unreadable / not our shape — still list it by label
    }
    accounts.push({ label, filePath, username });
  }

  accounts.sort((a, b) => {
    if (a.label === DEFAULT_LABEL) return -1;
    if (b.label === DEFAULT_LABEL) return 1;
    return a.label.localeCompare(b.label);
  });
  return accounts;
}

/**
 * Return a valid (refreshed) access token for every connected account.
 * Accounts whose refresh fails are skipped with a warning rather than
 * aborting the whole run — one dead session must not block the others.
 */
export async function getAllValidAccessTokens(): Promise<
  Array<{ label: string; accessToken: string; username?: string }>
> {
  const accounts = await listAccounts();
  const out: Array<{ label: string; accessToken: string; username?: string }> =
    [];
  for (const acc of accounts) {
    const accessToken = await getValidAccessToken(acc.label);
    if (accessToken) {
      out.push({ label: acc.label, accessToken, username: acc.username });
    } else {
      console.warn(
        `[xauth] account "${acc.label}" has no valid token — reconnect it in the app.`,
      );
    }
  }
  return out;
}

const REFRESH_MARGIN_MS = 60_000;

export async function getValidAccessToken(
  label: string = DEFAULT_LABEL,
): Promise<string | null> {
  const config = getOAuthConfig();
  if (!config) return null;
  const tokens = await loadTokens(label);
  if (!tokens) return null;

  if (tokens.expires_at - REFRESH_MARGIN_MS > Date.now()) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    return null;
  }

  try {
    const refreshed = await refreshTokens(config, tokens.refresh_token);
    // Preserve the embedded account identity across refreshes.
    await saveTokens(
      tokens.account ? { ...refreshed, account: tokens.account } : refreshed,
      label,
    );
    return refreshed.access_token;
  } catch {
    await clearTokens(label);
    return null;
  }
}
