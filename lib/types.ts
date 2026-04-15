export interface PostMedia {
  type: "image" | "video" | "gif";
  url: string;
}

export interface PostComment {
  handle: string;
  name: string;
  date: string;
  text: string;
}

export interface PostMetrics {
  likes: number;
  retweets: number;
  replies: number;
  views: number;
}

export interface PostExtraction {
  url: string;
  author: {
    handle: string;
    name: string;
  };
  date: string;
  text: string;
  media: PostMedia[];
  metrics: PostMetrics;
  comments: PostComment[];
}

export interface ExtractResult {
  ok: true;
  filename: string;
  absolutePath: string;
  source: "cache" | "grok" | "xapi";
  isDuplicate: boolean;
  cachedAt?: string;
  staleCommentsDetected?: boolean;
}

export interface RetryCommentsResult {
  ok: true;
  tweetId: string;
  filename: string;
  absolutePath: string;
  commentsBefore: number;
  commentsAfter: number;
}

export interface NotableLink {
  url: string;
  context: string;
}

export interface KeyReply {
  handle: string;
  quote: string;
  why: string;
}

export interface GrokInsights {
  author_additions: string | null;
  notable_links: NotableLink[];
  sentiment: string;
  key_replies: KeyReply[];
}

export interface GrokEnrichResult {
  ok: true;
  tweetId: string;
  filename: string;
  absolutePath: string;
  insights: GrokInsights;
}

export interface ExtractError {
  ok: false;
  error: string;
}

/* ───────── Deep Search ───────── */

export type DeepSearchFormat = "post" | "thread" | "article";
export type DeepSearchSource = "grok" | "xapi" | "both";

export interface DeepSearchCandidate {
  tweetId: string;
  url: string;
  authorHandle: string;
  authorName: string;
  /** Short snippet, first ~240 chars of the tweet text. */
  text: string;
  /** ISO date (YYYY-MM-DD) or empty. */
  date: string;
  format: DeepSearchFormat;
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    views?: number;
  } | null;
  /** Sub-queries that matched this candidate. */
  foundBy: string[];
  source: DeepSearchSource;
  /** One-line rationale: from Grok search or aggregation rerank. */
  rationale: string;
  mechanicalScore: number;
  /** Optional 1-5 score from the aggregation rerank call. */
  llmScore?: number;
  finalScore: number;
  alreadyCached: boolean;
}

export interface DeepSearchStats {
  grokCallCount: number;
  xApiCallCount: number;
  estimatedCost: number;
  elapsedMs: number;
}

export interface DeepSearchResult {
  ok: true;
  queryHash: string;
  query: string;
  createdAt: string;
  fromCache: boolean;
  subQueries: string[];
  candidates: DeepSearchCandidate[];
  stats: DeepSearchStats;
}

export interface DeepSearchHistoryEntry {
  queryHash: string;
  query: string;
  createdAt: string;
  lastAccessedAt: string;
  candidateCount: number;
  estimatedCost: number;
}
