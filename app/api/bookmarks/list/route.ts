import { NextResponse } from "next/server";
import { getValidAccessToken } from "@/lib/x/auth";
import { fetchAllBookmarks } from "@/lib/x/bookmarks";
import { hasCache } from "@/lib/obsidian/cache";

export async function GET() {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return NextResponse.json(
      { error: "Not authenticated. Go to /api/auth/x/start first." },
      { status: 401 },
    );
  }

  try {
    const bookmarks = await fetchAllBookmarks({ accessToken });

    const withStatus = await Promise.all(
      bookmarks.map(async (b) => ({
        ...b,
        alreadyCached: await hasCache(b.id),
      })),
    );

    const knownCount = withStatus.filter((b) => b.alreadyCached).length;
    const newCount = withStatus.length - knownCount;

    return NextResponse.json({
      total: withStatus.length,
      newCount,
      knownCount,
      bookmarks: withStatus,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
