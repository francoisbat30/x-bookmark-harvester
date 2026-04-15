"use client";

import { useEffect, useState } from "react";
import {
  deepSearchAction,
  getDeepSearchByHashAction,
  listDeepSearchHistoryAction,
  deleteDeepSearchAction,
} from "../actions";
import type {
  DeepSearchCandidate,
  DeepSearchHistoryEntry,
  DeepSearchResult,
} from "@/lib/types";

interface DeepSearchProps {
  onExtract: (urls: string[], refetch: boolean) => void;
  disabled?: boolean;
}

const ESTIMATED_COST = 0.82;

function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    setElapsed(0);
    const i = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(i);
  }, [active]);
  return elapsed;
}

export function DeepSearch({ onExtract, disabled }: DeepSearchProps) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeepSearchResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<DeepSearchHistoryEntry[]>([]);
  const elapsed = useElapsed(busy);

  async function handleSearch(forceFresh = false) {
    const trimmed = query.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const r = await deepSearchAction(trimmed, { forceFresh });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setResult(r);
      // Default: select all non-cached candidates
      setSelected(
        new Set(
          r.candidates.filter((c) => !c.alreadyCached).map((c) => c.tweetId),
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenHistory() {
    setShowHistory(true);
    setHistory(await listDeepSearchHistoryAction());
  }

  async function handleRehydrate(hash: string) {
    const r = await getDeepSearchByHashAction(hash);
    if (r.ok) {
      setResult(r);
      setQuery(r.query);
      setSelected(
        new Set(
          r.candidates.filter((c) => !c.alreadyCached).map((c) => c.tweetId),
        ),
      );
      setShowHistory(false);
    } else {
      setError(r.error);
    }
  }

  async function handleDeleteHistory(hash: string) {
    await deleteDeepSearchAction(hash);
    setHistory((prev) => prev.filter((h) => h.queryHash !== hash));
  }

  function toggleOne(tweetId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tweetId)) next.delete(tweetId);
      else next.add(tweetId);
      return next;
    });
  }

  function selectAll() {
    if (!result) return;
    setSelected(new Set(result.candidates.map((c) => c.tweetId)));
  }

  function selectNone() {
    setSelected(new Set());
  }

  function handleExtractSelected() {
    if (!result) return;
    const urls = result.candidates
      .filter((c) => selected.has(c.tweetId))
      .map((c) => c.url);
    onExtract(urls, false);
  }

  const buttonLabel = busy
    ? `⟳ Searching… ${elapsed}s`
    : "Deep Search";

  return (
    <div className="panel deep-search">
      <div className="deep-search-header">
        <label htmlFor="ds-query" className="panel-label">
          Deep Search — natural language research topic
        </label>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={handleOpenHistory}
          disabled={busy}
        >
          ⌘ History
        </button>
      </div>

      <textarea
        id="ds-query"
        className="textarea"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={
          "e.g. Seedance 2.0 in CapCut — prompting best practices, motion control, visual consistency, before/after"
        }
        rows={3}
        disabled={busy || disabled}
      />

      <div className="panel-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => handleSearch(false)}
          disabled={busy || disabled || !query.trim()}
        >
          {buttonLabel}
        </button>
        <span className="ds-cost">~${ESTIMATED_COST.toFixed(2)} · 60–120s</span>
        {result && !busy && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => handleSearch(true)}
          >
            Re-run fresh
          </button>
        )}
      </div>

      {error && <div className="toast err">{error}</div>}

      {showHistory && (
        <DeepSearchHistoryDrawer
          entries={history}
          onClose={() => setShowHistory(false)}
          onRehydrate={handleRehydrate}
          onDelete={handleDeleteHistory}
        />
      )}

      {result && !busy && (
        <DeepSearchResultView
          result={result}
          selected={selected}
          onToggle={toggleOne}
          onSelectAll={selectAll}
          onSelectNone={selectNone}
          onExtract={handleExtractSelected}
        />
      )}
    </div>
  );
}

