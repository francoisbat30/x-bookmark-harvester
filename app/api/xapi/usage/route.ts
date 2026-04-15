import { NextResponse } from "next/server";
import { getUsageSnapshot } from "@/lib/x/usage";

export async function GET() {
  return NextResponse.json(getUsageSnapshot());
}
