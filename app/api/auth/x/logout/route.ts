import { NextRequest, NextResponse } from "next/server";
import { clearTokens } from "@/lib/x/auth";
import { isSameOrigin } from "@/lib/http-guards";

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return NextResponse.json(
      { error: "cross-origin request refused" },
      { status: 403 },
    );
  }
  await clearTokens();
  return NextResponse.json({ ok: true });
}
