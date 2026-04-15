/**
 * Shared helpers for the xAI (Grok) Responses API.
 * Used by grok-extract.ts (post extraction) and grok-enrich.ts (insights).
 */

export const XAI_RESPONSES_ENDPOINT = "https://api.x.ai/v1/responses";

export interface ResponsesPayload {
  output?: Array<{
    type?: string;
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  output_text?: string;
}

export interface CallResponsesOptions {
  apiKey: string;
  model: string;
  instructions: string;
  input: string;
  tools?: Array<{ type: string }>;
  temperature?: number;
}

/**
 * POST to the Responses API and return the parsed payload.
 * Throws with a trimmed body on non-2xx.
 */
/**
 * Max time we'll wait for a single Grok call. With the x_search tool,
 * Grok routinely takes 30–90 seconds reading a post + its full comment
 * thread. 120 s gives headroom for long threads and mild backpressure
 * without letting the server action hang forever on a stalled
 * upstream.
 */
const GROK_TIMEOUT_MS = 120_000;

export async function callResponses(
  options: CallResponsesOptions,
): Promise<ResponsesPayload> {
  const body = {
    model: options.model,
    instructions: options.instructions,
    input: options.input,
    tools: options.tools ?? [{ type: "x_search" }],
    temperature: options.temperature ?? 0,
    store: false,
  };

  let res: Response;
  try {
    res = await fetch(XAI_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GROK_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new Error(
        `Grok API timed out after ${Math.round(GROK_TIMEOUT_MS / 1000)}s`,
      );
    }
    throw e;
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Grok API ${res.status}: ${errText.slice(0, 500)}`);
  }

  return (await res.json()) as ResponsesPayload;
}

/**
 * Pull the text content out of a Responses API payload.
 * Prefers top-level output_text, falls back to concatenating all
 * output_text parts inside message items.
 */
export function extractText(payload: ResponsesPayload): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  const parts: string[] = [];
  for (const item of payload.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c.type === "output_text" && typeof c.text === "string") {
        parts.push(c.text);
      }
    }
  }
  return parts.join("\n").trim();
}

/**
 * Normalize a model's raw text output into a JSON string we can parse.
 * Handles ```json fences and falls back to the outermost {...} block.
 */
export function stripJsonFences(s: string): string {
  const trimmed = s.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}
