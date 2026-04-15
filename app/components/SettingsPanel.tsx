"use client";

import { useEffect, useState } from "react";
import {
  browseForVaultPath,
  getCurrentVaultPath,
  saveVaultPath,
  type VaultPathInfo,
} from "../settings-actions";

type Mode = "collapsed" | "editing";

export function SettingsPanel() {
  const [info, setInfo] = useState<VaultPathInfo | null>(null);
  const [mode, setMode] = useState<Mode>("collapsed");
  const [draftPath, setDraftPath] = useState("");
  const [draftSubfolder, setDraftSubfolder] = useState("x-bookmarks");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function refresh() {
    const current = await getCurrentVaultPath();
    setInfo(current);
    setDraftPath(current.vaultPath);
    setDraftSubfolder(current.subfolder);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleBrowse() {
    setBusy(true);
    setError(null);
    try {
      const result = await browseForVaultPath();
      if (!result.supported) {
        setError(
          result.error ??
            "Native folder picker not available on this OS — paste the path manually.",
        );
        return;
      }
      if (result.cancelled || !result.path) return;
      setDraftPath(result.path);
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      const result = await saveVaultPath(draftPath, draftSubfolder);
      if (!result.ok) {
        setError(result.error ?? "Unknown validation error");
        return;
      }
      setToast(`Vault updated → ${result.resolvedAbsolute}`);
      setMode("collapsed");
      await refresh();
      setTimeout(() => setToast(null), 4000);
    } finally {
      setBusy(false);
    }
  }

  function handleCancel() {
    setMode("collapsed");
    setError(null);
    if (info) {
      setDraftPath(info.vaultPath);
      setDraftSubfolder(info.subfolder);
    }
  }

  if (!info) {
    return <div className="settings-panel muted">Loading settings…</div>;
  }

  const sourceLabel = {
    "user-config": "user-config",
    env: ".env.local",
    default: "default",
  }[info.source];

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <div>
          <strong>Vault location</strong>
          <div className="subtitle-sm">
            <code>{info.resolvedAbsolute}</code>{" "}
            <span className={`badge badge-${info.source}`}>{sourceLabel}</span>
            {!info.exists && (
              <span className="badge badge-warn">not found</span>
            )}
            {info.exists && !info.writable && (
              <span className="badge badge-warn">read-only</span>
            )}
          </div>
        </div>
        {mode === "collapsed" && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setMode("editing")}
          >
            Change…
          </button>
        )}
      </div>

      {mode === "editing" && (
        <div className="settings-edit">
          <label htmlFor="vault-path">Vault folder (absolute path)</label>
          <div className="settings-path-row">
            <input
              id="vault-path"
              type="text"
              value={draftPath}
              onChange={(e) => setDraftPath(e.target.value)}
              placeholder="C:\Users\you\Documents\ObsidianVault"
              disabled={busy}
            />
            <button
              type="button"
              className="btn-secondary"
              onClick={handleBrowse}
              disabled={busy}
            >
              Browse…
            </button>
          </div>

          <label htmlFor="vault-subfolder">Subfolder</label>
          <input
            id="vault-subfolder"
            type="text"
            value={draftSubfolder}
            onChange={(e) => setDraftSubfolder(e.target.value)}
            placeholder="x-bookmarks"
            disabled={busy}
          />

          {error && <div className="settings-error">✗ {error}</div>}

          <div className="settings-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={handleCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button type="button" onClick={handleSave} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {toast && <div className="settings-toast">✓ {toast}</div>}
    </div>
  );
}
