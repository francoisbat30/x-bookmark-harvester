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
    return (
      <div className="topbar-cell">
        <span className="status-dot off" />
        <span className="topbar-label">Auth</span>
        <span className="topbar-value dim">checking…</span>
      </div>
    );
  }

  if (!auth.configured) {
    return (
      <div className="topbar-cell" title="OAuth credentials missing in .env.local">
        <span className="status-dot err" />
        <span className="topbar-label">Auth</span>
        <span className="topbar-value dim">not configured</span>
      </div>
    );
  }

  if (!auth.authenticated) {
    return (
      <div className="topbar-cell">
        <span className="status-dot off" />
        <span className="topbar-label">X</span>
        <a href="/api/auth/x/start" className="btn btn-primary btn-sm">
          Connect
        </a>
      </div>
    );
  }

  return (
    <div className="topbar-cell">
      <span className="status-dot ok" />
      <span className="topbar-label">X</span>
      <span className="topbar-value dim">connected</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>
        Logout
      </button>
    </div>
  );
}
