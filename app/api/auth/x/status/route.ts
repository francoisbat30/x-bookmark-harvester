import { NextResponse } from "next/server";
import { getOAuthConfig, loadTokens } from "@/lib/x/auth";

export async function GET() {
  const config = getOAuthConfig();
  if (!config) {
    return NextResponse.json({
      configured: false,
      authenticated: false,
      reason: "OAuth credentials missing in .env.local",
    });
  }

  const tokens = await loadTokens();
  if (!tokens) {
    return NextResponse.json({ configured: true, authenticated: false });
  }

  return NextResponse.json({
    configured: true,
    authenticated: true,
    scope: tokens.scope,
    expiresAt: new Date(tokens.expires_at).toISOString(),
  });
}
