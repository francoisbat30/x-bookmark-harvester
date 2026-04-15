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

  const res = await fetch(XAI_RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(body),
  });

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
