const URL_RE = /(?:x|twitter)\.com\/(?:#!\/)?(\w+)\/status(?:es)?\/(\d+)/i;

export interface ParsedTweetRef {
  id: string;
  handle: string;
  canonicalUrl: string;
}

export function parseTweetRef(input: string): ParsedTweetRef | null {
  const m = input.match(URL_RE);
  if (!m) return null;
  const [, handle, id] = m;
  return {
    id,
    handle,
    canonicalUrl: `https://x.com/${handle}/status/${id}`,
  };
}
