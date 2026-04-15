import type { GrokInsights, NotableLink, KeyReply } from "../types";
import { callResponses, extractText, stripJsonFences } from "./xai-responses";

const INSTRUCTIONS = `You are a content analyst. I give you an X post URL.

Use the x_search tool to read the post and its entire comment thread, including replies that may be older than 7 days.

Return a single JSON object with EXACTLY these fields:

{
  "author_additions": string | null,
  "notable_links": Array<{ "url": string, "context": string }>,
  "sentiment": string,
  "key_replies": Array<{ "handle": string, "quote": string, "why": string }>
}

Field specs:

- "author_additions": If the post author added substantive follow-up thoughts in their own reply-thread (clarifications, corrections, release updates, examples), synthesize them in 2-4 sentences. Return null if the author's replies don't add meaningful content.

- "notable_links": Every meaningful URL shared in the comments — GitHub repos, papers, documentation, blog posts, demos, related tools. EXCLUDE t.co redirects to the post itself and generic homepage links. "context" is a one-line description of what the link actually is (8-15 words).

- "sentiment": 2-3 sentences describing the overall reception. Is the community enthusiastic, skeptical, divided, debating a specific technical point? Call out substantive disagreement or major criticism if present.

- "key_replies": Up to 5 of the most insight-dense individual replies. "quote" is verbatim (under 280 chars, trim with "…" if needed). "why" is a one-line reason the reply matters (8-15 words). "handle" is the @username WITHOUT the leading @.

Rules:
- Return ONLY the JSON object, no prose, no markdown fences.
- English output regardless of the post's original language.
- Do not invent content. Empty arrays and null are acceptable.
- Focus on SUBSTANCE. Skip low-value reactions ("great post!", "🔥🔥").
- If the post cannot be read, return { "author_additions": "ERROR: <reason>", "notable_links": [], "sentiment": "", "key_replies": [] }`;

export interface GrokEnrichOptions {
  apiKey: string;
  model?: string;
}

export async function fetchGrokInsights(
  url: string,
  options: GrokEnrichOptions,
): Promise<GrokInsights> {
  const data = await callResponses({
    apiKey: options.apiKey,
    model: options.model ?? "grok-4",
    instructions: INSTRUCTIONS,
    input: `Analyze this X post and its comment thread: ${url}\n\nReturn ONLY the JSON object described in the instructions.`,
  });

  const text = extractText(data);
  if (!text) {
    throw new Error("Grok returned no output_text for insights");
  }

  const cleaned = stripJsonFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Grok returned invalid JSON: ${cleaned.slice(0, 500)}`);
  }

  return normalize(parsed);
}

function normalize(input: unknown): GrokInsights {
  const obj = (input ?? {}) as Record<string, unknown>;
  return {
    author_additions:
      typeof obj.author_additions === "string" && obj.author_additions.trim()
        ? obj.author_additions
        : null,
    notable_links: Array.isArray(obj.notable_links)
      ? obj.notable_links
          .map((l) => {
            const ll = (l ?? {}) as Record<string, unknown>;
            return {
              url: typeof ll.url === "string" ? ll.url : "",
              context: typeof ll.context === "string" ? ll.context : "",
            };
          })
          .filter((l: NotableLink) => l.url.length > 0)
      : [],
    sentiment: typeof obj.sentiment === "string" ? obj.sentiment : "",
    key_replies: Array.isArray(obj.key_replies)
      ? obj.key_replies
          .map((r) => {
            const rr = (r ?? {}) as Record<string, unknown>;
            return {
              handle:
                typeof rr.handle === "string"
                  ? rr.handle.replace(/^@/, "")
                  : "",
              quote: typeof rr.quote === "string" ? rr.quote : "",
              why: typeof rr.why === "string" ? rr.why : "",
            };
          })
          .filter((r: KeyReply) => r.quote.length > 0)
      : [],
  };
}
