import { NextResponse } from "next/server";
import {
  buildAuthorizeUrl,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  getOAuthConfig,
} from "@/lib/x/auth";

export async function GET() {
  const config = getOAuthConfig();
  if (!config) {
    return NextResponse.json(
      {
        error:
          "OAuth 2.0 credentials not configured. Set X_OAUTH2_CLIENT_ID, X_OAUTH2_CLIENT_SECRET, X_OAUTH2_REDIRECT_URI in .env.local.",
      },
      { status: 500 },
    );
  }

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const authorizeUrl = buildAuthorizeUrl(config, state, codeChallenge);

  const response = NextResponse.redirect(authorizeUrl);

  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    maxAge: 600,
    path: "/",
  };

  response.cookies.set("x_oauth_state", state, cookieOptions);
  response.cookies.set("x_oauth_verifier", codeVerifier, cookieOptions);

  return response;
}
