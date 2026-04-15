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
        <strong>{data.total} bookmark(s) on your account</strong>
        <span className="counts">
          <span className="c-done">{data.newCount} new</span>
          <span className="c-muted">{data.knownCount} already saved</span>
        </span>
      </div>

      {data.newCount === 0 ? (
        <div className="sync-preview-empty">
          Your vault is in sync with X. Nothing to do.
        </div>
      ) : (
        <>
          <div className="sync-limit-row">
            <label htmlFor="sync-limit">
              Process how many first?
              <span className="sync-limit-help">
                Test a small batch before committing all {data.newCount}.
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
            → {effectiveLimit} bookmark(s) · ~{estimatedCalls} X API calls · ~
            {estimatedSeconds}s
          </div>
        </>
      )}

      <div className="sync-preview-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        {data.newCount > 0 && (
          <>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => onProcess(effectiveLimit)}
            >
              First {effectiveLimit}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onProcess()}
            >
              All {data.newCount}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
