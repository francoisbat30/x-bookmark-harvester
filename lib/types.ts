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
