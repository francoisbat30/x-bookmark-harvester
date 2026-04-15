import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import {
  exchangeCodeForTokens,
  getOAuthConfig,
  saveTokens,
} from "@/lib/x/auth";

function safeStateEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  const storedState = req.cookies.get("x_oauth_state")?.value;
  const storedVerifier = req.cookies.get("x_oauth_verifier")?.value;

  const clearAuthCookies = (res: NextResponse): NextResponse => {
    res.cookies.delete("x_oauth_state");
    res.cookies.delete("x_oauth_verifier");
    return res;
  };

  if (error) {
    return clearAuthCookies(
      NextResponse.redirect(
        new URL(
          `/?auth_error=${encodeURIComponent(errorDescription ?? error)}`,
          req.url,
        ),
      ),
    );
  }

  if (!code || !state) {
    return clearAuthCookies(
      NextResponse.redirect(
        new URL("/?auth_error=missing_code_or_state", req.url),
      ),
    );
  }

  if (
    !storedState ||
    !storedVerifier ||
    !safeStateEquals(storedState, state)
  ) {
    return clearAuthCookies(
      NextResponse.redirect(new URL("/?auth_error=state_mismatch", req.url)),
    );
  }

  const config = getOAuthConfig();
  if (!config) {
    return clearAuthCookies(
      NextResponse.redirect(new URL("/?auth_error=not_configured", req.url)),
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(config, code, storedVerifier);
    await saveTokens(tokens);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return clearAuthCookies(
      NextResponse.redirect(
        new URL(`/?auth_error=${encodeURIComponent(msg)}`, req.url),
      ),
    );
  }

  return clearAuthCookies(
    NextResponse.redirect(new URL("/?auth=ok", req.url)),
  );
}
