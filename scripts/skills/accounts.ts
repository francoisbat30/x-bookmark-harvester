/**
 * bookmark-accounts skill CLI — list connected X accounts (the multi-account
 * "selector"). Network-free: reads the token files only, never refreshes.
 *
 *   tsx --env-file=.env.local scripts/skills/accounts.ts
 *
 * Each account is one token file in %APPDATA%\x-bookmark-harvester\:
 *   - auth.json            → label "default" (the legacy single account)
 *   - auth.<handle>.json   → label "<handle>" (added via the OAuth callback)
 *
 * Output is a JSON summary so a Claude routine can pick an account for
 * `skill:sync --account <label>`.
 */
import { listAccounts, loadTokens, DEFAULT_LABEL } from "../../lib/x/auth";

type AccountStatus = "valid" | "refreshable" | "expired" | "unreadable";

async function main() {
  const accounts = await listAccounts();
  const now = Date.now();

  const rows = [];
  for (const acc of accounts) {
    const tokens = await loadTokens(acc.label);
    let status: AccountStatus = "unreadable";
    let expiresAt: string | null = null;
    if (tokens) {
      expiresAt = new Date(tokens.expires_at).toISOString();
      if (tokens.expires_at > now) status = "valid";
      else if (tokens.refresh_token) status = "refreshable";
      else status = "expired";
    }
    rows.push({
      label: acc.label,
      username: acc.username ?? null,
      isDefault: acc.label === DEFAULT_LABEL,
      status,
      expiresAt,
    });
  }

  console.log(
    JSON.stringify({ ok: true, count: rows.length, accounts: rows }, null, 2),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
