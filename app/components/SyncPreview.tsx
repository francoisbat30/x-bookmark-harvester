"use client";

import { useState } from "react";
import type { BookmarksListResponse } from "./types";

export function SyncPreview({
  data,
  onProcess,
  onCancel,
}: {
  data: BookmarksListResponse;
  onProcess: (limit?: number) => void;
  onCancel: () => void;
}) {
  const [limit, setLimit] = useState<number>(Math.min(data.newCount, 10));
  const effectiveLimit = Math.min(Math.max(limit, 1), data.newCount);
  const estimatedCalls = effectiveLimit * 2 + 1;
  const estimatedSeconds = Math.round(effectiveLimit * 1.5);

  return (
    <div className="sync-preview">
      <div className="sync-preview-header">
        <strong>Found {data.total} bookmark(s)</strong>
        <span className="counts">
          <span className="c-done">{data.newCount} new</span>
          <span className="c-muted">{data.knownCount} already in vault</span>
        </span>
      </div>
      {data.newCount === 0 ? (
        <div className="sync-preview-body">
          Your vault is already in sync with your X bookmarks. Nothing to do.
        </div>
      ) : (
        <div className="sync-preview-body">
          <div className="sync-limit-row">
            <label htmlFor="sync-limit">
              How many to process first?
              <span className="sync-limit-help">
                Test a small batch to measure actual X API credit consumption
                before committing to all {data.newCount}.
              </span>
            </label>
            <input
              id="sync-limit"
              type="number"
              min={1}
              max={data.newCount}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value) || 1)}
              className="sync-limit-input"
            />
          </div>
          <div className="sync-limit-estimate">
            → will process <strong>{effectiveLimit}</strong> bookmark(s) ·{" "}
            ~{estimatedCalls} X API calls · ~{estimatedSeconds}s
          </div>
        </div>
      )}
      <div className="sync-preview-actions">
        <button type="button" onClick={onCancel} className="btn-secondary">
          Cancel
        </button>
        {data.newCount > 0 && (
          <>
            <button
              type="button"
              onClick={() => onProcess(effectiveLimit)}
              className="btn-secondary"
            >
              Process first {effectiveLimit}
            </button>
            <button type="button" onClick={() => onProcess()}>
              Process all {data.newCount}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
