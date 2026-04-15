"use client";

import type { UsageSnapshot } from "./types";

export function UsagePanel({ usage }: { usage: UsageSnapshot }) {
  const now = Date.now();

  const resetIn = (unixSeconds: number | undefined): string | null => {
    if (!unixSeconds) return null;
    const diffMs = unixSeconds * 1000 - now;
    if (diffMs <= 0) return "now";
    const mins = Math.ceil(diffMs / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem === 0 ? `${hours}h` : `${hours}h${rem}m`;
  };

  const ratePct =
    usage.rateLimitLimit && usage.rateLimitRemaining !== undefined
      ? Math.round(
          ((usage.rateLimitLimit - usage.rateLimitRemaining) /
            usage.rateLimitLimit) *
            100,
        )
      : null;

  const dayPct =
    usage.appLimit24hLimit && usage.appLimit24hRemaining !== undefined
      ? Math.round(
          ((usage.appLimit24hLimit - usage.appLimit24hRemaining) /
            usage.appLimit24hLimit) *
            100,
        )
      : null;

  return (
    <div className="usage-panel">
      <div className="usage-row">
        <span className="usage-label">X API calls (session)</span>
        <span className="usage-value">{usage.callCount}</span>
      </div>
      {usage.rateLimitLimit !== undefined && (
        <div className="usage-row">
          <span className="usage-label">Window rate limit</span>
          <span className="usage-value">
            {usage.rateLimitRemaining} / {usage.rateLimitLimit}
            {ratePct !== null && (
              <span className="usage-pct"> · {ratePct}% used</span>
            )}
            {resetIn(usage.rateLimitReset) && (
              <span className="usage-pct">
                {" "}
                · resets in {resetIn(usage.rateLimitReset)}
              </span>
            )}
          </span>
        </div>
      )}
      {usage.appLimit24hLimit !== undefined && (
        <div className="usage-row">
          <span className="usage-label">24h app limit</span>
          <span className="usage-value">
            {usage.appLimit24hRemaining} / {usage.appLimit24hLimit}
            {dayPct !== null && (
              <span className="usage-pct"> · {dayPct}% used</span>
            )}
            {resetIn(usage.appLimit24hReset) && (
              <span className="usage-pct">
                {" "}
                · resets in {resetIn(usage.appLimit24hReset)}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
