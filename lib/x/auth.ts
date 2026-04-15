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

export interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  token_type: "bearer";
  scope: string;
  expires_at: number;
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

function authFilePath(): string {
  return path.join(appDataDir(), "auth.json");
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

export async function saveTokens(tokens: StoredTokens): Promise<void> {
  const p = authFilePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(tokens, null, 2), "utf8");
  await fs.chmod(p, 0o600).catch(() => {});
}

export async function loadTokens(): Promise<StoredTokens | null> {
  await migrateLegacyAuth();
  try {
    const raw = await fs.readFile(authFilePath(), "utf8");
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

export async function clearTokens(): Promise<void> {
  try {
    await fs.unlink(authFilePath());
  } catch {
    // already gone
  }
  // also clean legacy location if it still exists
  try {
    await fs.unlink(legacyAuthFilePath());
  } catch {
    // already gone
  }
}

const REFRESH_MARGIN_MS = 60_000;

export async function getValidAccessToken(): Promise<string | null> {
  const config = getOAuthConfig();
  if (!config) return null;
  const tokens = await loadTokens();
  if (!tokens) return null;

  if (tokens.expires_at - REFRESH_MARGIN_MS > Date.now()) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    return null;
  }

  try {
    const refreshed = await refreshTokens(config, tokens.refresh_token);
    await saveTokens(refreshed);
    return refreshed.access_token;
  } catch {
    await clearTokens();
    return null;
  }
}
