/**
 * Module-level tracking of X API v2 usage (rate limits + call counts).
 * Updated on every xFetch / authFetch call. Queried by the UI via
 * /api/xapi/usage to show live rate-limit state.
 */

export interface UsageSnapshot {
  callCount: number;
  sessionStartedAt: number;
  lastCallAt?: number;
  lastPath?: string;
  rateLimitLimit?: number;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
  appLimit24hLimit?: number;
  appLimit24hRemaining?: number;
  appLimit24hReset?: number;
}

const snapshot: UsageSnapshot = {
  callCount: 0,
  sessionStartedAt: Date.now(),
};

function parseHeader(headers: Headers, name: string): number | undefined {
  const v = headers.get(name);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function recordApiCall(headers: Headers, path: string): void {
  snapshot.callCount += 1;
  snapshot.lastCallAt = Date.now();
  snapshot.lastPath = path;

  const rlLimit = parseHeader(headers, "x-rate-limit-limit");
  const rlRemaining = parseHeader(headers, "x-rate-limit-remaining");
  const rlReset = parseHeader(headers, "x-rate-limit-reset");
  if (rlLimit !== undefined) snapshot.rateLimitLimit = rlLimit;
  if (rlRemaining !== undefined) snapshot.rateLimitRemaining = rlRemaining;
  if (rlReset !== undefined) snapshot.rateLimitReset = rlReset;

  const appLimit = parseHeader(headers, "x-app-limit-24hour-limit");
  const appRemaining = parseHeader(headers, "x-app-limit-24hour-remaining");
  const appReset = parseHeader(headers, "x-app-limit-24hour-reset");
  if (appLimit !== undefined) snapshot.appLimit24hLimit = appLimit;
  if (appRemaining !== undefined) snapshot.appLimit24hRemaining = appRemaining;
  if (appReset !== undefined) snapshot.appLimit24hReset = appReset;
}

export function getUsageSnapshot(): UsageSnapshot {
  return { ...snapshot };
}

export function resetUsageSnapshot(): void {
  snapshot.callCount = 0;
  snapshot.sessionStartedAt = Date.now();
  snapshot.lastCallAt = undefined;
  snapshot.lastPath = undefined;
  snapshot.rateLimitLimit = undefined;
  snapshot.rateLimitRemaining = undefined;
  snapshot.rateLimitReset = undefined;
  snapshot.appLimit24hLimit = undefined;
  snapshot.appLimit24hRemaining = undefined;
  snapshot.appLimit24hReset = undefined;
}
