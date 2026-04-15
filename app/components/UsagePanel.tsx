"use client";

import type { UsageSnapshot } from "./types";

function resetIn(unixSeconds: number | undefined): string | null {
  if (!unixSeconds) return null;
  const diffMs = unixSeconds * 1000 - Date.now();
  if (diffMs <= 0) return "now";
  const mins = Math.ceil(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hours}h` : `${hours}h${rem}m`;
}

export function UsagePanel({ usage }: { usage: UsageSnapshot }) {
  const windowReset = resetIn(usage.rateLimitReset);
  const dayReset = resetIn(usage.appLimit24hReset);

  return (
    <div className="usage-inline">
      <span>
        <span className="k">calls</span>
        <span className="v">{usage.callCount}</span>
      </span>
      {usage.rateLimitLimit !== undefined && (
        <span>
          <span className="k">window</span>
          <span className="v">
            {usage.rateLimitRemaining}/{usage.rateLimitLimit}
          </span>
          {windowReset && <span className="k"> resets {windowReset}</span>}
        </span>
      )}
      {usage.appLimit24hLimit !== undefined && (
        <span>
          <span className="k">24h</span>
          <span className="v">
            {usage.appLimit24hRemaining}/{usage.appLimit24hLimit}
          </span>
          {dayReset && <span className="k"> resets {dayReset}</span>}
        </span>
      )}
    </div>
  );
}
