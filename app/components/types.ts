import type {
  ExtractError,
  ExtractResult,
  GrokEnrichResult,
  RetryCommentsResult,
} from "@/lib/types";

export type RowStatus =
  | "pending"
  | "processing"
  | "done"
  | "error"
  | "duplicate";

export type EnrichStatus = "idle" | "running" | "done" | "error";
export type RetryStatus = "idle" | "running" | "done" | "error";

export interface Row {
  url: string;
  tweetId?: string;
  status: RowStatus;
  result?: ExtractResult | ExtractError;
  enrich: EnrichStatus;
  enrichResult?: GrokEnrichResult | ExtractError;
  retry: RetryStatus;
  retryResult?: RetryCommentsResult | ExtractError;
}

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  scope?: string;
  expiresAt?: string;
  reason?: string;
}

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

export interface BookmarkListItem {
  id: string;
  authorId: string;
  authorHandle: string;
  authorName: string;
  createdAt: string;
  text: string;
  alreadyCached: boolean;
}

export interface BookmarksListResponse {
  total: number;
  newCount: number;
  knownCount: number;
  bookmarks: BookmarkListItem[];
}
