export interface PostMedia {
  type: "image" | "video" | "gif";
  url: string;
  /**
   * Image de couverture (preview) pour les vidéos/gifs — téléchargée en local
   * pour que la note garde un visuel même quand l'URL mp4 distante meurt.
   */
  posterUrl?: string;
}

export interface PostComment {
  handle: string;
  name: string;
  date: string;
  text: string;
  /**
   * Nombre de likes au moment de l'extraction. Base du tri par traction.
   * null/undefined = inconnu (cache v1 historique, ou fallback Grok muet).
   */
  likes?: number | null;
  /** Réponse écrite par l'auteur du post bookmarké. */
  isAuthor?: boolean;
  /** Réponse directe au thread (vs réponse-à-une-réponse). */
  isDirectReply?: boolean;
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
  /** Texte complet (thread entier joint par des sauts de ligne) — rétro-compat. */
  text: string;
  /**
   * Le thread tweet par tweet quand il a pu être reconstruit (cache v2).
   * `text` reste la version jointe pour les caches v1.
   */
  thread?: Array<{ id: string; text: string }>;
  media: PostMedia[];
  metrics: PostMetrics;
  comments: PostComment[];
}

export interface ExtractResult {
  ok: true;
  filename: string;
  absolutePath: string;
  source: "cache" | "grok" | "xapi" | "mcp";
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