function DeepSearchResultView({
  result,
  selected,
  onToggle,
  onSelectAll,
  onSelectNone,
  onExtract,
}: {
  result: DeepSearchResult;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onExtract: () => void;
}) {
  const { candidates, subQueries, stats, fromCache } = result;
  const grokOnly = candidates.filter((c) => c.source === "grok").length;
  const xapiOnly = candidates.filter((c) => c.source === "xapi").length;
  const both = candidates.filter((c) => c.source === "both").length;

  return (
    <div className="ds-result">
      <div className="ds-meta">
        <span className="counts">
          <span className="c-done">{candidates.length} candidates</span>
          <span className="c-muted">
            {grokOnly} grok · {xapiOnly} xapi · {both} both
          </span>
          <span className="c-muted">
            {stats.grokCallCount} grok calls ·{" "}
            {stats.xApiCallCount} xapi calls ·{" "}
            ~${stats.estimatedCost.toFixed(2)} ·{" "}
            {Math.round(stats.elapsedMs / 1000)}s
            {fromCache && " · from cache"}
          </span>
        </span>
      </div>

      <details className="ds-subqueries">
        <summary>
          Searched {subQueries.length} angle(s)
        </summary>
        <ul>
          {subQueries.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      </details>

      <div className="ds-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onSelectAll}>
          All
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onSelectNone}>
          None
        </button>
        <div className="topbar-spacer" />
        <button
          type="button"
          className="btn btn-primary"
          onClick={onExtract}
          disabled={selected.size === 0}
        >
          Extract {selected.size}
        </button>
      </div>

      <div className="ds-candidates">
        {candidates.map((c) => (
          <CandidateRow
            key={c.tweetId}
            candidate={c}
            selected={selected.has(c.tweetId)}
            onToggle={() => onToggle(c.tweetId)}
          />
        ))}
      </div>
    </div>
  );
}

function CandidateRow({
  candidate,
  selected,
  onToggle,
}: {
  candidate: DeepSearchCandidate;
  selected: boolean;
  onToggle: () => void;
}) {
  const m = candidate.metrics;
  return (
    <label className={`ds-row ${selected ? "sel" : ""}`}>
      <input type="checkbox" checked={selected} onChange={onToggle} />
      <div className="ds-row-body">
        <div className="ds-row-head">
          <span className="ds-author">@{candidate.authorHandle || "unknown"}</span>
          {candidate.date && <span className="ds-date">{candidate.date}</span>}
          <span className={`ds-format ds-format-${candidate.format}`}>
            {candidate.format}
          </span>
          {candidate.alreadyCached && (
            <span className="ds-cached">cached</span>
          )}
          {candidate.llmScore !== undefined && (
            <span className="ds-llm-score">{candidate.llmScore}/5</span>
          )}
          {m && (
            <span className="ds-metrics">
              ♥ {m.likes} · ↻ {m.retweets} · ↓ {m.replies}
            </span>
          )}
        </div>
        {candidate.text && <div className="ds-snippet">{candidate.text}</div>}
        {candidate.rationale && (
          <div className="ds-rationale">→ {candidate.rationale}</div>
        )}
        <div className="ds-row-footer">
          <a href={candidate.url} target="_blank" rel="noreferrer" className="ds-link">
            {candidate.url}
          </a>
          <span className="ds-foundby">
            found by: {candidate.foundBy.slice(0, 2).join(", ")}
            {candidate.foundBy.length > 2 ? "…" : ""}
          </span>
        </div>
      </div>
    </label>
  );
}

function DeepSearchHistoryDrawer({
  entries,
  onClose,
  onRehydrate,
  onDelete,
}: {
  entries: DeepSearchHistoryEntry[];
  onClose: () => void;
  onRehydrate: (hash: string) => void;
  onDelete: (hash: string) => void;
}) {
  return (
    <div className="ds-history">
      <div className="ds-history-header">
        <strong>Recent deep searches</strong>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="ds-history-empty">No cached deep searches yet.</div>
      ) : (
        <ul className="ds-history-list">
          {entries.map((e) => (
            <li key={e.queryHash} className="ds-history-row">
              <button
                type="button"
                className="ds-history-main"
                onClick={() => onRehydrate(e.queryHash)}
                title={e.query}
              >
                <span className="ds-history-date">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
                <span className="ds-history-query">{e.query}</span>
                <span className="ds-history-count">
                  {e.candidateCount} candidates · ${e.estimatedCost.toFixed(2)}
                </span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => onDelete(e.queryHash)}
              >
                ✗
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
