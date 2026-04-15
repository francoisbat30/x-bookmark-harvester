"use client";

import { useEffect, useState } from "react";
import {
  browseForVaultPath,
  getCurrentVaultPath,
  saveVaultPath,
  type VaultPathInfo,
} from "../settings-actions";

/**
 * VaultBadge — compact top-bar cell showing the current vault path with a
 * Change button. Click Change to expand an inline edit form below the
 * top bar. One field only: the absolute folder where bookmarks land.
 */
export function VaultBadge({
  editing,
  onToggleEdit,
}: {
  editing: boolean;
  onToggleEdit: () => void;
}) {
  const [info, setInfo] = useState<VaultPathInfo | null>(null);

  async function refresh() {
    setInfo(await getCurrentVaultPath());
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!editing) refresh();
  }, [editing]);

  if (!info) {
    return (
      <div className="topbar-cell">
        <span className="topbar-label">Vault</span>
        <span className="topbar-value dim">…</span>
      </div>
    );
  }

  return (
    <div className="topbar-cell" title={info.resolvedAbsolute}>
      <span className="topbar-label">Vault</span>
      <span className="topbar-value">{info.resolvedAbsolute}</span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={onToggleEdit}
      >
        {editing ? "Close" : "Change"}
      </button>
    </div>
  );
}

export function VaultEdit({
  onDone,
}: {
  onDone: (saved: boolean) => void;
}) {
  const [draftPath, setDraftPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCurrentVaultPath().then((info) => setDraftPath(info.resolvedAbsolute));
  }, []);

  async function handleBrowse() {
    setBrowsing(true);
    setError(null);
    try {
      const result = await browseForVaultPath();
      if (!result.supported) {
        setError(
          result.error ??
            "Native folder picker unavailable — paste the path manually",
        );
        return;
      }
      if (result.cancelled || !result.path) return;
      setDraftPath(result.path);
    } finally {
      setBrowsing(false);
    }
  }

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      const result = await saveVaultPath(draftPath);
      if (!result.ok) {
        setError(result.error ?? "Validation failed");
        return;
      }
      onDone(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vault-edit">
      <label htmlFor="vault-path" className="input-label">
        Bookmarks folder (absolute path)
      </label>
      <div className="vault-edit-row">
        <input
          id="vault-path"
          type="text"
          className="input"
          value={draftPath}
          onChange={(e) => setDraftPath(e.target.value)}
          placeholder="C:\Users\you\Documents\ObsidianVault"
          disabled={busy || browsing}
        />
        <button
          type="button"
          className="btn"
          onClick={handleBrowse}
          disabled={busy || browsing}
        >
          {browsing ? "Opening…" : "Browse…"}
        </button>
      </div>
      {error && <div className="vault-edit-error">{error}</div>}
      <div className="vault-edit-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onDone(false)}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSave}
          disabled={busy || browsing}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
