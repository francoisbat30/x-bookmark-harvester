"use client";

import type { AuthStatus } from "./types";

export function AuthPanel({
  auth,
  onLogout,
}: {
  auth: AuthStatus | null;
  onLogout: () => void;
}) {
  if (!auth) {
    return <div className="auth-panel muted">Checking auth status…</div>;
  }

  if (!auth.configured) {
    return (
      <div className="auth-panel warn">
        <strong>OAuth 2.0 not configured</strong>
        <div>
          Add <em>X_OAUTH2_CLIENT_ID</em> / <em>X_OAUTH2_CLIENT_SECRET</em> /
          <em>X_OAUTH2_REDIRECT_URI</em> in <code>.env.local</code>, then
          restart the dev server.
        </div>
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <div className="auth-panel">
        <div>
          <strong>Not connected</strong>
          <div className="subtitle-sm">
            Connect your X account to sync bookmarks automatically.
          </div>
        </div>
        <a href="/api/auth/x/start" className="auth-btn">
          Connect X account →
        </a>
      </div>
    );
  }

  const expiresAt = auth.expiresAt ? new Date(auth.expiresAt) : null;

  return (
    <div className="auth-panel ok">
      <div>
        <strong>✓ Connected to X</strong>
        <div className="subtitle-sm">
          Scope: {auth.scope ?? "-"}
          {expiresAt && (
            <>
              {" · "}Token expires {expiresAt.toLocaleString("fr-FR")}
            </>
          )}
        </div>
      </div>
      <button type="button" onClick={onLogout} className="auth-btn secondary">
        Logout
      </button>
    </div>
  );
}
