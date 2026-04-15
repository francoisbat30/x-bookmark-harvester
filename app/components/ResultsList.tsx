"use client";

import type { Row } from "./types";

export function ResultsList({
  rows,
  onEnrich,
  onRetry,
}: {
  rows: Row[];
  onEnrich: (idx: number) => void;
  onRetry: (idx: number) => void;
}) {
  const counts = {
    done: rows.filter((r) => r.status === "done").length,
    duplicate: rows.filter((r) => r.status === "duplicate").length,
    error: rows.filter((r) => r.status === "error").length,
    processing: rows.filter((r) => r.status === "processing").length,
    pending: rows.filter((r) => r.status === "pending").length,
    enriched: rows.filter((r) => r.enrich === "done").length,
    stale: rows.filter((r) => r.result?.ok && r.result.staleCommentsDetected)
      .length,
  };

  return (
    <div className="results-list">
      <div className="results-header">
        <strong>{rows.length} URL(s)</strong>
        <span className="counts">
          {counts.done > 0 && <span className="c-done">✓ {counts.done}</span>}
          {counts.duplicate > 0 && (
            <span className="c-warn">⚠ {counts.duplicate} déjà traité</span>
          )}
          {counts.error > 0 && <span className="c-err">✗ {counts.error}</span>}
          {counts.processing > 0 && (
            <span className="c-info">⟳ {counts.processing}</span>
          )}
          {counts.pending > 0 && (
            <span className="c-muted">⋯ {counts.pending}</span>
          )}
          {counts.enriched > 0 && (
            <span className="c-grok">✨ {counts.enriched}</span>
          )}
          {counts.stale > 0 && (
            <span className="c-warn">⟲ {counts.stale} stale</span>
          )}
        </span>
      </div>
      {rows.map((row, i) => (
        <ResultRow
          key={i}
          row={row}
          onEnrich={() => onEnrich(i)}
          onRetry={() => onRetry(i)}
        />
      ))}
    </div>
  );
}

function ResultRow({
  row,
  onEnrich,
  onRetry,
}: {
  row: Row;
  onEnrich: () => void;
  onRetry: () => void;
}) {
  const icon =
    row.status === "pending"
      ? "⋯"
      : row.status === "processing"
        ? "⟳"
        : row.status === "done"
          ? "✓"
          : row.status === "duplicate"
            ? "⚠"
            : "✗";

  const canEnrich =
    (row.status === "done" || row.status === "duplicate") && row.tweetId;

  const canRetryComments =
    canEnrich && row.result?.ok && row.result.staleCommentsDetected;

  const enrichLabel =
    row.enrich === "running"
      ? "⟳ Grok running…"
      : row.enrich === "done"
        ? "✨ Enriched"
        : row.enrich === "error"
          ? "✗ Retry"
          : "✨ Grok insights";

  const retryLabel =
    row.retry === "running"
      ? "⟳ Fetching…"
      : row.retry === "done"
        ? row.retryResult?.ok
          ? `⟲ ${row.retryResult.commentsAfter} replies`
          : "⟲ Done"
        : row.retry === "error"
          ? "✗ Retry replies"
          : "⟲ Retry replies with Grok";

  return (
    <div className={`row-item row-${row.status}`}>
      <span className="icon">{icon}</span>
      <div className="row-body">
        <div className="row-url">{row.url}</div>
        {row.status === "done" && row.result?.ok && (
          <div className="row-detail">
            {row.result.source === "xapi"
              ? "X API"
              : row.result.source === "grok"
                ? "Grok"
                : "cache"}{" "}
            → {row.result.filename}
          </div>
        )}
        {row.status === "duplicate" && row.result?.ok && (
          <div className="row-detail">
            Déjà dans le vault — {row.result.filename}
          </div>
        )}
        {row.status === "error" && row.result && !row.result.ok && (
          <div className="row-detail">{row.result.error}</div>
        )}
        {row.enrichResult && !row.enrichResult.ok && (
          <div className="row-detail row-enrich-error">
            Grok: {row.enrichResult.error}
          </div>
        )}
        {row.enrichResult && row.enrichResult.ok && (
          <div className="row-detail row-enrich-summary">
            {row.enrichResult.insights.notable_links.length} link(s),{" "}
            {row.enrichResult.insights.key_replies.length} key replies
            {row.enrichResult.insights.author_additions
              ? ", author additions"
              : ""}
          </div>
        )}
        {canRetryComments && row.retry === "idle" && (
          <div className="row-detail row-stale-hint">
            X API missed all replies on this post — Grok can probably recover them.
          </div>
        )}
        {row.retryResult && row.retryResult.ok && (
          <div className="row-detail row-enrich-summary">
            Comments: {row.retryResult.commentsBefore} →{" "}
            {row.retryResult.commentsAfter}
          </div>
        )}
        {row.retryResult && !row.retryResult.ok && (
          <div className="row-detail row-enrich-error">
            Retry: {row.retryResult.error}
          </div>
        )}
      </div>
      <div className="row-actions">
        {canRetryComments && (
          <button
            type="button"
            className={`retry-btn retry-${row.retry}`}
            onClick={onRetry}
            disabled={row.retry === "running" || row.retry === "done"}
          >
            {retryLabel}
          </button>
        )}
        {canEnrich && (
          <button
            type="button"
            className={`enrich-btn enrich-${row.enrich}`}
            onClick={onEnrich}
            disabled={row.enrich === "running" || row.enrich === "done"}
          >
            {enrichLabel}
          </button>
        )}
      </div>
    </div>
  );
}
