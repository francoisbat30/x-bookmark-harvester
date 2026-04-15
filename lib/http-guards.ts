import type { NextRequest } from "next/server";

/**
 * Same-origin check for API route handlers. Returns true when the request
 * comes from the app itself (same origin, same tab). Use this to reject
 * cross-origin <form action>, <img src>, and fetch() triggers from pages
 * loaded in the user's browser — especially important for endpoints that
 * have side effects (logout, expensive API calls that consume rate limits).
 *
 * Strategy:
 *   1. Prefer `sec-fetch-site` — sent by every modern browser and can
 *      only take four well-known values.
 *   2. Fall back to Origin vs Host comparison for older browsers.
 *   3. No Origin header at all → treat as same-origin (covers curl and
 *      user-typed address bar navigation).
 */
export function isSameOrigin(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return true;
  if (site === "cross-site" || site === "same-site") return false;

  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
