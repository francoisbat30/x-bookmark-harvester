import type { PostExtraction } from "../types";
import { callResponses, extractText, stripJsonFences } from "./xai-responses";

const INSTRUCTIONS = `You are an extraction assistant. You receive a single X (Twitter) post URL.
Use the x_search tool to read the post (and any thread / notable replies it is part of).

You MUST return a single JSON object — no prose, no markdown fences, no commentary — matching this TypeScript shape:

{
  "url": string,
  "author": { "handle": string, "name": string },
  "date": string,
  "text": string,
  "media": Array<{ "type": "image" | "video" | "gif", "url": string }>,
  "metrics": { "likes": number, "retweets": number, "replies": number, "views": number },
  "comments": Array<{ "handle": string, "name": string, "date": string, "text": string }>
}

Rules:
- "handle" is the @username WITHOUT the leading @.
- "date" is ISO 8601 (YYYY-MM-DD) for the post and each comment.
- "text" is the FULL verbatim content. If the post is a thread by the author, concatenate every part in order, separated by two newlines.
- "media" lists every image/video attached to the post (and threads).
- "comments" contains only meaningful replies: top replies AND any reply authored by the original poster. Skip low-value chatter.
- Any missing metric = 0. Any missing field = empty string or empty array.
- Do not invent content. If the post cannot be read, return an object with "text" set to "ERROR: <reason>".
- Output MUST be a raw JSON object and nothing else.`;

export interface GrokClientOptions {
  apiKey: string;
  model?: string;
}

export async function extractPostWithGrok(
  url: string,
  options: GrokClientOptions,
): Promise<PostExtraction> {
  const data = await callResponses({
    apiKey: options.apiKey,
    model: options.model ?? "grok-4",
    instructions: INSTRUCTIONS,
    input: `Extract the X post at this URL: ${url}\n\nReturn ONLY the JSON object described in the instructions.`,
  });

  const text = extractText(data);
  if (!text) {
    throw new Error(
      `Grok returned no output_text. Raw payload: ${JSON.stringify(data).slice(0, 800)}`,
    );
  }

  const cleaned = stripJsonFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Grok returned invalid JSON: ${cleaned.slice(0, 500)}`);
  }

  return normalize(parsed, url);
}

function normalize(input: unknown, fallbackUrl: string): PostExtraction {
  const obj = (input ?? {}) as Record<string, unknown>;
  const author = (obj.author ?? {}) as Record<string, unknown>;
  const metrics = (obj.metrics ?? {}) as Record<string, unknown>;

  return {
    url: asString(obj.url) || fallbackUrl,
    author: {
      handle: asString(author.handle).replace(/^@/, ""),
      name: asString(author.name),
    },
    date: asString(obj.date),
    text: asString(obj.text),
    media: Array.isArray(obj.media)
      ? obj.media.map((m) => {
          const mm = (m ?? {}) as Record<string, unknown>;
          const type = asString(mm.type);
          return {
            type: (type === "video" || type === "gif" ? type : "image") as
              | "image"
              | "video"
              | "gif",
            url: asString(mm.url),
          };
        })
      : [],
    metrics: {
      likes: asNumber(metrics.likes),
      retweets: asNumber(metrics.retweets),
      replies: asNumber(metrics.replies),
      views: asNumber(metrics.views),
    },
    comments: Array.isArray(obj.comments)
      ? obj.comments.map((c) => {
          const cc = (c ?? {}) as Record<string, unknown>;
          return {
            handle: asString(cc.handle).replace(/^@/, ""),
            name: asString(cc.name),
            date: asString(cc.date),
            text: asString(cc.text),
          };
        })
      : [],
  };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[,_\s]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
