"use client";

import { useState, useEffect, useTransition } from "react";
import {
  extractBookmark,
  enrichWithGrok,
  retryCommentsWithGrok,
} from "./actions";
import { AuthPanel } from "./components/AuthPanel";
import { UsagePanel } from "./components/UsagePanel";
import { SyncPreview } from "./components/SyncPreview";
import { ResultsList } from "./components/ResultsList";
import { SettingsPanel } from "./components/SettingsPanel";
import type {
  AuthStatus,
  BookmarksListResponse,
  Row,
  RowStatus,
  UsageSnapshot,
} from "./components/types";

function parseUrls(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractTweetId(url: string): string | null {
  const m = url.match(/status\/(\d+)/);
  return m ? m[1] : null;
}

export default function Home() {
  const [rows, setRows] = useState<Row[]>([]);
  const [isPending, startTransition] = useTransition();
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [syncState, setSyncState] = useState<
    | { phase: "idle" }
    | { phase: "listing" }
    | { phase: "preview"; data: BookmarksListResponse }
    | { phase: "error"; message: string }
  >({ phase: "idle" });
  const [authToast, setAuthToast] = useState<
    { kind: "ok" | "err"; message: string } | null
  >(null);

  async function refreshUsage() {
    try {
      const data = await fetch("/api/xapi/usage").then((r) => r.json());
      setUsage(data);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    fetch("/api/auth/x/status")
      .then((r) => r.json())
      .then(setAuth)
      .catch(() => setAuth({ configured: false, authenticated: false }));

    refreshUsage();

    const params = new URLSearchParams(window.location.search);
    if (params.get("auth") === "ok") {
      setAuthToast({ kind: "ok", message: "Connected to X" });
      window.history.replaceState({}, "", window.location.pathname);
    } else if (params.get("auth_error")) {
      setAuthToast({
        kind: "err",
        message: params.get("auth_error") ?? "unknown error",
      });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  useEffect(() => {
    if (isPending || syncState.phase === "listing") {
      const interval = setInterval(refreshUsage, 2000);
      return () => clearInterval(interval);
    }
    refreshUsage();
  }, [isPending, syncState.phase]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const urlsRaw = (form.elements.namedItem("urls") as HTMLTextAreaElement)
      .value;
    const refetch = (form.elements.namedItem("refetch") as HTMLInputElement)
      .checked;

    const urls = parseUrls(urlsRaw);
    if (urls.length === 0) return;

    processUrls(urls, refetch);
  }

  function processUrls(urls: string[], refetch: boolean) {
    setRows(
      urls.map((url) => ({
        url,
        tweetId: extractTweetId(url) ?? undefined,
        status: "pending",
        enrich: "idle",
        retry: "idle",
      })),
    );

    startTransition(async () => {
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        setRows((prev) =>
          prev.map((r, idx) =>
            idx === i ? { ...r, status: "processing" } : r,
          ),
        );

        const fd = new FormData();
        fd.set("url", url);
        if (refetch) fd.set("refetch", "on");

        const result = await extractBookmark(null, fd);

        const status: RowStatus = !result.ok
          ? "error"
          : result.isDuplicate
            ? "duplicate"
            : "done";

        setRows((prev) =>
          prev.map((r, idx) => (idx === i ? { ...r, status, result } : r)),
        );
      }
    });
  }

  async function handleSyncClick() {
    setSyncState({ phase: "listing" });
    try {
      const res = await fetch("/api/bookmarks/list");
      const data = (await res.json()) as
        | BookmarksListResponse
        | { error: string };
      if (!res.ok || "error" in data) {
        setSyncState({
          phase: "error",
          message: "error" in data ? data.error : "Unknown error",
        });
        return;
      }
      setSyncState({ phase: "preview", data });
    } catch (e) {
      setSyncState({
        phase: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  function handleProcessNew(limit?: number) {
    if (syncState.phase !== "preview") return;
    const newOnes = syncState.data.bookmarks.filter((b) => !b.alreadyCached);
    const slice =
      typeof limit === "number" ? newOnes.slice(0, limit) : newOnes;
    const urls = slice.map(
      (b) => `https://x.com/${b.authorHandle || "i"}/status/${b.id}`,
    );
    setSyncState({ phase: "idle" });
    processUrls(urls, false);
  }

  async function handleGrokEnrich(rowIdx: number) {
    const row = rows[rowIdx];
    if (!row.tweetId) return;

    setRows((prev) =>
      prev.map((r, idx) => (idx === rowIdx ? { ...r, enrich: "running" } : r)),
    );

    const result = await enrichWithGrok(row.tweetId);

    setRows((prev) =>
      prev.map((r, idx) =>
        idx === rowIdx
          ? {
              ...r,
              enrich: result.ok ? "done" : "error",
              enrichResult: result,
            }
          : r,
      ),
    );
  }

  async function handleRetryComments(rowIdx: number) {
    const row = rows[rowIdx];
    if (!row.tweetId) return;

    setRows((prev) =>
      prev.map((r, idx) => (idx === rowIdx ? { ...r, retry: "running" } : r)),
    );

    const result = await retryCommentsWithGrok(row.tweetId);

    setRows((prev) =>
      prev.map((r, idx) =>
        idx === rowIdx
          ? {
              ...r,
              retry: result.ok ? "done" : "error",
              retryResult: result,
            }
          : r,
      ),
    );
  }

  async function handleLogout() {
    await fetch("/api/auth/x/logout", { method: "POST" });
    const status = await fetch("/api/auth/x/status").then((r) => r.json());
    setAuth(status);
  }

  const totalCount = rows.length;
  const doneCount = rows.filter(
    (r) =>
      r.status === "done" || r.status === "duplicate" || r.status === "error",
  ).length;

  return (
    <main>
      <h1>X Bookmark Harvester</h1>
      <p className="subtitle">
        Sync ton compte X pour récupérer tous tes bookmarks, ou colle une liste
        de liens manuellement. X API v2 est la source ; Grok s&apos;utilise à
        la demande pour enrichir un bookmark spécifique.
      </p>

      <SettingsPanel />

      <AuthPanel auth={auth} onLogout={handleLogout} />

      {usage && usage.callCount > 0 && <UsagePanel usage={usage} />}

      {authToast && (
        <div className={`toast toast-${authToast.kind}`}>
          {authToast.kind === "ok" ? "✓" : "✗"} {authToast.message}
        </div>
      )}

      {auth?.authenticated && (
        <div className="sync-card">
          <div>
            <strong>Sync from your X account</strong>
            <div className="subtitle-sm">
              Fetches your bookmarks list via X API, dedups against your vault,
              then processes only the new ones.
            </div>
          </div>
          <button
            type="button"
            onClick={handleSyncClick}
            disabled={syncState.phase === "listing" || isPending}
            className="sync-btn"
          >
            {syncState.phase === "listing"
              ? "Fetching list…"
              : "Sync my bookmarks"}
          </button>
        </div>
      )}

      {syncState.phase === "preview" && (
        <SyncPreview
          data={syncState.data}
          onProcess={handleProcessNew}
          onCancel={() => setSyncState({ phase: "idle" })}
        />
      )}

      {syncState.phase === "error" && (
        <div className="result err">
          <strong>Sync failed</strong>
          {syncState.message}
        </div>
      )}

      <form onSubmit={handleSubmit} className="card">
        <label htmlFor="urls">
          Manual paste — URLs des posts X (un par ligne)
        </label>
        <textarea
          id="urls"
          name="urls"
          placeholder={
            "https://x.com/user/status/1234567890\nhttps://x.com/other/status/9876543210"
          }
          rows={5}
          autoComplete="off"
          disabled={isPending}
        />

        <div className="row">
          <button type="submit" disabled={isPending}>
            {isPending ? `Extraction ${doneCount}/${totalCount}…` : "Extraire"}
          </button>
          <label className="checkbox">
            <input type="checkbox" name="refetch" disabled={isPending} />
            Bypass cache
          </label>
        </div>
      </form>

      {rows.length > 0 && (
        <ResultsList
          rows={rows}
          onEnrich={handleGrokEnrich}
          onRetry={handleRetryComments}
        />
      )}
    </main>
  );
}
